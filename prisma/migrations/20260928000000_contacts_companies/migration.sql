CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisional',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "provisionalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactEmail" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT TRUE,
    "verified" BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactEmail_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EmailMessage"
    ADD COLUMN "contactId" TEXT,
    ADD COLUMN "companyId" TEXT,
    ADD COLUMN "contactResolutionStatus" TEXT NOT NULL DEFAULT 'unresolved',
    ADD COLUMN "contactResolutionConfidence" DOUBLE PRECISION,
    ADD COLUMN "contactResolutionReason" TEXT,
    ADD COLUMN "companyResolutionReason" TEXT;

CREATE UNIQUE INDEX "Company_domain_key" ON "Company"("domain");
CREATE UNIQUE INDEX "ContactEmail_email_key" ON "ContactEmail"("email");
CREATE INDEX "Contact_companyId_status_idx" ON "Contact"("companyId", "status");
CREATE INDEX "ContactEmail_contactId_isPrimary_idx" ON "ContactEmail"("contactId", "isPrimary");
CREATE INDEX "EmailMessage_contactId_receivedAt_idx" ON "EmailMessage"("contactId", "receivedAt");
CREATE INDEX "EmailMessage_companyId_receivedAt_idx" ON "EmailMessage"("companyId", "receivedAt");
CREATE INDEX "EmailMessage_mailAccountId_direction_classification_contactResolutionStatus_idx"
    ON "EmailMessage"("mailAccountId", "direction", "classification", "contactResolutionStatus");

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactEmail" ADD CONSTRAINT "ContactEmail_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
