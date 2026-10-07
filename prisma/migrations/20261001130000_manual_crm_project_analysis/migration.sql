ALTER TABLE "EmailMessage"
  ADD COLUMN "projectResolutionEvidence" JSONB,
  ADD COLUMN "projectAssignmentVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Company"
  ADD COLUMN "website" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Contact"
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ALTER COLUMN "status" SET DEFAULT 'confirmed';

CREATE TABLE "ProjectContact" (
  "projectId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectContact_pkey" PRIMARY KEY ("projectId", "contactId"),
  CONSTRAINT "ProjectContact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProjectContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ProjectContact_contactId_projectId_idx" ON "ProjectContact"("contactId", "projectId");
CREATE INDEX "ProjectContact_projectId_isPrimary_idx" ON "ProjectContact"("projectId", "isPrimary");
CREATE UNIQUE INDEX "ProjectContact_one_primary_per_project" ON "ProjectContact"("projectId") WHERE "isPrimary" = true;

CREATE TABLE "ProjectAnalysisJob" (
  "id" TEXT NOT NULL,
  "projectId" TEXT,
  "mailAccountId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "fromDate" TIMESTAMP(3),
  "throughDate" TIMESTAMP(3),
  "totalCandidateCount" INTEGER NOT NULL DEFAULT 0,
  "candidateCount" INTEGER NOT NULL DEFAULT 0,
  "candidateTruncated" BOOLEAN NOT NULL DEFAULT false,
  "contextTruncatedCount" INTEGER NOT NULL DEFAULT 0,
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "assignedCount" INTEGER NOT NULL DEFAULT 0,
  "nonProjectCount" INTEGER NOT NULL DEFAULT 0,
  "newOpportunityCount" INTEGER NOT NULL DEFAULT 0,
  "needsReviewCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "projectContextHash" TEXT NOT NULL,
  "summaryStatus" TEXT NOT NULL DEFAULT 'pending',
  "summaryErrorCode" TEXT,
  "summaryInputHash" TEXT,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectAnalysisJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectAnalysisJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProjectAnalysisJob_mailAccountId_fkey" FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProjectAnalysisJob_mailAccountId_operationId_key" ON "ProjectAnalysisJob"("mailAccountId", "operationId");
CREATE INDEX "ProjectAnalysisJob_status_nextAttemptAt_createdAt_idx" ON "ProjectAnalysisJob"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "ProjectAnalysisJob_projectId_createdAt_idx" ON "ProjectAnalysisJob"("projectId", "createdAt");

CREATE TABLE "ProjectAnalysisItem" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "sourceMessageId" TEXT,
  "sourceDeletedAt" TIMESTAMP(3),
  "assignmentVersion" INTEGER NOT NULL DEFAULT 1,
  "contextTruncated" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "outcome" TEXT,
  "chosenProjectId" TEXT,
  "candidateProjectIds" JSONB NOT NULL DEFAULT '[]',
  "evidenceJson" JSONB NOT NULL DEFAULT '[]',
  "reason" TEXT,
  "inputHash" TEXT,
  "contextHash" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastErrorCode" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "analyzedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectAnalysisItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectAnalysisItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProjectAnalysisJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectAnalysisItem_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ProjectAnalysisItem_chosenProjectId_fkey" FOREIGN KEY ("chosenProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProjectAnalysisItem_jobId_sourceMessageId_key" ON "ProjectAnalysisItem"("jobId", "sourceMessageId");
CREATE INDEX "ProjectAnalysisItem_status_nextAttemptAt_createdAt_idx" ON "ProjectAnalysisItem"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "ProjectAnalysisItem_sourceMessageId_createdAt_idx" ON "ProjectAnalysisItem"("sourceMessageId", "createdAt");
CREATE INDEX "ProjectAnalysisItem_chosenProjectId_createdAt_idx" ON "ProjectAnalysisItem"("chosenProjectId", "createdAt");

ALTER TABLE "Summary"
  ADD COLUMN "isDerived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manualOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "inputHash" TEXT,
  ADD COLUMN "coverageJson" JSONB;
ALTER TABLE "SummaryVersion"
  ADD COLUMN "isSuggestion" BOOLEAN NOT NULL DEFAULT false;

-- Existing summaries were only written through an explicit user apply action;
-- keep them protected until a user chooses a generated suggestion.
UPDATE "Summary" SET "manualOverride" = true;
