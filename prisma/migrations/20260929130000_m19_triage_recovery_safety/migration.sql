ALTER TABLE "EmailImportanceTriage"
  ADD COLUMN "promptVersion" TEXT,
  ADD COLUMN "schemaVersion" TEXT;

UPDATE "EmailImportanceTriage"
SET "promptVersion" = 'legacy-unversioned', "schemaVersion" = '1'
WHERE "analyzedAt" IS NOT NULL;
