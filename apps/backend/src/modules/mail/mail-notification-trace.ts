import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GATE_CLASSES, senderRuleSnapshotAction } from './business-gate.rules';
import { canonicalMessageId } from './email-thread';

const RECENT_LIMIT = 5;
const ROUTE_REASONS = ['sender_whitelist', 'active_project_update', 'actionable_intent'];
const FILTERED_CLASSES = new Set<string>(GATE_CLASSES.filter((value) => value !== 'BUSINESS_HUMAN' && value !== 'UNKNOWN'));
const ERROR_CODES = new Set([
  'SYSTEM_SENDER_SUPPRESSED', 'NOTIFICATION_TARGET_NOT_ALLOWED', 'WHATSAPP_RECIPIENT_INVALID',
  'OPENCLAW_WHATSAPP_DELIVERY_UNCONFIRMED', 'OPENCLAW_WHATSAPP_DELIVERY_OUTCOME_UNKNOWN',
  'TRIAGE_LEASE_EXPIRED_RETRY', 'TRIAGE_LEASE_EXPIRED_MAX_ATTEMPTS', 'TRIAGE_SYSTEM_SENDER_SUPPRESSED',
  'TRIAGE_MANUAL_CLASSIFICATION_OVERRIDE', 'TRIAGE_RECEIVED_DATE_UNKNOWN', 'TRIAGE_OUTPUT_SCHEMA_INVALID',
  'TRIAGE_EVIDENCE_NOT_VERIFIABLE', 'TRIAGE_SOURCE_NO_LONGER_INBOUND', 'TRIAGE_CLASSIFICATION_REQUIRES_REVIEW',
  'TRIAGE_CLASSIFICATION_CHANGED_TO_NOISE', 'AI_TRIAGE_FAILED', 'AI_NOT_CONFIGURED', 'AI_TIMEOUT', 'AI_NETWORK_ERROR',
  'AI_RATE_LIMITED', 'AI_UPSTREAM_UNAVAILABLE', 'AI_UPSTREAM_REJECTED', 'AI_INVALID_JSON', 'AI_INVALID_RESPONSE',
  'AI_INCOMPLETE_RESPONSE', 'AI_EMPTY_RESPONSE', 'AI_CONTEXT_LIMIT_EXCEEDED', 'AI_CONTEXT_LIMIT_TOO_SMALL',
]);

function errorCode(value: string | null) {
  if (!value) return null;
  if (ERROR_CODES.has(value) || /^OPENCLAW_HTTP_[1-5]\d\d$/.test(value)) return value;
  return 'DETAIL_UNAVAILABLE';
}

function safeEvidence(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 5).map((item) => item.slice(0, 300))
    : [];
}

function record(value: Prisma.JsonValue) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function routingHint(
  message: { direction: string; historicalImport: boolean; classification: string; reviewRequired: boolean },
  senderRule: ReturnType<typeof senderRuleSnapshotAction>,
  triageStatus: string | undefined,
  hasEvent: boolean,
) {
  if (hasEvent) return 'event_recorded';
  if (message.direction !== 'inbound') return 'not_inbound';
  if (message.historicalImport) return 'historical_import';
  if (senderRule === 'blacklist') return 'sender_blacklist';
  if (FILTERED_CLASSES.has(message.classification)) return 'filtered_classification';
  if (message.reviewRequired || message.classification === 'UNKNOWN') return 'classification_review';
  if (triageStatus === 'quiet') return 'triage_quiet';
  if (triageStatus === 'review') return 'triage_review';
  if (triageStatus === 'pending' || triageStatus === 'processing') return 'triage_waiting';
  if (triageStatus === 'failed') return 'triage_failed';
  return 'not_recorded';
}

export async function readMailNotificationTrace(tx: Prisma.TransactionClient, mailAccountId: string, messageId: string) {
  const message = await tx.emailMessage.findFirst({
    where: { id: messageId, mailAccountId },
    select: {
      id: true, mailAccountId: true, rfcMessageId: true, direction: true, historicalImport: true,
      classification: true, classificationReason: true, classificationEvidence: true, classificationManualOverride: true,
      reviewRequired: true, senderRuleSnapshot: true,
    },
  });
  if (!message) throw new NotFoundException({ code: 'MAIL_MESSAGE_NOT_FOUND' });
  const canonicalId = await canonicalMessageId(tx, message);
  const sourceIds = [message.id, canonicalId];
  const [triages, events] = await Promise.all([
    tx.emailImportanceTriage.findMany({
      where: { mailAccountId, sourceMessageId: { in: sourceIds } },
      select: { sourceMessageId: true, status: true, importance: true, intent: true, confidence: true, reason: true, evidenceJson: true, analyzedAt: true, lastErrorCode: true },
    }),
    tx.agentEvent.findMany({
      where: { entityType: 'email_message', entityId: { in: sourceIds }, eventType: 'INBOUND_EMAIL_RECEIVED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_LIMIT + 1,
      select: {
        entityId: true, status: true, createdAt: true, processedAt: true, lastError: true, payloadJson: true, resultJson: true,
        wakeupDelivery: { select: { status: true, deliveredAt: true, lastError: true } },
        notifications: {
          where: { channel: 'whatsapp' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: RECENT_LIMIT + 1,
          select: { status: true, createdAt: true, deliveredAt: true, lastError: true },
        },
      },
    }),
  ]);
  const triage = triages.find((row) => row.sourceMessageId === message.id) ?? triages[0];
  const senderRule = senderRuleSnapshotAction(message.senderRuleSnapshot);
  return {
    messageId, readAt: new Date(),
    classification: {
      value: message.classification, reason: message.classificationReason?.slice(0, 1000) ?? null,
      evidence: safeEvidence(message.classificationEvidence), manuallySet: message.classificationManualOverride,
      reviewRequired: message.reviewRequired,
    },
    senderRule,
    routingHint: routingHint(message, senderRule, triage?.status, events.length > 0),
    triage: triage ? {
      status: triage.status, importance: triage.importance, intent: triage.intent, confidence: triage.confidence,
      reason: triage.reason?.slice(0, 1000) ?? null, evidence: safeEvidence(triage.evidenceJson), analyzedAt: triage.analyzedAt,
      errorCode: errorCode(triage.lastErrorCode), fromCanonicalCopy: triage.sourceMessageId !== message.id,
    } : null,
    events: events.slice(0, RECENT_LIMIT).map((event) => {
      const payload = record(event.payloadJson);
      const result = record(event.resultJson);
      const reasons = Array.isArray(payload.notificationReasons) ? payload.notificationReasons : [];
      const wakeup = event.wakeupDelivery;
      return {
        status: event.status, createdAt: event.createdAt, processedAt: event.processedAt, errorCode: errorCode(event.lastError),
        fromCanonicalCopy: event.entityId !== message.id,
        reasons: ROUTE_REASONS.filter((reason) => reasons.includes(reason)),
        projectRouteStale: payload.projectProjectRouteStale === true,
        actionable: typeof result.actionable === 'boolean' ? result.actionable : null,
        wakeup: wakeup ? { status: wakeup.status, deliveredAt: wakeup.deliveredAt, errorCode: errorCode(wakeup.lastError) } : null,
        deliveries: event.notifications.slice(0, RECENT_LIMIT).map(({ status, createdAt, deliveredAt, lastError }) => ({
          status, createdAt, deliveredAt, errorCode: errorCode(lastError),
        })),
        deliveriesTruncated: event.notifications.length > RECENT_LIMIT,
      };
    }),
    eventsTruncated: events.length > RECENT_LIMIT,
  };
}
