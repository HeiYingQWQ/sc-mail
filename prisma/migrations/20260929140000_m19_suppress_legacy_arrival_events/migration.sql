-- Rollout prerequisite: stop the old worker before applying this migration, then start
-- the new version only after migrate deploy succeeds. This prevents a worker holding
-- an already-leased legacy webhook from racing the suppression transaction.
BEGIN;

-- Preserve any uncompleted legacy mail candidate as a visible manual review row.
INSERT INTO "EmailImportanceTriage" (
  "id", "mailAccountId", "sourceMessageId", "source", "status", "importance", "confidence",
  "reason", "evidenceJson", "attempts", "maxAttempts", "nextAttemptAt", "lastErrorCode",
  "schemaVersion", "createdAt", "updatedAt"
)
SELECT
  'm19-legacy-' || md5(message."id"), message."mailAccountId", message."id",
  'legacy_event_suppressed', 'review', 'uncertain', NULL,
  'An unfinished legacy mail-arrival event was suppressed during rollout to prevent duplicate wakeups. Review and retry explicitly if still useful.',
  '[]'::jsonb, 0, 3, CURRENT_TIMESTAMP, 'LEGACY_ARRIVAL_EVENT_SUPPRESSED', '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "AgentEvent" event
JOIN "EmailMessage" message ON message."id" = event."entityId"
WHERE event."eventKey" LIKE 'mail-arrival:%'
  AND event."eventType" = 'INBOUND_EMAIL_RECEIVED'
  AND event."entityType" = 'email_message'
  AND event."status" IN ('pending', 'processing')
  AND message."direction" = 'inbound'
ON CONFLICT ("sourceMessageId") DO NOTHING;

-- Existing M19 rows are moved to review as well, so the new worker cannot auto-create
-- a second event for an email whose legacy event is being suppressed.
UPDATE "EmailImportanceTriage" triage
SET "status" = 'review', "importance" = 'uncertain', "confidence" = NULL,
    "reason" = 'An unfinished legacy mail-arrival event was suppressed during rollout to prevent duplicate wakeups. Review and retry explicitly if still useful.',
    "evidenceJson" = '[]'::jsonb, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
    "nextAttemptAt" = CURRENT_TIMESTAMP, "lastErrorCode" = 'LEGACY_ARRIVAL_EVENT_SUPPRESSED',
    "analyzedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE triage."sourceMessageId" IN (
  SELECT event."entityId" FROM "AgentEvent" event
  WHERE event."eventKey" LIKE 'mail-arrival:%'
    AND event."eventType" = 'INBOUND_EMAIL_RECEIVED'
    AND event."entityType" = 'email_message'
    AND event."status" IN ('pending', 'processing')
);

UPDATE "NotificationDelivery" delivery
SET "status" = 'failed', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
    "lastError" = 'LEGACY_ARRIVAL_EVENT_SUPPRESSED', "deliveredAt" = NULL
WHERE delivery."status" IN ('pending', 'sending')
  AND delivery."eventId" IN (
    SELECT event."id" FROM "AgentEvent" event
    WHERE event."eventKey" LIKE 'mail-arrival:%'
      AND event."eventType" = 'INBOUND_EMAIL_RECEIVED'
      AND event."entityType" = 'email_message'
      AND event."status" IN ('pending', 'processing')
  );

UPDATE "AgentWakeupDelivery" wakeup
SET "status" = 'failed', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
    "lastError" = 'LEGACY_ARRIVAL_EVENT_SUPPRESSED', "deliveredAt" = NULL
WHERE wakeup."eventId" IN (
  SELECT event."id" FROM "AgentEvent" event
  WHERE event."eventKey" LIKE 'mail-arrival:%'
    AND event."eventType" = 'INBOUND_EMAIL_RECEIVED'
      AND event."entityType" = 'email_message'
    AND event."status" IN ('pending', 'processing')
);

UPDATE "AgentEvent"
SET "status" = 'ignored', "assignedAgent" = NULL, "leaseToken" = NULL,
    "leaseExpiresAt" = NULL, "lastError" = 'LEGACY_ARRIVAL_EVENT_SUPPRESSED',
    "processedAt" = CURRENT_TIMESTAMP
WHERE "eventKey" LIKE 'mail-arrival:%'
  AND "eventType" = 'INBOUND_EMAIL_RECEIVED'
  AND "entityType" = 'email_message'
  AND "status" IN ('pending', 'processing');

COMMIT;
