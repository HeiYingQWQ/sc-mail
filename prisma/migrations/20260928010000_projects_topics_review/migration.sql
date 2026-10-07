CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'lead',
    "waitingOn" TEXT NOT NULL DEFAULT 'none',
    "replyRequired" BOOLEAN NOT NULL DEFAULT FALSE,
    "followUpAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "manualOverride" BOOLEAN NOT NULL DEFAULT FALSE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'custom',
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "proposedChangeJson" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolutionJson" JSONB,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "dedupeKeyBase" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EmailMessage"
    ADD COLUMN "projectId" TEXT,
    ADD COLUMN "topicId" TEXT,
    ADD COLUMN "projectResolutionStatus" TEXT NOT NULL DEFAULT 'unresolved',
    ADD COLUMN "projectConfidence" DOUBLE PRECISION,
    ADD COLUMN "projectReason" TEXT,
    ADD COLUMN "projectManualOverride" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "topicResolutionStatus" TEXT NOT NULL DEFAULT 'unresolved',
    ADD COLUMN "topicConfidence" DOUBLE PRECISION,
    ADD COLUMN "topicReason" TEXT,
    ADD COLUMN "topicManualOverride" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX "Topic_projectId_normalizedName_key" ON "Topic"("projectId", "normalizedName");
CREATE UNIQUE INDEX "ReviewItem_dedupeKey_key" ON "ReviewItem"("dedupeKey");
CREATE INDEX "ReviewItem_dedupeKeyBase_cycle_idx" ON "ReviewItem"("dedupeKeyBase", "cycle");
CREATE INDEX "Project_companyId_status_idx" ON "Project"("companyId", "status");
CREATE INDEX "Project_name_idx" ON "Project"("name");
CREATE INDEX "Topic_projectId_status_idx" ON "Topic"("projectId", "status");
CREATE INDEX "ReviewItem_status_createdAt_idx" ON "ReviewItem"("status", "createdAt");
CREATE INDEX "ReviewItem_entityType_entityId_status_idx" ON "ReviewItem"("entityType", "entityId", "status");
CREATE INDEX "ReviewItem_sourceMessageId_status_idx" ON "ReviewItem"("sourceMessageId", "status");
CREATE INDEX "EmailMessage_projectId_receivedAt_idx" ON "EmailMessage"("projectId", "receivedAt");
CREATE INDEX "EmailMessage_topicId_receivedAt_idx" ON "EmailMessage"("topicId", "receivedAt");
CREATE INDEX "EmailMessage_mailAccountId_direction_classification_projectResolutionStatus_idx"
    ON "EmailMessage"("mailAccountId", "direction", "classification", "projectResolutionStatus");

ALTER TABLE "Project" ADD CONSTRAINT "Project_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_topicId_fkey"
    FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_sourceMessageId_fkey"
    FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
