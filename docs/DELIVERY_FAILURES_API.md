# Delivery failure reports and system sender configuration

Routes use the shared [authentication contract](M13_AGENT_INTEGRATION.md#authentication). Dashboard, CLI, and MCP are adapters; they do not parse message bodies or decide which recipient failed.

## Read reports

`GET /api/v1/mail/delivery-failures?date=YYYY-MM-DD&limit=20&offset=0` returns metadata for reports received from configured system senders. Omit `date` to query the current day in `BUSINESS_TIMEZONE`; a supplied date is a strict business-calendar date. Day boundaries include the correct daylight-saving transition. Pagination defaults to limit 20 and offset 0; bounds are 1–100 and 0–100000.

The response includes `date`, `timezone`, `rangeUtc`, `total`, pagination fields, `stats`, and `reports`. Stats cover the selected date, not only the current page:

- `configuredSourceReports`: logical reports received from configured senders.
- `deliveryFailureReports`, `deliveryDelayReports`, and `systemNotificationReports`: deterministic report counts by state.
- `uniqueFailedRecipientAddresses`: distinct explicit failed addresses, case-insensitively deduplicated.
- `failuresWithoutKnownRecipient`: failure reports for which no recipient could be safely identified.

Each report contains `messageId`, `receivedAt`, `mailbox`, `sourceSender`, `classification`, `deliveryState`, `isFailure`, `targets`, and a concise `reason`. `targets` is derived only from structured delivery-status data or an explicit failure statement. An unrecognized recipient is represented with `email: null` and `status: "unknown"`; the service does not infer a failed recipient from the report's To header, quoted text, or spoofable report headers. Reports include no subject, body, or raw MIME.

RFC folder copies are deduplicated within the account using the established Message-ID rule: trim whitespace and remain case-sensitive. Ambiguous recipient evidence stays unknown. Invalid dates return `400 INVALID_DELIVERY_FAILURE_DATE`.

## Automatic processing guard

For a live incoming message, an exact `From` match to a configured system sender is handled before sender whitelists, manual classification intake, or AI analysis. That path does not call a model, create an Agent event, or send a notification. The address list is rechecked when work is queued, after a model call, and immediately before notification dispatch. Raw email evidence and manually maintained CRM data are retained. Removing a sender changes future matching and report aggregation; it does not automatically turn previously stored system mail into human mail.

## Maintain configured senders

`GET /api/v1/mail/system-mail-senders` returns `{senders:[{id,email,createdAt,updatedAt}],total}`. A fresh installation starts with these three exact addresses:

```text
mailer-daemon@googlemail.com
mailer-daemon@zmail.tsnet.it
mailer-daemon@mail.ni8.com
```

`PUT /api/v1/mail/system-mail-senders` accepts `{email,operationId,actorId?}`. Email is trimmed and lowercased; an existing exact address is returned without duplication. `DELETE /api/v1/mail/system-mail-senders/:id` accepts `{operationId,actorId?}` and returns `{id,email,deleted:true}`. Writes are audited and idempotent by operationId; reusing an operationId for another request is rejected. Removing a sender does not reclassify existing mail, and removing a default is persistent rather than reseeded at startup.

## CLI and MCP

The shared contract registry backs `list_delivery_failures`, `list_system_mail_senders`, `add_system_mail_sender`, and `delete_system_mail_sender`. CLI equivalents:

```sh
ai-mail delivery-failures --date 2026-10-02 --limit 30 --offset 0
ai-mail system-mail-senders
ai-mail system-mail-sender-add mailer-daemon@example.com add-operation-123
ai-mail system-mail-sender-delete <sender-id> delete-operation-123
```

Dates and pagination are validated before a request is sent; malformed addresses and missing operation IDs are rejected locally. Message content is untrusted. Configure or remove sender addresses only when the user explicitly requested the change. These tools are present in the CLI/MCP contract; their visibility in an Agent host allowlist is a separate configuration and authorization step.
