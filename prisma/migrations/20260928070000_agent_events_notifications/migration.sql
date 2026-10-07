CREATE TABLE "AgentEvent" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "payloadJson" JSONB NOT NULL,
  "notificationPolicy" TEXT NOT NULL DEFAULT 'NEVER',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "assignedAgent" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 8,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "resultJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentEvent_eventKey_key" ON "AgentEvent"("eventKey");
CREATE INDEX "AgentEvent_status_nextAttemptAt_priority_createdAt_idx" ON "AgentEvent"("status", "nextAttemptAt", "priority", "createdAt");
CREATE INDEX "AgentEvent_entityType_entityId_createdAt_idx" ON "AgentEvent"("entityType", "entityId", "createdAt");

CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "eventId" TEXT,
  "channel" TEXT NOT NULL,
  "recipientRef" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "providerDeliveryId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationDelivery_requestKey_key" ON "NotificationDelivery"("requestKey");
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");
CREATE INDEX "NotificationDelivery_eventId_createdAt_idx" ON "NotificationDelivery"("eventId", "createdAt");
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AgentEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
