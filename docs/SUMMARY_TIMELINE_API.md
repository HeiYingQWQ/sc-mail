# Summary, Timeline and project state

Routes follow the shared [authentication contract](M13_AGENT_INTEGRATION.md#authentication). Times are UTC. Updates require idempotency keys and expected versions; on `409 VERSION_CONFLICT`, `SUMMARY_VERSION_CONFLICT`, or `CONCURRENT_UPDATE`, reload and retry.

## Summaries

`POST /api/v1/mail/analysis/<run-id>/summary` explicitly saves the validated run's `resultJson.summary` for its source entity. Body:

```json
{"operationId":"stable-client-key","entityType":"project","entityId":"project-id","expectedVersion":0}
```

`entityType` accepts `project`, `topic`, or `thread`. The source email must be assigned to that exact entity. If a newer message exists in the scope, the operation fails with `409 STALE_SOURCE`; re-analyze a current message. First write uses version 0. `expectedVersion` must also equal the model input version recorded in `AnalysisRun.inputSummaryJson.summaryInputVersions`. A stale/legacy run without that snapshot fails with `409 SUMMARY_INPUT_STALE`; reanalyze after a summary edit or rollback. Replays of an already applied operation remain idempotent. Caller-supplied current versions cannot refresh an old proposal. Saving creates an immutable `SummaryVersion`, sets the current pointer, and adds a project/topic timeline event. `GET /api/v1/mail/projects/<id>/summary` or `GET /api/v1/mail/summaries/<entity-type>/<entity-id>` returns current text and up to 20 versions.

`GET /api/v1/mail/summaries/project/<id>` returns the current summary identity/text/version, `isDerived`, `manualOverride`, `inputHash`, coverage/stale metadata, and a bounded versions list. Each version can mark `isSuggestion`; suggestions include their source email and source-deleted marker. Batch project analysis may save a derived version when the summary is not manually protected; when a human summary is protected it preserves `currentVersionId` and appends a suggestion instead. Coverage reports the included/omitted source scope and truncation/staleness information; do not present a partial suggestion as complete coverage.

`POST /api/v1/mail/summaries/rollback` body: `{"operationId":"...","summaryId":"...","expectedVersion":2,"targetVersion":3}`. This is also the explicit “adopt suggestion” action. Use the current summary CAS version as `expectedVersion` and the suggestion's SummaryVersion version as `targetVersion`; the service appends a new version and turns on manual protection. It does not change tasks, decisions, requirements, project stage, or waiting state. A deleted suggestion source should not be adopted.

## Timeline and stage

`GET /api/v1/mail/projects/<id>/timeline?limit=50&offset=0` returns recent task, requirement, decision, summary, state and stage events with source-message references where available.

`PATCH /api/v1/mail/projects/<id>/stage` body: `{"operationId":"...","expectedVersion":1,"stage":"quotation"}`; optional `status` is `active|completed`. Allowed stages: `lead`, `planning`, `design`, `quotation`, `revision`, `approval`, `production`, `delivery`, `completed`, `on_hold`, `cancelled`. If `status` is supplied it must agree with `stage` (`completed` iff `completed`); with no status, `stage=completed` sets status completed and another stage sets active. Reopening an already-completed project requires explicit `status:"active"` with the non-completed stage. The update is version-guarded, marks a manual override, and writes an audit operation plus Timeline event. The general project PATCH also supports metadata/member updates and enforces a coherent final status/stage pair.

Task mutations in a project recompute `waitingOn`, `waitingParties`, `replyRequired`, and earliest absolute `followUpAt` from active tasks in the same serializable transaction. Stage is independent. Multiple parties resolve to `mixed`; reply-required derives from active reply/confirmation tasks owned by `us`, excluding tasks blocked in `waiting` on `customer` or `third_party`. Date-only deadlines do not currently populate `followUpAt`.
