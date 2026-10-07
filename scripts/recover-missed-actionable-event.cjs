#!/usr/bin/env node
/* Requeue one legacy actionable human-mail event completed without a notification. */
const { createHash } = require('node:crypto');

const ACTION = 'recover_missing_actionable_notification';
const ENTITY_TYPE = 'agent_event';

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let eventId, operationId, apply = false, help = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--event-id' && args[i + 1]) eventId = args[++i];
    else if (args[i] === '--operation-id' && args[i + 1]) operationId = args[++i];
    else if (args[i] === '--apply') apply = true;
    else if (args[i] === '--help') help = true;
    else throw new Error('INVALID_ARGUMENTS');
  }
  if (help) return { help: true };
  if (!eventId || !/^[A-Za-z0-9_-]{8,100}$/.test(eventId)) throw new Error('EVENT_ID_REQUIRED');
  if (!operationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(operationId)) throw new Error('OPERATION_ID_REQUIRED');
  return { eventId, operationId, apply, help: false };
}

function operationHash(eventId) {
  return createHash('sha256').update(JSON.stringify({ entityType: ENTITY_TYPE, action: ACTION, eventId })).digest('hex');
}

function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

function isSameOperation(operation, eventId) {
  return operation && operation.entityType === ENTITY_TYPE && operation.action === ACTION &&
    operation.entityId === eventId && operation.inputHash === operationHash(eventId);
}

async function eligibility(tx, eventId, senderRuleSnapshotAction) {
  const event = await tx.agentEvent.findUnique({ where: { id: eventId } });
  if (!event || event.status !== 'completed' || event.eventType !== 'INBOUND_EMAIL_RECEIVED' ||
    event.entityType !== 'email_message' || event.notificationPolicy !== 'REALTIME' ||
    !isObject(event.payloadJson) || event.payloadJson.sourceMessageId !== event.entityId ||
    event.payloadJson.classification !== 'BUSINESS_HUMAN' ||
    !['high', 'urgent'].includes(event.payloadJson.importance) ||
    !isObject(event.resultJson) || event.resultJson.actionable !== true) return null;

  const [message, triage, deliveries] = await Promise.all([
    tx.emailMessage.findUnique({ where: { id: event.entityId }, select: {
      id: true, direction: true, classification: true, senderRuleSnapshot: true,
    } }),
    tx.emailImportanceTriage.findUnique({ where: { sourceMessageId: event.entityId }, select: {
      status: true, importance: true,
    } }),
    tx.notificationDelivery.count({ where: { eventId } }),
  ]);
  if (!message || message.direction !== 'inbound' || message.classification !== 'BUSINESS_HUMAN' ||
    senderRuleSnapshotAction(message.senderRuleSnapshot) === 'blacklist' ||
    !triage || !['high', 'urgent'].includes(triage.status) || !['high', 'urgent'].includes(triage.importance) ||
    deliveries !== 0) return null;
  return event;
}

async function recoverEvent(db, senderRuleSnapshotAction, Prisma, { eventId, operationId, apply }) {
  const existing = await db.businessOperation.findUnique({ where: { operationId } });
  if (existing) {
    if (!isSameOperation(existing, eventId)) throw new Error('OPERATION_ID_REUSED');
    return { eligible: 0, requeued: 0, replayed: 1 };
  }
  if (!apply) {
    const event = await eligibility(db, eventId, senderRuleSnapshotAction);
    return { eligible: event ? 1 : 0, requeued: 0, replayed: 0 };
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AgentEvent" WHERE "id" = ${eventId} FOR UPDATE`;
    const raced = await tx.businessOperation.findUnique({ where: { operationId } });
    if (raced) {
      if (!isSameOperation(raced, eventId)) throw new Error('OPERATION_ID_REUSED');
      return { eligible: 0, requeued: 0, replayed: 1 };
    }
    const event = await eligibility(tx, eventId, senderRuleSnapshotAction);
    if (!event) throw new Error('EVENT_NOT_ELIGIBLE');
    const now = new Date();
    await tx.$queryRaw`SELECT "id" FROM "AgentWakeupDelivery" WHERE "eventId" = ${eventId} FOR UPDATE`;
    const wakeup = await tx.agentWakeupDelivery.findUnique({ where: { eventId }, select: { status: true, leaseExpiresAt: true } });
    if (wakeup?.status === 'sending' && wakeup.leaseExpiresAt && wakeup.leaseExpiresAt > now) throw new Error('WAKEUP_ACTIVE');
    const changed = await tx.agentEvent.updateMany({
      where: { id: eventId, status: 'completed', eventType: 'INBOUND_EMAIL_RECEIVED', resultJson: { path: ['actionable'], equals: true } },
      data: {
        status: 'pending', assignedAgent: null, leaseToken: null, leaseExpiresAt: null,
        attempts: 0, nextAttemptAt: now, lastError: null, resultJson: Prisma.DbNull, processedAt: null,
      },
    });
    if (changed.count !== 1) throw new Error('CONCURRENT_UPDATE');
    await tx.agentWakeupDelivery.upsert({
      where: { eventId },
      create: { eventId, status: 'pending', nextAttemptAt: now },
      update: { status: 'pending', attempts: 0, leaseToken: null, leaseExpiresAt: null,
        nextAttemptAt: now, lastError: null, deliveredAt: null },
    });
    await tx.businessOperation.create({ data: {
      operationId, sourceOperationId: operationId, inputHash: operationHash(eventId),
      entityType: ENTITY_TYPE, entityId: eventId, action: ACTION, actorId: 'maintenance-script',
      sourceMessageId: event.entityId,
      beforeJson: { status: 'completed', actionable: true, notificationDeliveryCount: 0 },
      afterJson: { status: 'pending', wakeupStatus: 'pending', notificationDeliveryCount: 0 },
    } });
    return { eligible: 1, requeued: 1, replayed: 0 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/recover-missed-actionable-event.cjs --event-id ID --operation-id ID [--apply]\nDefault is dry-run. --apply requeues only a strictly eligible completed event.\n');
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const { PrismaClient, Prisma } = require('@prisma/client');
  const { senderRuleSnapshotAction } = require('../dist/modules/mail/business-gate.rules.js');
  const db = new PrismaClient();
  try {
    const result = await recoverEvent(db, senderRuleSnapshotAction, Prisma, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const known = /^(INVALID_ARGUMENTS|EVENT_ID_REQUIRED|OPERATION_ID_REQUIRED|DATABASE_URL_REQUIRED|OPERATION_ID_REUSED|EVENT_NOT_ELIGIBLE|WAKEUP_ACTIVE|CONCURRENT_UPDATE)$/;
    process.stderr.write(`${error instanceof Error && known.test(error.message) ? error.message : 'RECOVERY_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, eligibility, recoverEvent };
