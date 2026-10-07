ALTER TABLE "EmailMessage"
ADD COLUMN "automationDetails" JSONB NOT NULL DEFAULT '{}'::jsonb;
