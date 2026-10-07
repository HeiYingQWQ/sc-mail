const assert = require('node:assert/strict');
const { ANALYSIS_OUTPUT_SCHEMA } = require('../dist/modules/ai/analysis.schema.js');
const { validateAgainstJsonSchema } = require('../dist/modules/ai/json-schema.validator.js');
const { analysisNeedsReview, targetIsInKnownScope, validateAnalysisBusiness, validateClassificationEvidence } = require('../dist/modules/ai/analysis.business-validator.js');
const { buildAnalysisContext } = require('../dist/modules/ai/analysis-context.js');
const { callOpenAIResponses } = require('../dist/modules/ai/openai-responses.provider.js');
const { inspectAnalysisIdempotency } = require('../dist/modules/ai/analysis.idempotency.js');

const operation = (overrides = {}) => ({
  entity_type: 'task', action: 'create', target_id: null, source_message_id: 'mail-1',
  evidence: 'send the updated render by Friday', confidence: 0.91, task_outcome: 'none',
  changes: {
    title: 'Send updated render', description: null, kind: 'action', owner_type: 'us', owner_id: null,
    waiting_on: null, status: null, priority: 'normal', deadline_at: null, deadline_date: '2026-10-02',
    deadline_timezone: 'Europe/Rome', deadline_text: 'Friday', text: null, project_name: null, stage: null,
    topic_name: null, topic_type: null, topic_description: null,
  },
  ...overrides,
});
const result = {
  schema_version: '3', classification: 'BUSINESS_HUMAN', classification_confidence: 0.94,
  classification_evidence: ['Please send the updated render'], summary: 'Customer requests a revised render.',
  operations: [operation()], reply_required_suggestion: true, importance: 'normal',
  requires_deep_analysis: false, review_reasons: [],
};

assert.deepEqual(validateAgainstJsonSchema(result, ANALYSIS_OUTPUT_SCHEMA), []);
assert.ok(validateAgainstJsonSchema({ ...result, classification_evidence: [] }, ANALYSIS_OUTPUT_SCHEMA).some((error) => error.includes('too few items')));
assert.ok(validateAgainstJsonSchema({ ...result, unexpected: true }, ANALYSIS_OUTPUT_SCHEMA).some((error) => error.includes('unexpected property')));
assert.ok(validateAgainstJsonSchema({ ...result, operations: [{ ...operation(), changes: { ...operation().changes, unsafe: 'x' } }] }, ANALYSIS_OUTPUT_SCHEMA).some((error) => error.includes('unexpected property')));
  assert.ok(validateAgainstJsonSchema({ ...result, operations: [operation({ entity_type: 'script' })] }, ANALYSIS_OUTPUT_SCHEMA).length > 0);
  assert.deepEqual(inspectAnalysisIdempotency(null, 'mail-1'), { action: 'run' });
  assert.deepEqual(inspectAnalysisIdempotency({ sourceMessageId: 'mail-1' }, 'mail-1'), { action: 'reuse' });
  assert.deepEqual(inspectAnalysisIdempotency({ sourceMessageId: 'mail-1' }, 'mail-2'), { action: 'conflict' });

(async () => {
  const currentText = 'Please send the updated render by Friday so we can review it.';
  const exists = async (entity, id) => entity === 'project' && id === 'project-1' ? true : entity === 'task' && id === 'task-1' ? { exists: true, title: 'Send revised render' } : false;
  const dateContext = { hasMessageDate: true, businessTimezone: 'Europe/Rome' };
  assert.deepEqual(await validateAnalysisBusiness(result, 'mail-1', currentText, exists, dateContext), []);
  assert.deepEqual(validateClassificationEvidence(result.classification_evidence, currentText), []);
  assert.deepEqual(validateClassificationEvidence(['This is not in the email'], currentText), ['CLASSIFICATION_EVIDENCE_NOT_VERIFIABLE']);
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ source_message_id: 'mail-2' })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: SOURCE_NOT_CURRENT_MESSAGE'));
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ evidence: 'client is angry' })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: EVIDENCE_NOT_VERIFIABLE'));
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ confidence: 0.4 })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: LOW_CONFIDENCE'));
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ action: 'update', target_id: null })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: TARGET_ID_REQUIRED'));
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ action: 'update', target_id: 'missing-task' })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: TARGET_NOT_FOUND_OR_UNAVAILABLE'));
  assert.equal((await validateAnalysisBusiness({ ...result, operations: [operation({ changes: { ...operation().changes, owner_type: 'customer' } })] }, 'mail-1', currentText, exists, dateContext)).length, 0);
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ entity_type: 'project', changes: { ...operation().changes, owner_type: 'us', project_name: 'new project' } })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: FIELD_NOT_ALLOWED_owner_type'));
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ changes: { ...operation().changes, deadline_date: '2026-02-30', deadline_timezone: 'Europe/Rome' } })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: DEADLINE_DATE_INVALID'));
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ changes: { ...operation().changes, deadline_at: '2026-09-28T10:00:00Z', deadline_date: '2026-09-29', deadline_timezone: 'Europe/Rome' } })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: DEADLINE_FIELDS_CONFLICT'));
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ changes: { ...operation().changes, deadline_timezone: 'Not/AZone', deadline_date: '2026-09-28' } })] }, 'mail-1', currentText, exists, dateContext)).includes('operations[0]: DEADLINE_TIMEZONE_INVALID'));
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [operation({ changes: { ...operation().changes, deadline_text: 'Friday' } })] }, 'mail-1', currentText, exists, { ...dateContext, hasMessageDate: false })).includes('operations[0]: DEADLINE_BASELINE_DATE_MISSING'));

  const noTaskChanges = Object.fromEntries(Object.keys(operation().changes).map((key) => [key, null]));
  const planned = operation({ action: 'update', target_id: 'task-1', task_outcome: 'planned', evidence: 'Received, I will handle it tomorrow', changes: noTaskChanges });
  assert.deepEqual(await validateAnalysisBusiness({ ...result, operations: [planned] }, 'mail-1', 'Received, I will handle it tomorrow', exists, dateContext), []);
  const prematureCompletion = operation({ action: 'complete', target_id: 'task-1', task_outcome: 'completed', evidence: '收到，明天处理', changes: { ...noTaskChanges, status: 'done' } });
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [prematureCompletion] }, 'mail-1', '收到，明天处理', exists, dateContext)).includes('operations[0]: COMPLETION_EVIDENCE_NOT_CONCRETE'));
  const completed = operation({ action: 'complete', target_id: 'task-1', task_outcome: 'completed', evidence: 'The revised render was sent.', changes: { ...noTaskChanges, status: 'done' } });
  assert.deepEqual(await validateAnalysisBusiness({ ...result, operations: [completed] }, 'mail-1', 'The revised render was sent.', exists, dateContext), []);
  const notDelivered = operation({ action: 'complete', target_id: 'task-1', task_outcome: 'completed', evidence: 'The revised render has not been sent.', changes: { ...noTaskChanges, status: 'done' } });
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [notDelivered] }, 'mail-1', 'The revised render has not been sent.', exists, dateContext)).includes('operations[0]: COMPLETION_EVIDENCE_NOT_CONCRETE'));
  const futureDelivery = operation({ action: 'complete', target_id: 'task-1', task_outcome: 'completed', evidence: 'The revised render will be sent tomorrow.', changes: { ...noTaskChanges, status: 'done' } });
  assert.ok((await validateAnalysisBusiness({ ...result, operations: [futureDelivery] }, 'mail-1', 'The revised render will be sent tomorrow.', exists, dateContext)).includes('operations[0]: COMPLETION_EVIDENCE_NOT_CONCRETE'));
  assert.equal(targetIsInKnownScope('project', 'company-a', null, { id: 'p1', companyId: 'company-b', status: 'active' }), false);
  assert.equal(targetIsInKnownScope('project', 'company-a', null, { id: 'p1', companyId: 'company-a', status: 'active' }), true);
  assert.equal(targetIsInKnownScope('topic', 'company-a', 'p1', { id: 't1', projectId: 'p2', status: 'active' }), false);
  assert.equal(analysisNeedsReview(result, []), false);
  assert.equal(analysisNeedsReview({ ...result, review_reasons: ['uncertain date'] }, []), true);
  assert.equal(analysisNeedsReview({ ...result, classification: 'UNKNOWN' }, []), true);
  assert.equal(analysisNeedsReview({ ...result, requires_deep_analysis: true }, []), true);

  const bounded = buildAnalysisContext({
    current: { id: 'mail-1', date: null, direction: 'inbound', from: [], subject: 'Subject', text: 'x'.repeat(9000) },
    recent: Array.from({ length: 4 }, (_, i) => ({ id: `old-${i}`, date: null, direction: 'inbound', from: [], subject: 'Previous', text: 'y'.repeat(4000) })),
    contact: null, company: null, projects: [], currentProject: null, currentTopic: null, maxChars: 5000,
    businessTimezone: 'Europe/Rome', firstPassClassification: { classification: 'SPAM', manualOverride: false },
    priorAudits: [{ analysisRunId: 'run-old', classification: 'NEWSLETTER' }],
  });
  assert.ok(bounded.promptContext.length <= 5000);
  assert.equal(bounded.context.messages[0].id, 'mail-1');
  assert.equal(bounded.summary.trimmed, true);
  assert.equal(bounded.context.first_pass_classification.classification, 'SPAM');
  assert.equal(bounded.context.prior_ai_audits[0].analysisRunId, 'run-old');
  assert.deepEqual(bounded.summary.priorAuditRunIds, ['run-old']);

  let captured;
  const responseJson = JSON.stringify(result);
  const response = await callOpenAIResponses(async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: responseJson }] }] }) };
  }, 'dummy-api-key', 'fixture-model', 'fixture prompt', ANALYSIS_OUTPUT_SCHEMA, { timeoutMs: 5000, retryCount: 0 });
  assert.deepEqual(response, result);
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(captured.body.model, 'fixture-model');
  assert.equal(captured.init.headers.Authorization, 'Bearer dummy-api-key');

  await assert.rejects(
    callOpenAIResponses(async () => { const error = new Error('secret detail'); error.name = 'TimeoutError'; throw error; }, 'not-for-logs', 'model', 'p', ANALYSIS_OUTPUT_SCHEMA, { timeoutMs: 1, retryCount: 0 }),
    (error) => error.code === 'AI_TIMEOUT' && !error.message.includes('not-for-logs') && !error.message.includes('secret detail'),
  );
  await assert.rejects(
    callOpenAIResponses(async () => ({ ok: true, json: async () => { throw new SyntaxError('private malformed HTTP body'); } }), 'not-for-logs', 'model', 'p', ANALYSIS_OUTPUT_SCHEMA, { timeoutMs: 1000, retryCount: 0 }),
    (error) => error.code === 'AI_INVALID_RESPONSE' && !error.message.includes('private malformed HTTP body'),
  );
  let invalidResponseCalls = 0;
  const recoveredResponse = await callOpenAIResponses(async () => {
    invalidResponseCalls++;
    return invalidResponseCalls === 1
      ? { ok: true, json: async () => { throw new SyntaxError('private malformed HTTP body'); } }
      : { ok: true, json: async () => ({ status: 'completed', output_text: responseJson }) };
  }, 'dummy-api-key', 'model', 'p', ANALYSIS_OUTPUT_SCHEMA, { timeoutMs: 1000, retryCount: 1 });
  assert.equal(invalidResponseCalls, 2);
  assert.deepEqual(recoveredResponse, result);
  const splitAt = Math.floor(responseJson.length / 2);
  const combinedResponse = await callOpenAIResponses(async () => ({ ok: true, json: async () => ({
    status: 'completed', output: [
      { content: [{ type: 'output_text', text: responseJson.slice(0, splitAt) }] },
      { content: [{ type: 'output_text', text: responseJson.slice(splitAt) }] },
    ],
  }) }), 'dummy-api-key', 'model', 'p', ANALYSIS_OUTPUT_SCHEMA, { timeoutMs: 1000, retryCount: 0 });
  assert.deepEqual(combinedResponse, result);
  await assert.rejects(
    callOpenAIResponses(async () => ({ ok: false, status: 401, json: async () => ({ error: 'private body' }) }), 'not-for-logs', 'model', 'p', ANALYSIS_OUTPUT_SCHEMA, { timeoutMs: 1, retryCount: 0 }),
    (error) => error.code === 'AI_UPSTREAM_REJECTED' && !error.message.includes('private body'),
  );
  console.log('M8–M16 schema/provider/context/evidence/business-validator fixtures passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
