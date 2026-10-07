CREATE TABLE "AgentWakeupDelivery" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "AgentWakeupDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentWakeupDelivery_eventId_key" ON "AgentWakeupDelivery"("eventId");
CREATE INDEX "AgentWakeupDelivery_status_nextAttemptAt_createdAt_idx" ON "AgentWakeupDelivery"("status", "nextAttemptAt", "createdAt");
ALTER TABLE "AgentWakeupDelivery" ADD CONSTRAINT "AgentWakeupDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AgentEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TelegramCursor" (
  "id" TEXT NOT NULL DEFAULT 'telegram',
  "nextUpdateId" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelegramCursor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TelegramInboxMessage" (
  "id" TEXT NOT NULL,
  "updateId" BIGINT NOT NULL,
  "chatId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "messageId" BIGINT NOT NULL,
  "text" TEXT NOT NULL,
  "responseText" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "TelegramInboxMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramInboxMessage_updateId_key" ON "TelegramInboxMessage"("updateId");
CREATE INDEX "TelegramInboxMessage_status_nextAttemptAt_createdAt_idx" ON "TelegramInboxMessage"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "TelegramInboxMessage_chatId_createdAt_idx" ON "TelegramInboxMessage"("chatId", "createdAt");

ALTER TABLE "NotificationDelivery" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

INSERT INTO "AgentWakeupDelivery" ("id", "eventId")
SELECT 'wakeup_' || substr(md5("id"), 1, 28), "id"
FROM "AgentEvent" WHERE "status" = 'pending'
ON CONFLICT ("eventId") DO NOTHING;
