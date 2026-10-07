CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "topicId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'action',
    "ownerType" TEXT,
    "ownerId" TEXT,
    "waitingOn" TEXT NOT NULL DEFAULT 'none',
    "version" INTEGER NOT NULL DEFAULT 1,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "deadlineAt" TIMESTAMP(3),
    "deadlineDate" TEXT,
    "deadlineTimezone" TEXT,
    "deadlineText" TEXT,
    "waitingSince" TIMESTAMP(3),
    "createdFromMessageId" TEXT,
    "completedFromMessageId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "createdBy" TEXT,
    "sourceOperationId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Requirement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "topicId" TEXT,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "version" INTEGER NOT NULL DEFAULT 1,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "sourceMessageId" TEXT,
    "createdBy" TEXT,
    "sourceOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Requirement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "topicId" TEXT,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "version" INTEGER NOT NULL DEFAULT 1,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "decidedByContactId" TEXT,
    "sourceMessageId" TEXT,
    "createdBy" TEXT,
    "sourceOperationId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessOperation" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "sourceOperationId" TEXT,
    "inputHash" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Task_sourceOperationId_key" ON "Task"("sourceOperationId");
CREATE INDEX "Task_projectId_status_deadlineAt_idx" ON "Task"("projectId", "status", "deadlineAt");
CREATE INDEX "Task_topicId_status_idx" ON "Task"("topicId", "status");
CREATE INDEX "Task_status_deadlineDate_idx" ON "Task"("status", "deadlineDate");
CREATE INDEX "Task_createdFromMessageId_idx" ON "Task"("createdFromMessageId");

CREATE UNIQUE INDEX "Requirement_sourceOperationId_key" ON "Requirement"("sourceOperationId");
CREATE INDEX "Requirement_projectId_status_idx" ON "Requirement"("projectId", "status");
CREATE INDEX "Requirement_topicId_status_idx" ON "Requirement"("topicId", "status");
CREATE INDEX "Requirement_sourceMessageId_idx" ON "Requirement"("sourceMessageId");

CREATE UNIQUE INDEX "Decision_sourceOperationId_key" ON "Decision"("sourceOperationId");
CREATE INDEX "Decision_projectId_status_idx" ON "Decision"("projectId", "status");
CREATE INDEX "Decision_topicId_status_idx" ON "Decision"("topicId", "status");
CREATE INDEX "Decision_sourceMessageId_idx" ON "Decision"("sourceMessageId");

CREATE UNIQUE INDEX "BusinessOperation_operationId_key" ON "BusinessOperation"("operationId");
CREATE UNIQUE INDEX "BusinessOperation_sourceOperationId_key" ON "BusinessOperation"("sourceOperationId");
CREATE INDEX "BusinessOperation_entityType_entityId_createdAt_idx" ON "BusinessOperation"("entityType", "entityId", "createdAt");
CREATE INDEX "BusinessOperation_sourceMessageId_createdAt_idx" ON "BusinessOperation"("sourceMessageId", "createdAt");

ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdFromMessageId_fkey" FOREIGN KEY ("createdFromMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_completedFromMessageId_fkey" FOREIGN KEY ("completedFromMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_decidedByContactId_fkey" FOREIGN KEY ("decidedByContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
