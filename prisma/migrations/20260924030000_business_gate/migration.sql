CREATE TABLE "OutreachCampaign" (
    "id" TEXT NOT NULL,
    "campaignKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutreachCampaign_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EmailMessage"
    ADD COLUMN "classification" TEXT NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN "classificationReason" TEXT,
    ADD COLUMN "classificationEvidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN "classifiedAt" TIMESTAMP(3),
    ADD COLUMN "campaignId" TEXT,
    ADD COLUMN "campaignRole" TEXT,
    ADD COLUMN "promotionStatus" TEXT NOT NULL DEFAULT 'none';

CREATE UNIQUE INDEX "OutreachCampaign_campaignKey_key" ON "OutreachCampaign"("campaignKey");
CREATE INDEX "EmailMessage_mailAccountId_classification_reviewRequired_idx" ON "EmailMessage"("mailAccountId", "classification", "reviewRequired");
CREATE INDEX "EmailMessage_campaignId_promotionStatus_idx" ON "EmailMessage"("campaignId", "promotionStatus");
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
