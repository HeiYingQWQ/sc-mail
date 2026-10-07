CREATE TABLE "TaskEvidence" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskEvidence_taskId_sourceMessageId_evidenceType_key" ON "TaskEvidence"("taskId", "sourceMessageId", "evidenceType");
CREATE INDEX "TaskEvidence_sourceMessageId_createdAt_idx" ON "TaskEvidence"("sourceMessageId", "createdAt");

ALTER TABLE "TaskEvidence" ADD CONSTRAINT "TaskEvidence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskEvidence" ADD CONSTRAINT "TaskEvidence_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "EmailMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
