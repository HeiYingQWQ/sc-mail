import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';

type OperationClient = Prisma.TransactionClient | PrismaService;

type MutationResult<T> = {
  entityId: string;
  value: T;
  before?: unknown;
  after?: unknown;
};

type MutationInput<T> = {
  operationId?: unknown;
  actorId?: unknown;
  entityType: string;
  action: string;
  input: unknown;
  execute(tx: Prisma.TransactionClient): Promise<MutationResult<T>>;
  load(client: OperationClient, entityId: string): Promise<T>;
  loadReplay?(client: OperationClient, operation: { entityId: string; afterJson: Prisma.JsonValue | null }): Promise<T>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function isConcurrentWriteError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'P2034') return true;
  if (code !== 'P2010' || !error || typeof error !== 'object' || !('meta' in error)) return false;
  const meta = error.meta;
  // Prisma wraps errors from SELECT ... FOR UPDATE as raw-query failures.
  // Only PostgreSQL serialization/deadlock failures are retryable conflicts.
  return Boolean(meta && typeof meta === 'object' && 'code' in meta &&
    (meta.code === '40001' || meta.code === '40P01'));
}

function assertReplay(existing: { inputHash: string; entityType: string; action: string }, expected: { inputHash: string; entityType: string; action: string }) {
  if (existing.inputHash !== expected.inputHash || existing.entityType !== expected.entityType || existing.action !== expected.action) {
    throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
  }
}

export async function executeAuditedMutation<T>(prisma: PrismaService, input: MutationInput<T>): Promise<T> {
  const operationId = typeof input.operationId === 'string' && input.operationId.trim()
    ? input.operationId.trim().slice(0, 200)
    : randomUUID();
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim().slice(0, 160)
    : 'api-token-client';
  const expected = {
    inputHash: createHash('sha256').update(stable({ entityType: input.entityType, action: input.action, actorId, input: input.input })).digest('hex'),
    entityType: input.entityType,
    action: input.action,
  };

  const replay = async (client: OperationClient) => {
    const existing = await client.businessOperation.findUnique({ where: { operationId } });
    if (!existing) return null;
    assertReplay(existing, expected);
    return input.loadReplay ? input.loadReplay(client, existing) : input.load(client, existing.entityId);
  };

  const prior = await replay(prisma);
  if (prior !== null) return prior;

  try {
    return await prisma.$transaction(async (tx) => {
      const raced = await replay(tx);
      if (raced !== null) return raced;

      const result = await input.execute(tx);
      await tx.businessOperation.create({
        data: {
          operationId,
          sourceOperationId: operationId,
          inputHash: expected.inputHash,
          entityType: input.entityType,
          entityId: result.entityId,
          action: input.action,
          actorId,
          beforeJson: result.before === undefined || result.before === null ? Prisma.JsonNull : asJson(result.before),
          afterJson: asJson(result.after === undefined ? result.value : result.after),
        },
      });
      return result.value;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isConcurrentWriteError(error)) throw new ConflictException({ code: 'CONCURRENT_UPDATE', message: 'Concurrent update detected; reload and retry' });
    if (errorCode(error) === 'P2002') {
      const raced = await replay(prisma);
      if (raced !== null) return raced;
    }
    throw error;
  }
}
