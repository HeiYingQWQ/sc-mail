CREATE TABLE "EmailImportanceTriage" (
    "id" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'realtime',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "importance" TEXT,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "evidenceJson" JSONB NOT NULL DEFAULT '[]',
    "provider" TEXT,
    "model" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailImportanceTriage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailImportanceTriage_sourceMessageId_key" ON "EmailImportanceTriage"("sourceMessageId");
CREATE INDEX "EmailImportanceTriage_status_nextAttemptAt_createdAt_idx" ON "EmailImportanceTriage"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "EmailImportanceTriage_mailAccountId_status_updatedAt_idx" ON "EmailImportanceTriage"("mailAccountId", "status", "updatedAt");
CREATE INDEX "EmailImportanceTriage_importance_createdAt_idx" ON "EmailImportanceTriage"("importance", "createdAt");

ALTER TABLE "EmailImportanceTriage" ADD CONSTRAINT "EmailImportanceTriage_mailAccountId_fkey"
FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailImportanceTriage" ADD CONSTRAINT "EmailImportanceTriage_sourceMessageId_fkey"
FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
