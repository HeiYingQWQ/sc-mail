ALTER TABLE "SyncCheckpoint"
    ADD COLUMN "lastPolledAt" TIMESTAMP(3),
    ADD COLUMN "lastSuccessfulSyncAt" TIMESTAMP(3),
    ADD COLUMN "targetUid" INTEGER,
    ADD COLUMN "reconciliationRequired" BOOLEAN NOT NULL DEFAULT FALSE;
