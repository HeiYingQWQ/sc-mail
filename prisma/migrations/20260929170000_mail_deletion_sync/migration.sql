CREATE TABLE "MailDeletionTombstone" (
    "id" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "uid" INTEGER NOT NULL,
    "messageId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MailDeletionTombstone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MailDeletionTombstone_mailAccountId_mailbox_uidValidity_uid_key"
ON "MailDeletionTombstone"("mailAccountId", "mailbox", "uidValidity", "uid");
CREATE INDEX "MailDeletionTombstone_messageId_idx" ON "MailDeletionTombstone"("messageId");
ALTER TABLE "MailDeletionTombstone" ADD CONSTRAINT "MailDeletionTombstone_mailAccountId_fkey"
FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MailDeletionSyncCheckpoint" (
    "id" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "lastCompletedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastErrorCode" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "scannedCount" INTEGER NOT NULL DEFAULT 0,
    "deletedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MailDeletionSyncCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MailDeletionSyncCheckpoint_mailAccountId_key" ON "MailDeletionSyncCheckpoint"("mailAccountId");
CREATE INDEX "MailDeletionSyncCheckpoint_status_nextRunAt_idx" ON "MailDeletionSyncCheckpoint"("status", "nextRunAt");
ALTER TABLE "MailDeletionSyncCheckpoint" ADD CONSTRAINT "MailDeletionSyncCheckpoint_mailAccountId_fkey"
FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReviewItem" ADD COLUMN "sourceDeletedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "createdSourceDeletedAt" TIMESTAMP(3), ADD COLUMN "completedSourceDeletedAt" TIMESTAMP(3);
ALTER TABLE "Requirement" ADD COLUMN "sourceDeletedAt" TIMESTAMP(3);
ALTER TABLE "Decision" ADD COLUMN "sourceDeletedAt" TIMESTAMP(3);
ALTER TABLE "SummaryVersion" ADD COLUMN "sourceDeletedAt" TIMESTAMP(3);
ALTER TABLE "TimelineEvent" ADD COLUMN "sourceDeletedAt" TIMESTAMP(3);
