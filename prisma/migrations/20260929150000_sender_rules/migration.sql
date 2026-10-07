ALTER TABLE "EmailMessage"
ADD COLUMN "senderRuleSnapshot" JSONB;

CREATE TABLE "SenderRule" (
    "id" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SenderRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SenderRule_mailAccountId_matchType_pattern_key"
ON "SenderRule"("mailAccountId", "matchType", "pattern");
CREATE INDEX "SenderRule_mailAccountId_deletedAt_idx"
ON "SenderRule"("mailAccountId", "deletedAt");

ALTER TABLE "SenderRule"
ADD CONSTRAINT "SenderRule_mailAccountId_fkey"
FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
