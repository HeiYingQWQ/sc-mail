# Tasks, Requirements and Decisions API

Routes follow the shared [authentication contract](M13_AGENT_INTEGRATION.md#authentication); automation clients use `Authorization: Bearer <IMAP_API_TOKEN>` and operate on the configured mailbox. Lists accept `limit` (default 50, max 100) and `offset`; task lists also accept `status`, `projectId` and `topicId`. Requirement and decision lists accept `projectId` and `topicId`.

## Manual CRM and project creation

`POST /api/v1/mail/crm/companies`, `/api/v1/mail/crm/contacts`, and `/api/v1/mail/projects` accept an `operationId`; audited callers also send `actorId`. Dashboard clients send both. Repeating a request with the same ID and payload returns the original entity. Reusing the ID with different input returns `409 IDEMPOTENCY_KEY_REUSED`. Each operation stores the actor, entity, action, request hash, and before/after values in `BusinessOperation`. Company and project membership is explicit; matching email domains never add members implicitly.

### Manual CRM and project mail

- `GET /mail/crm/contacts?search=&companyId=&limit=50&offset=0` lists confirmed contacts only. Search accepts one or more characters; `companyId` is an exact membership filter. Automated provisional/retired/merged records do not appear in the ordinary list.
- `POST /mail/crm/contacts` accepts `{displayName,emails,primaryEmail?,companyId?,notes?,operationId,actorId?}`. Contact email values are normalized to lowercase for exact matching. When the user explicitly registers an address held only by an audit-retired, purely automatic contact, POST/PATCH may take over that address for the manual contact. This does not merge the old contact, import its other addresses or relations, or override a confirmed/manual/business-dependent contact; those ownership conflicts remain 409. `PATCH /mail/crm/contacts/:contactId` also requires `expectedVersion`; omitted properties retain their values and `null` clears nullable fields.
- `DELETE /mail/crm/contacts/:contactId` accepts `{operationId,expectedVersion,actorId?}` and performs an audited soft delete (`status=deleted`, version incremented). It returns a deletion receipt, retains mail evidence, and returns 409 while company or active-project membership remains. Remove the relationships explicitly first; this endpoint does not cascade-delete business records. There is no restore operation.
- `POST /mail/crm/companies` accepts `{name,domain?,website?,address?,notes?,contactIds,operationId,actorId?}`. `contactIds` must contain at least one confirmed contact. `PATCH /mail/crm/companies/:companyId` requires `expectedVersion`, `operationId`, and a nonempty full `contactIds` set when changing members. `GET` returns the company, its contacts and its projects.
- `DELETE /mail/crm/companies/:companyId` accepts `{operationId,expectedVersion,actorId?}` and returns an audited soft-delete receipt. A company with non-deleted projects returns 409; contacts are detached from the company within the delete transaction, but neither contacts nor mail evidence are deleted. There is no restore operation.
- `POST /mail/projects` accepts `{name,companyId,description?,contactIds,primaryContactId?,status,stage?,operationId,actorId?}`. The company is required and every selected contact must be a confirmed member of that company. `PATCH /mail/projects/:projectId` requires `expectedVersion` and `operationId`; omitted fields are retained. `status` and `stage` may remain omitted for metadata-only updates, but changing lifecycle requires a coherent final pair (`completed` iff stage is `completed`). Reopening requires `active` plus a non-completed stage.
- `DELETE /mail/projects/:projectId` accepts `{operationId,expectedVersion,actorId?}` and performs an audited soft delete (`status=deleted`) without removing mail or project evidence. Pending analysis or active tasks block deletion with 409; do not cancel, complete, or move those dependencies unless the user separately requests it. There is no restore operation.
- `GET /mail/crm/contacts/:contactId/messages` and `GET /mail/projects/:projectId/messages` accept bounded pagination (`limit` default 20, max 100; `offset` default 0), date filters and inbound/outbound direction. Contact history additionally supports `projectId`; project history supports `contactId`. `fromDate` and `throughDate` are inclusive business-timezone dates. Contact matches use all registered emails against actual From/To/Cc/Bcc participation and return `participantRoles`/`matchedEmails`. Project history does not return those contact-match fields; it returns sender/recipient JSON arrays plus assignment status, evidence, manual lock and assignment version, and the Dashboard derives the displayed participant roles from those arrays. `includeBodies=true` is contact-history-only and capped at 20 rows, with each body excerpt capped at 3000 characters.
- `PATCH /mail/messages/by-id/:messageId/project` accepts `{operationId,expectedVersion,projectId}`. An explicit `projectId:null` locks the message as non-project; assigning an ID records a manual project override. On version conflict reload the message before deciding again. The transaction closes matching project-analysis reviews and marks affected summaries stale.

The dashboard's project editor also keeps project lifecycle status/stage coherent and constrains project contacts to the chosen company's existing members. An explicit user instruction may authorize creation through the API/CLI/MCP; a common complete workflow is duplicate check, contact, company with `contactIds`, then project with `companyId/contactIds/primaryContactId`. Ask for missing required information, reuse only clearly matched existing records, and never merge or take over conflicting email/domain ownership. Email, AI suggestions, or background events alone never authorize CRM creation. Multi-step writes use a distinct stable `operationId` per step; report completed steps on failure and reuse the same ID when retrying a step. See [Agent API adapters and tools](M13_AGENT_INTEGRATION.md) for the same CLI/MCP input contracts.

## Tasks

`GET /api/v1/mail/tasks`, `GET /api/v1/mail/tasks/<id>`, `POST /api/v1/mail/tasks`, `PATCH /api/v1/mail/tasks/<id>`.

Create example:

```json
{"operationId":"phone-req-908","title":"Send revised render","kind":"action","ownerType":"us","waitingOn":"us","priority":"normal","deadlineDate":"2026-10-02","deadlineTimezone":"Europe/Rome","projectId":"<project-id>"}
```

Patch requires `operationId` and `expectedVersion`, plus at least one task field. A successful update increments `version` and sets `manualOverride`; a stale version returns `409 VERSION_CONFLICT`. User-created tasks have `origin=user`, the authenticated API principal as `createdBy`, and no fabricated email source. Email-derived tasks retain `createdFromMessageId`; completion through an analyzed email records `completedFromMessageId`. Allowed status: `open`, `in_progress`, `waiting`, `done`, `cancelled`.

Analysis schema **3** assigns every operation a `task_outcome`: `none`, `acknowledged`, `planned`, `partial`, `completed`, or `unclear`. Acknowledgement or future intent (for example, “Received, I will handle it tomorrow”) cannot complete a task. Email-based completion requires an exact source excerpt with concrete completion language that identifies the target task object and matches its completion action; otherwise the run requires review and cannot be applied. Partial evidence keeps the task active. A schema 1/2 AnalysisRun must be re-analyzed before applying it.

`GET /api/v1/mail/tasks/<id>` returns up to 20 evidence records; task lists return the latest 3. Each record includes `evidenceType`, exact `excerpt`, confidence, and source email metadata. Email outcomes `acknowledged`, `planned`, `partial`, and `completed` are saved in the same transaction as the task operation. For each active task, project waiting aggregation uses its owner, or `waitingOn` when the task is blocked on another party. Multiple distinct parties yield `mixed` and populate `waitingParties`; create a separate task for each side's independent work to represent both sides at once. A reply task owned by us but waiting on the customer does not set `replyRequired`.

## Requirements and decisions

- `GET /api/v1/mail/requirements`, `POST /api/v1/mail/requirements`, `PATCH /api/v1/mail/requirements/<id>`
- `GET /api/v1/mail/decisions`, `POST /api/v1/mail/decisions`, `PATCH /api/v1/mail/decisions/<id>`

Create takes `operationId`, `text`, optional `projectId` / `topicId`, and optional `sourceMessageId` when there is a real source. Patch takes `operationId`, `expectedVersion`, and `text` and/or `status`. Statuses are `open|accepted|rejected` for requirements and `proposed|accepted|rejected` for decisions. Manual updates increment the version and set `manualOverride`; later model suggestions cannot overwrite that decision. Every create/update stores a BusinessOperation receipt with request hash and before/after values. Reusing an idempotency key with different input returns `409`.

## Apply analysis and promote campaign replies

Compatibility only: the user's separate SMTP bulk sender does not leave sent-message copies in Ai Mail's IMAP folders, so its activity is not tracked and this endpoint cannot promote replies from that sender. Inbound mail is classified and processed independently; do not assume a campaign record exists.

After `POST /api/v1/mail/analysis`, inspect the run and explicitly submit chosen Task/Requirement/Decision operation indexes:

```http
POST /api/v1/mail/analysis/<run-id>/apply
Content-Type: application/json

{"operationId":"apply-run-908","operationIndexes":[0,2]}
```

Only completed runs with `validationStatus=valid` can be applied. Project/Topic suggestions and indexes outside the run are rejected. Unchanged create proposals (including confidence-only differences) reuse the existing source fact without another business notification. Multiple distinct creates in the first analysis remain distinct. If a later run changes the proposal or cannot be mapped unambiguously to existing facts, apply returns `409 FACT_REANALYSIS_REVIEW_REQUIRED` and records a source-backed review instead of creating another fact. Legacy applied proposals without a comparison snapshot also require review when changed; no array-position or title-only matching is used. Mail-derived changes preserve evidence and are audited; Task manual overrides are protected.

An eligible human campaign reply can be promoted explicitly with `POST /api/v1/mail/outreach/replies/<message-id>/promote` and `{"operationId":"promote-908"}`. The service resolves only that message's contact/project context, preserving the outreach original, and records `promoted` or `review_required`. Auto-replies, delivery failures and ticket acknowledgements cannot be promoted.

Dashboard password/session authentication is implemented. Many business mutations still audit the principal as `api-token-client`; client-supplied actor labels are not independent authentication. Per-user business authorization/audit attribution is incomplete. There is no automatic customer mail sending.

Task PATCH validates the complete state after merging the patch. Omitted fields retain their value; explicit null clears an optional field. Clearing/changing a project while retaining an incompatible Topic is rejected; clear Topic in the same patch. Date-only deadlines retain a valid timezone, and date/timestamp pairs must agree. Moving or detaching a task recomputes both former/current project waiting states in the mutation transaction.
