import { Prisma } from '@prisma/client';

/**
 * Serialize CRM relationship edits across contact/company/project APIs.
 * PostgreSQL releases this transaction-scoped lock on commit or rollback.
 */
export async function lockCrmRelationshipWrites(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw<Array<{ locked: number }>>(Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(7319041, 118207)`);
}
