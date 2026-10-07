CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "uid" INTEGER NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "rfcMessageId" TEXT,
    "threadId" TEXT,
    "direction" TEXT NOT NULL,
    "fromJson" JSONB NOT NULL,
    "toJson" JSONB NOT NULL,
    "ccJson" JSONB NOT NULL,
    "bccJson" JSONB NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "headersJson" JSONB NOT NULL,
    "rawSource" BYTEA NOT NULL,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailMessage_mailAccountId_fkey" FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "SyncCheckpoint" (
    "id" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "uidValidity" BIGINT,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "throughDate" TIMESTAMP(3) NOT NULL,
    "lastUid" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scannedCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "SyncCheckpoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SyncCheckpoint_mailAccountId_fkey" FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmailMessage_mailAccountId_providerMessageId_key" ON "EmailMessage"("mailAccountId", "providerMessageId");
CREATE UNIQUE INDEX "EmailMessage_mailAccountId_mailbox_uidValidity_uid_key" ON "EmailMessage"("mailAccountId", "mailbox", "uidValidity", "uid");
CREATE INDEX "EmailMessage_mailAccountId_threadId_idx" ON "EmailMessage"("mailAccountId", "threadId");
CREATE INDEX "EmailMessage_mailAccountId_receivedAt_idx" ON "EmailMessage"("mailAccountId", "receivedAt");
CREATE INDEX "EmailMessage_mailAccountId_mailbox_rfcMessageId_idx" ON "EmailMessage"("mailAccountId", "mailbox", "rfcMessageId");
CREATE UNIQUE INDEX "SyncCheckpoint_mailAccountId_mailbox_key" ON "SyncCheckpoint"("mailAccountId", "mailbox");
CREATE INDEX "SyncCheckpoint_mailAccountId_status_idx" ON "SyncCheckpoint"("mailAccountId", "status");
