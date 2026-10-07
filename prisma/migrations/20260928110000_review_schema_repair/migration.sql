ALTER TABLE "ReviewItem"
    ADD COLUMN IF NOT EXISTS "cycle" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS "dedupeKeyBase" TEXT;

UPDATE "ReviewItem"
SET "dedupeKeyBase" = "entityType" || ':' || "entityId" || ':' || "reasonCode" || ':' ||
    CASE WHEN "entityType" = 'contact' THEN '' ELSE COALESCE("sourceMessageId", '') END
WHERE "dedupeKeyBase" IS NULL;

ALTER TABLE "ReviewItem" ALTER COLUMN "dedupeKeyBase" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "ReviewItem_dedupeKeyBase_cycle_idx" ON "ReviewItem"("dedupeKeyBase", "cycle");

ALTER TABLE "SyncCheckpoint" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER INDEX IF EXISTS "EmailMessage_mailAccountId_direction_classification_contactReso"
    RENAME TO "EmailMessage_mailAccountId_direction_classification_contact_idx";
ALTER INDEX IF EXISTS "EmailMessage_mailAccountId_direction_classification_projectReso"
    RENAME TO "EmailMessage_mailAccountId_direction_classification_project_idx";