# Sender rules and notification policy

## Behavior

- Rules apply to newly stored inbound messages and recent messages first recovered by reconciliation. An existing message keeps the rule snapshot saved when it was first processed; adding or deleting a rule does not reprocess it. Initial history sync remains silent.
- `address` matches a normalized complete email address. `domain` matches a normalized complete domain only; no wildcard or subdomain matching. Matching is case-insensitive. If address and domain rules conflict, blacklist wins.
- Blacklisted mail is retained with its raw and normalized evidence, classified `BLACKLISTED`, and its processing record is `ignored`. It skips automatic AI/importance triage and CRM/review processing, per-message Agent events, and notification.
- Whitelist bypasses importance triage only when deterministic classification is `BUSINESS_HUMAN`; it queues one durable inbound Agent event with `notificationRequired=true`. Deterministic noise (delivery failures/delays, automatic replies, OOO, ticket confirmations, unsubscribe, marketing/list mail, system notifications, spam) stays silent even when the sender matches a whitelist rule. `UNKNOWN` remains in review without an immediate notice.
- All delivery failures and delays stay silent, including a structured permanent DSN naming an active whitelist address/domain as recipient. Retain the message and extract evidence-backed recipient, status, and diagnostic fields for classification queries; do not queue a per-message notification event.
- For senders outside the whitelist, only a message that clearly requires a reply or business action can become a notification candidate. A real customer reply is not automatically actionable: clear refusals/declines with no question or follow-up (such as “not reviewing partners; keep your information on file”) remain quiet, even if an importance score says high/urgent.
- Rule writes and deletes require `actorId` and a stable unique `operationId`; operations are audited. Reusing an operation ID with a different operation or payload conflicts.

## Interfaces

- API: `GET /api/v1/mail/sender-rules`; `PUT /api/v1/mail/sender-rules` with `{action,matchType,pattern,actorId,operationId}`; `DELETE /api/v1/mail/sender-rules/:id` with `{actorId,operationId}`.
- CLI: `ai-mail sender-rules`, `ai-mail sender-rule-set <blacklist|whitelist> <address|domain> <pattern> <actor-id> <operation-id>`, `ai-mail sender-rule-delete <rule-id> <actor-id> <operation-id>`.
- MCP: `list_sender_rules`, `set_sender_rule`, `delete_sender_rule`.
- Dashboard: 管理 → 发件人规则。页面提示规则优先级及未来生效范围，并建议对白名单优先使用邮箱地址，以免放行同域机器发件人。
- Generic Agent guidance: `skills/sc-mail/SKILL.md`. OpenClaw's event prompt requires one concise Simplified Chinese WhatsApp request for a whitelisted human event with `notificationRequired=true`, or for a non-whitelisted high/urgent human-mail candidate the Agent judges to require our reply or business action. `payloadJson.notificationRequired=false` leaves an Agent decision; `result.actionable=false` forbids a non-whitelisted notice. Clear refusals without follow-up remain silent. Channel/recipient allowlists remain authoritative; a rejected qualifying notice leaves a visible failed event. Completed old events are not replayed automatically after a prompt update.

## Completion decision and verification

A non-whitelisted inbound human event requires boolean `result.actionable`: true must include an allowed notification; false must be silent. `payloadJson.notificationRequired=false` or absent leaves an Agent decision to make; it is not the same field as `result.actionable=false`. A whitelist-required human notice cannot be downgraded. A rejected qualifying request must remain a visible failure.

Importance routing uses validated actionable intent: a confident action request is classified high (urgent stays urgent); a high score without actionable intent stays quiet. This is not a score-only filter. Initial imports retain the durable historical flag and remain silent through reconciliation/recovery.

The isolated harness covers rule validation/precedence/idempotency, human whitelist notices, silent machine mail and whitelisted-recipient DSN, actionable candidates, refusals, and audited recovery. Actual run/deployment results and pending live positive/negative cases are centralized in [README](../README.md) and [Problem](../Problem.md).
