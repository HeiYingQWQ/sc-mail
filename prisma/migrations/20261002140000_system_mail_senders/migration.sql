CREATE TABLE "SystemMailSender" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemMailSender_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SystemMailSender_email_key" ON "SystemMailSender"("email");

INSERT INTO "SystemMailSender" ("id", "email", "createdAt", "updatedAt") VALUES
  ('system-mail-sender-googlemail', 'mailer-daemon@googlemail.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-mail-sender-zmail', 'mailer-daemon@zmail.tsnet.it', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-mail-sender-ni8', 'mailer-daemon@mail.ni8.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
