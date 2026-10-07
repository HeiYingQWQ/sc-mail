CREATE TABLE "ProcessingRecord" (
  "id" TEXT NOT NULL,
  "mailAccountId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "classification" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "confidence" DOUBLE PRECISION,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "analysisVersion" TEXT,
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "reviewId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProcessingRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProcessingRecord_sourceMessageId_key" ON "ProcessingRecord"("sourceMessageId");
CREATE UNIQUE INDEX "ProcessingRecord_mailAccountId_provider_providerMessageId_key" ON "ProcessingRecord"("mailAccountId", "provider", "providerMessageId");
CREATE INDEX "ProcessingRecord_mailAccountId_status_updatedAt_idx" ON "ProcessingRecord"("mailAccountId", "status", "updatedAt");
ALTER TABLE "ProcessingRecord" ADD CONSTRAINT "ProcessingRecord_mailAccountId_fkey" FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProcessingRecord" ADD CONSTRAINT "ProcessingRecord_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MailReconciliationCheckpoint" (
  "id" TEXT NOT NULL,
  "mailAccountId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'idle',
  "auditFrom" TIMESTAMP(3),
  "auditThrough" TIMESTAMP(3),
  "lastAuditStartedAt" TIMESTAMP(3),
  "lastAuditCompletedAt" TIMESTAMP(3),
  "mailboxCursors" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "scannedCount" INTEGER NOT NULL DEFAULT 0,
  "importedCount" INTEGER NOT NULL DEFAULT 0,
  "processingRecordsCreated" INTEGER NOT NULL DEFAULT 0,
  "crmRepaired" INTEGER NOT NULL DEFAULT 0,
  "needsReviewCount" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MailReconciliationCheckpoint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MailReconciliationCheckpoint_mailAccountId_key" ON "MailReconciliationCheckpoint"("mailAccountId");
CREATE INDEX "MailReconciliationCheckpoint_status_nextRunAt_idx" ON "MailReconciliationCheckpoint"("status", "nextRunAt");
ALTER TABLE "MailReconciliationCheckpoint" ADD CONSTRAINT "MailReconciliationCheckpoint_mailAccountId_fkey" FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
