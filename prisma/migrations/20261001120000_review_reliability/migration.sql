ALTER TABLE "EmailMessage" ADD COLUMN "historicalImport" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AnalysisRun" ADD COLUMN "leaseToken" TEXT, ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
-- Legacy processing attempts have no owner/lease and must be retried explicitly.
UPDATE "AnalysisRun" SET "status" = 'failed', "validationStatus" = 'invalid', "errorCode" = 'AI_ANALYSIS_INTERRUPTED', "completedAt" = CURRENT_TIMESTAMP WHERE "status" = 'processing';

-- Preserve initial-import silence for legacy rows for which the completed initial checkpoint
-- establishes provenance. Rows without such evidence remain eligible for missed-mail recovery.
UPDATE "EmailMessage" e SET "historicalImport" = true
FROM "SyncCheckpoint" c
WHERE e."mailAccountId" = c."mailAccountId" AND e."mailbox" = c."mailbox"
  AND c."completedAt" IS NOT NULL AND e."createdAt" <= c."completedAt"
  AND e."senderRuleSnapshot" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "EmailImportanceTriage" t WHERE t."sourceMessageId"=e."id" AND t."source"='realtime');

CREATE INDEX "EmailMessage_mailAccountId_rfcMessageId_idx" ON "EmailMessage"("mailAccountId", "rfcMessageId");

-- Keep false historical catch-up notifications as audit rows, but prevent pending sends.
UPDATE "EmailImportanceTriage" t SET "status"='quiet', "importance"='low',
  "reason"='Initial historical import remains silent during recovery.',
  "leaseToken"=NULL, "leaseExpiresAt"=NULL
FROM "EmailMessage" e WHERE t."sourceMessageId"=e."id" AND e."historicalImport" AND t."source"<>'realtime'
  AND t."status" IN ('pending','processing','high','urgent');
UPDATE "AgentEvent" a SET "status"='ignored', "leaseToken"=NULL, "leaseExpiresAt"=NULL,
  "assignedAgent"=NULL, "lastError"='HISTORICAL_IMPORT_NOTIFICATION_WITHHELD'
FROM "EmailMessage" e WHERE a."entityId"=e."id" AND e."historicalImport"
  AND a."entityType"='email_message' AND a."eventType"='INBOUND_EMAIL_RECEIVED'
  AND a."status" IN ('pending','processing');
UPDATE "AgentWakeupDelivery" w SET "status"='failed', "leaseToken"=NULL, "leaseExpiresAt"=NULL,
  "lastError"='HISTORICAL_IMPORT_NOTIFICATION_WITHHELD'
FROM "AgentEvent" a JOIN "EmailMessage" e ON e."id"=a."entityId"
WHERE w."eventId"=a."id" AND e."historicalImport" AND a."entityType"='email_message'
  AND a."eventType"='INBOUND_EMAIL_RECEIVED' AND w."status" IN ('pending','sending');
UPDATE "NotificationDelivery" n SET "status"='failed', "leaseToken"=NULL, "leaseExpiresAt"=NULL,
  "lastError"='HISTORICAL_IMPORT_NOTIFICATION_WITHHELD'
FROM "AgentEvent" a JOIN "EmailMessage" e ON e."id"=a."entityId"
WHERE n."eventId"=a."id" AND e."historicalImport" AND a."entityType"='email_message'
  AND a."eventType"='INBOUND_EMAIL_RECEIVED' AND n."status" IN ('pending','sending');
