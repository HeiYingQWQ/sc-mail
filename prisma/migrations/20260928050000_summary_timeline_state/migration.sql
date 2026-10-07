ALTER TABLE "Project" ADD COLUMN "waitingParties" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "Summary" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Summary_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SummaryVersion" (
    "id" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previousSummary" TEXT,
    "newSummary" TEXT NOT NULL,
    "triggerMessageId" TEXT,
    "model" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SummaryVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TimelineEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "topicId" TEXT,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceMessageId" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Summary_entityType_entityId_key" ON "Summary"("entityType", "entityId");
CREATE INDEX "Summary_updatedAt_idx" ON "Summary"("updatedAt");
CREATE UNIQUE INDEX "SummaryVersion_summaryId_version_key" ON "SummaryVersion"("summaryId", "version");
CREATE INDEX "SummaryVersion_triggerMessageId_createdAt_idx" ON "SummaryVersion"("triggerMessageId", "createdAt");
CREATE INDEX "TimelineEvent_projectId_createdAt_idx" ON "TimelineEvent"("projectId", "createdAt");
CREATE INDEX "TimelineEvent_topicId_createdAt_idx" ON "TimelineEvent"("topicId", "createdAt");
CREATE INDEX "TimelineEvent_sourceMessageId_createdAt_idx" ON "TimelineEvent"("sourceMessageId", "createdAt");

ALTER TABLE "SummaryVersion" ADD CONSTRAINT "SummaryVersion_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "Summary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SummaryVersion" ADD CONSTRAINT "SummaryVersion_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
