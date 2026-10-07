-- Existing events may have been leased when M14 installed the webhook outbox.
-- Give nonterminal events a durable wakeup so an expired lease can be recovered.
INSERT INTO "AgentWakeupDelivery" ("id", "eventId")
SELECT 'wakeup_' || substr(md5("id"), 1, 28), "id"
FROM "AgentEvent"
WHERE "status" IN ('pending', 'processing')
ON CONFLICT ("eventId") DO NOTHING;
