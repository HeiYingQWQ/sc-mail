# Email analysis API

Only the `openai` provider is implemented. Set `AI_PROVIDER=openai`, `AI_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (default `https://api.openai.com/v1`) and `AI_REASONING_EFFORT` (default `medium`) in local `.env`; Compose passes these variables to the backend. The key is read from the environment, never returned or logged. The provider uses the OpenAI Responses API with strict JSON Schema output, `store: false`, a 20-second timeout and one retry by default. `AI_REASONING_EFFORT` accepts `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`; `AI_TIMEOUT_MS` accepts 1000–60000, `AI_RETRY_COUNT` accepts 0–2, and `AI_CONTEXT_MAX_CHARS` accepts 4000–32000 (default 18000). `AI_REASONING_EFFORT` is omitted for GPT-4.x, GPT-4o and GPT-3.5 models, including the default `gpt-4.1-mini`. Model and compatible base URL are configuration; other providers are an interface extension point.

Automation clients use `Authorization: Bearer <IMAP_API_TOKEN>`; Dashboard sessions follow the shared [authentication contract](M13_AGENT_INTEGRATION.md#authentication). Deployment and verification status are recorded in the [root README](../README.md).

## Analyze an imported message

```http
POST /api/v1/mail/analysis
Content-Type: application/json

{"messageId":"<imported-email-id>","operationId":"client-generated-stable-id"}
```

The operation ID is an idempotency key unique within the mailbox account. Repeating it for the same email returns the same AnalysisRun without another model call. Reusing it for another email returns `409`. Active and terminal runs are reused. An interrupted/expired processing attempt can be retried with the same operation ID; a database lease fences late workers. The lease lasts the configured maximum provider attempt duration plus 60 seconds. Reading an expired run reports `failed / AI_ANALYSIS_INTERRUPTED`. Ordinary terminal provider failures require a new operation ID for another attempt. Use a new operation ID to request a new analysis version.

The response is an AnalysisRun containing `id`, `status`, `validationStatus`, `provider`, `model`, `promptVersion`, `schemaVersion`, `inputSummaryJson`, `resultJson`, `validationErrorsJson`, `durationMs`, and `errorCode`.

```http
GET /api/v1/mail/analysis/<analysis-run-id>
```

The run is scoped to the configured mailbox. Provider failure returns a safe error code and `analysisRunId`; raw provider response bodies and credentials are not exposed.

## CLI and MCP

Agents can request the same idempotent analysis with MCP `suggest_email_analysis` (`messageId`, `operationId`) or CLI `ai-mail suggest-email-analysis <message-id> <operation-id>`. This is intended for user-selected mail or an uncertain review candidate, not every arrival. The result remains a suggestion; the Agent must not apply business changes unless the user authorized them.

## Validation and limits

The analyzer sends the current message, up to four recent messages from its thread, and available Contact/Company/Project/Topic state and project/topic/thread summaries. For a known project it also sends up to three open Tasks, three open Requirements and three active Decisions, with long text truncated. Input is truncated to the configured limit; the stored input summary contains message IDs, related entity IDs, size and SHA-256 digest, not a second copy of email bodies.

Legacy schema 1/2 runs must be reanalyzed before business apply. The response is checked against an executable strict JSON Schema and a separate business validator. Every operation must cite the current email ID and an evidence excerpt found in its subject/body. Create requires a null target; update/complete/cancel requires an existing in-scope target. Date-only values require a valid calendar date and configured business IANA timezone; absolute date-times require an ISO offset. The model receives the email timestamp in UTC and the business timezone; an unresolved relative deadline retains `deadline_text` and requires review. Conflicting date/time fields, unsupported entity/action/fields, invalid source/evidence, missing targets, or confidence below 0.75 make the run `review_required`.

The `summary` is requested as a concise cumulative summary using prior summaries and current relevant state where available. It remains a proposal until saved with `POST /api/v1/mail/analysis/<id>/summary` (see [Summary, Timeline and project state](SUMMARY_TIMELINE_API.md)). Applying business operations from a message is rejected with `409 STALE_SOURCE` when a newer message already exists in the same project, topic, or thread scope.

Analysis schema **3** includes `task_outcome` to every proposed operation. Mail-derived Task completion is accepted only for a `completed` outcome whose exact evidence excerpt contains concrete completion wording, is not negated or future intent, and identifies the target task and matches its action. Document readiness does not complete a sending task. Evidence about a different object cannot complete the target; English, Italian and Chinese completion cues are checked conservatively. Acknowledgement/planned/partial evidence remains non-terminal and is recorded against the Task; ambiguous completion leaves the run in `review_required`. See [Task evidence and outcome handling](BUSINESS_RECORDS_API.md).

`UNKNOWN`, non-empty `review_reasons`, or `requires_deep_analysis=true` also mark `review_required`. The analyzer only stores the AnalysisRun and suggestions. A caller must explicitly apply selected Task/Requirement/Decision operation indexes using `POST /api/v1/mail/analysis/<id>/apply`; only a completed run with `validationStatus=valid` can be applied. Each source suggestion has a stable idempotency record. No live OpenAI request is performed by fixture checks.

Analysis uses the shared current-message body projection with HTML fallback and linked-parent quote removal. Raw MIME/text/HTML evidence remains stored. `inputSummaryJson.summaryInputVersions` records every supplied project/topic/thread summary version, including absent summaries as version 0; summary apply cannot substitute a newer caller version for the model input version.

## Project mail batch analysis

This is a separate user-triggered workflow, not the per-message AnalysisRun above and not a reason to analyze every mailbox message. A project must have its company and confirmed project contacts. The API uses registered contact addresses to find a bounded set of already-synced inbound and sent messages, deduplicated by account/message identity. The caller selects an inclusive business-timezone date range; date-only `YYYY-MM-DD` values are required. The default is the recent 180 days, the maximum batch is 500 candidates, and one day (`from === to`) is valid. If the selection exceeds `limit`, the server returns `409 PROJECT_ANALYSIS_SCOPE_TOO_LARGE` with the candidate count and limit; narrow the dates and start a new operation.

```http
POST /api/v1/mail/projects/<project-id>/analysis
Content-Type: application/json

{"operationId":"project-analysis-2026-09","from":"2026-09-01","to":"2026-09-30","limit":500}
```

The response contains `{jobId,status,candidateCount,totalCandidateCount,candidateTruncated,range,replayed}`. The latest job is `GET /api/v1/mail/projects/<project-id>/analysis` and returns `{job:null|job}`. Read paginated work with `GET /api/v1/mail/project-analysis/<job-id>?limit=50&offset=0`. Job states are `pending|processing|completed|partial|failed|cancelled`; summary states are `pending|processing|completed|failed|not_requested`. Items include message subject/time, source deletion marker, result, candidate project names/status, evidence, reason and safe error code. They do not require the caller to display raw IDs as labels.

Outcomes include `assigned`, `non_project`, `new_opportunity`, `uncertain`, and `multi_project`. Only a server-validated assignment to a provided eligible project is automatic. New opportunities, conflicting candidates and uncertain evidence become pending global ReviewItems; no contact, company, project or project member is created by the model. Reviewers can assign an existing project or explicitly lock no-project. Manual assignments include `expectedVersion` and `operationId`, preserve human overrides, close the corresponding project-analysis review, and mark affected summaries stale. Deleted source messages cannot be opened or reassigned.

Cancel using `POST /api/v1/mail/project-analysis/<job-id>/cancel` with `{operationId}`; it stops unclaimed work while retaining completed results. Retry `partial`/`failed` jobs with `POST .../<job-id>/retry` and `{operationId}`; failed items and a failed summary can be retried independently. Progress polling does not expose provider prompts or raw provider errors. Project summaries report coverage/staleness; if a human-edited summary is protected, automatic analysis adds an `isSuggestion` version instead of replacing it. An authorized user can explicitly adopt a suggestion with `POST /api/v1/mail/summaries/rollback` using the current summary `expectedVersion` and the suggestion's `targetVersion`.

CLI commands are `project-analysis-start`, `project-analysis`, `project-analysis-job`, `project-analysis-cancel`, and `project-analysis-retry`; MCP names are `start_project_analysis`, `get_project_analysis`, `get_project_analysis_job`, `cancel_project_analysis`, and `retry_project_analysis`. The same shared schema/runtime validator also covers CRM/project CRUD and manual email assignment. API/CLI/MCP reuse backend business behavior and do not call a live model during fake-contract verification.
