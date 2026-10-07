ALTER TABLE "EmailMessage"
    ADD COLUMN "classificationManualOverride" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "Contact"
    ADD COLUMN "mergedIntoId" TEXT;

CREATE INDEX "Contact_mergedIntoId_idx" ON "Contact"("mergedIntoId");

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_mergedIntoId_fkey"
    FOREIGN KEY ("mergedIntoId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
