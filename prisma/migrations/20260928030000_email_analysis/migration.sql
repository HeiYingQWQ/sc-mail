CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "validationStatus" TEXT,
    "inputSummaryJson" JSONB NOT NULL,
    "resultJson" JSONB,
    "validationErrorsJson" JSONB,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnalysisRun_mailAccountId_requestKey_key" ON "AnalysisRun"("mailAccountId", "requestKey");
CREATE INDEX "AnalysisRun_sourceMessageId_createdAt_idx" ON "AnalysisRun"("sourceMessageId", "createdAt");
CREATE INDEX "AnalysisRun_status_createdAt_idx" ON "AnalysisRun"("status", "createdAt");

ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_mailAccountId_fkey"
    FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_sourceMessageId_fkey"
    FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
