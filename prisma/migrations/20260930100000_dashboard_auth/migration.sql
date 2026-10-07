CREATE TABLE "DashboardUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordSalt" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DashboardUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DashboardSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DashboardSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DashboardUser_email_key" ON "DashboardUser"("email");
CREATE INDEX "DashboardUser_updatedAt_idx" ON "DashboardUser"("updatedAt");
CREATE UNIQUE INDEX "DashboardSession_tokenHash_key" ON "DashboardSession"("tokenHash");
CREATE INDEX "DashboardSession_userId_expiresAt_idx" ON "DashboardSession"("userId", "expiresAt");
CREATE INDEX "DashboardSession_expiresAt_idx" ON "DashboardSession"("expiresAt");

ALTER TABLE "DashboardSession" ADD CONSTRAINT "DashboardSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "DashboardUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
