// Synthetic regressions. No IMAP, network, production database, or notifications.
const assert = require('node:assert/strict');
const { currentEmailBody, quotedParentBodies } = require('../dist/modules/mail/email-body');
const { emailThreadNavigation } = require('../dist/modules/mail/email-thread');
const { EmailImportanceTriageService } = require('../dist/modules/mail/email-importance-triage.service');
const { AuthService } = require('../dist/modules/auth/auth.service');
const { BusinessRecordsService } = require('../dist/modules/mail/business-records.service');
const { SummaryTimelineService } = require('../dist/modules/mail/summary-timeline.service');
const { EmailAnalyzerService } = require('../dist/modules/ai/email-analyzer.service');
const { callOpenAIResponses } = require('../dist/modules/ai/openai-responses.provider');
const { validateAnalysisBusiness } = require('../dist/modules/ai/analysis.business-validator');
const { ANALYSIS_OUTPUT_SCHEMA } = require('../dist/modules/ai/analysis.schema');
const { buildAnalysisContext } = require('../dist/modules/ai/analysis-context');
const { classifyMail } = require('../dist/modules/mail/business-gate.rules');
const { isConfiguredSystemSender } = require('../dist/modules/mail/business-gate.rules');
const systemMailSenders = { matchSystemSenderAddresses: async addresses => addresses.filter(address => address.trim().toLowerCase() === 'ops@example.test') };
const config = { get: (key, fallback) => ({ IMAP_EMAIL: 'owner@test.invalid', IMAP_HOST: 'imap.test.invalid', AI_TIMEOUT_MS: 1000, AI_RETRY_COUNT: 0 }[key] ?? fallback) };
const tests = []; const test = (name, run) => tests.push({ name, run });
const conflict = code => error => error.status === 409 && error.response.code === code;
const operation = (title, evidence) => ({ entity_type: 'task', action: 'create', target_id: null, source_message_id: 'mail', evidence, confidence: .95, task_outcome: 'none', changes: Object.fromEntries(Object.keys(ANALYSIS_OUTPUT_SCHEMA.properties.operations.items.properties.changes.properties).map(key => [key, key === 'title' ? title : null])) });
const result = { schema_version: '3', classification: 'BUSINESS_HUMAN', classification_confidence: .95, classification_evidence: ['Please send the quotation'], summary: 'Quote requested.', operations: [], reply_required_suggestion: true, importance: 'normal', requires_deep_analysis: false, review_reasons: [] };

test('provider omits reasoning for legacy defaults and retains it for reasoning models', async () => {
  for (const model of ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4o', 'gpt-5']) {
    let body;
    await callOpenAIResponses(async (_url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ output_text: '{}' }) }; }, 'synthetic', model, 'p', {}, { timeoutMs: 1000, retryCount: 0, reasoningEffort: 'medium' });
    assert.equal(Boolean(body.reasoning), model === 'gpt-5');
  }
});
test('logout concurrent with validation cannot resurrect a session', async () => {
  let exists = true; let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const row = { id: 'session', userId: 'user', expiresAt: new Date(Date.now() + 60000), user: { id: 'user', email: 'owner@test.invalid', mustChangePassword: false } };
  const auth = new AuthService({ dashboardSession: {
    findUnique: async () => { const snapshot = exists ? row : null; entered(); await new Promise(resolve => { release = resolve; }); return snapshot; },
    deleteMany: async () => { exists = false; return { count: 1 }; },
    updateMany: async () => ({ count: exists ? 1 : 0 }),
  } }, config);
  const pending = auth.isActiveSessionToken('synthetic-token'); await started;
  await auth.logout('synthetic-token'); release(); assert.equal(await pending, false);
});
test('explicit sessions with a mandatory password change stay unauthorized', async () => {
  const auth = new AuthService({ dashboardSession: { findUnique: async () => ({ id: 's', expiresAt: new Date(Date.now() + 60000), user: { mustChangePassword: true } }), updateMany: async () => ({ count: 1 }) } }, config);
  assert.equal(await auth.isActiveSessionToken('synthetic-token'), false);
});
test('top, bottom, inline, localized and HTML replies retain only new content', () => {
  assert.equal(currentEmailBody('New answer.\n\nOn Wed, Alice wrote:\n> Old mail.\n> Signature', null), 'New answer.');
  assert.equal(currentEmailBody('On Wed, Alice wrote:\n> Old mail.\n\nNew bottom answer.', null), 'New bottom answer.');
  assert.equal(currentEmailBody('Il 1 ottobre Alice ha scritto:\n> Prima domanda\nRisposta uno\n> Seconda domanda\nRisposta due', null), 'Risposta uno\nRisposta due');
  assert.equal(currentEmailBody(null, '<div>New top</div><div class="gmail_quote">On Wed, Alice wrote:<blockquote>Old</blockquote></div><div>New bottom</div>'), 'New top\nNew bottom');
  assert.equal(currentEmailBody(null, '<div class="moz-cite-prefix">On Wed, Alice wrote:</div><blockquote type="cite">Old</blockquote><p>Bottom answer</p>'), 'Bottom answer');
  assert.equal(currentEmailBody(null, '<p>On Wednesday, Alice wrote:</p><blockquote>Old</blockquote><p>Bottom answer</p>'), 'Bottom answer');
  assert.equal(currentEmailBody('> Only history', null), null);
  assert.equal(currentEmailBody(null, '<script>alert(1)</script><p>Hello</p><img src="https://tracking.invalid/a">'), 'Hello');
  assert.equal(currentEmailBody('Please retain this ordinary new content: I wrote a proposal.', null), 'Please retain this ordinary new content: I wrote a proposal.');
});
test('unprefixed Outlook bottom replies use actual linked parent evidence', async () => {
  const parent = 'Please send the quotation for the project.\nRegards, Alice';
  const text = `From: Alice\nSent: Wednesday\nTo: Owner\nSubject: Quote\n\n${parent}\n\nHere is my answer below the previous message.`;
  const parents = await quotedParentBodies({ emailMessage: { findMany: async query => { assert.equal(query.where.mailAccountId, 'account'); assert.deepEqual(query.where.rfcMessageId.in, ['<parent>']); return [{ bodyText: parent, bodyHtml: null }]; } } }, 'account', { inReplyTo: '<parent>', references: ['<parent>'] });
  assert.equal(currentEmailBody(text, null, parents), 'Here is my answer below the previous message.');
  assert.equal(currentEmailBody(`Current: ${parent}\n\nOn Wednesday, Alice wrote:\n${parent}`, null, parents), `Current: ${parent}`);
  assert.ok(text.includes(parent), 'Projection never modifies the original evidence');
});
test('thread navigation deduplicates stored copies and retains the open copy', async () => {
  const messages = ['a', 'copy-a', 'b', 'c'].map((id, i) => ({ id, rfcMessageId: i < 2 ? '<a>' : `<${id}>`, subject: 'Same thread', direction: 'inbound', sentAt: new Date(i), receivedAt: new Date(i) }));
  const db = { $queryRaw: async query => { assert.ok(query.strings.join('').includes('WITH RECURSIVE')); assert.ok(query.values.includes('account')); return messages; } };
  const middle = await emailThreadNavigation(db, 'account', 'b'); assert.equal(middle.previous.id, 'a'); assert.equal(middle.next.id, 'c'); assert.equal(middle.total, 3);
  const first = await emailThreadNavigation(db, 'account', 'copy-a'); assert.equal(first.previous, null); assert.equal(first.next.id, 'b'); assert.equal(first.position, 1);
});
test('readiness cannot complete delivery; English, Italian and Chinese performed actions can', async () => {
  for (const [title, evidence, valid] of [
    ['Send revised drawing', 'The revised drawing is ready; please send it.', false],
    ['Inviare il disegno', 'Il disegno è pronto; per favore invialo.', false],
    ['Send revised drawing', 'The drawing was sent; please pay the invoice.', true],
    ['Inviare il disegno', 'Ho inviato il disegno.', true],
    ['发送报价', '报价已发送。', true],
    ['发送报价', '报价已完成，请发送报价。', false],
    ['Send drawing to finance', 'The invoice was sent to finance.', false],
  ]) {
    const op = { ...operation('', evidence), action: 'complete', target_id: 'task', task_outcome: 'completed', changes: { ...operation('', '').changes, title: null, status: 'done' } };
    const errors = await validateAnalysisBusiness({ ...result, operations: [op] }, 'mail', evidence, async () => ({ exists: true, title }), { hasMessageDate: true, businessTimezone: 'Europe/Rome' });
    assert.equal(errors.length === 0, valid, `${title}: ${evidence}: ${errors.join(',')}`);
  }
});
function factRepository() {
  const tasks = []; const ledger = []; const reviews = []; const notifications = [];
  const message = { id: 'mail', projectId: null, topicId: null, threadId: null, sentAt: new Date(), receivedAt: new Date() };
  let run = { id: 'run-one', sourceMessageId: 'mail', sourceMessage: message, status: 'completed', schemaVersion: '3', validationStatus: 'valid', resultJson: { operations: [operation('Send quote', 'Please send the quotation.')] } };
  const db = {
    mailAccount: { findUnique: async () => ({ id: 'account' }) }, analysisRun: { findFirst: async () => run },
    emailMessage: { findFirst: async query => query.where.id === 'mail' ? message : null },
    businessOperation: {
      findFirst: async ({ where }) => ledger.find(item => where.OR.some(key => Object.entries(key).every(([name, value]) => item[name] === value))) ?? null,
      findUnique: async ({ where }) => ledger.find(item => item.operationId === where.operationId) ?? null,
      findMany: async ({ where }) => ledger.filter(item => Object.entries(where).every(([key, value]) => item[key] === value)),
      create: async ({ data }) => { ledger.push(data); return data; },
    },
    task: { create: async ({ data }) => { const row = { id: `task-${tasks.length}`, status: 'open', version: 1, ...data }; tasks.push(row); return row; }, findUniqueOrThrow: async ({ where }) => tasks.find(item => item.id === where.id) },
    agentEvent: { create: async ({ data }) => { notifications.push(data); return { id: 'event' }; } }, agentWakeupDelivery: { create: async () => ({}) },
    reviewItem: { upsert: async ({ create }) => { reviews.push(create); return create; } },
    $transaction: async work => work(db),
  };
  const records = new BusinessRecordsService(config, db, {}, {}, { recordBusinessMutation: async () => {} });
  return { records, db, tasks, ledger, reviews, notifications, run: value => { run = value; }, getRun: () => run };
}
test('confidence-only reanalysis reuses a fact without another notification; paraphrases enter review', async () => {
  const repo = factRepository();
  await repo.records.applyAnalysis('run-one', { operationId: 'apply-one', operationIndexes: [0] });
  const original = repo.getRun(); const op = original.resultJson.operations[0];
  repo.run({ ...original, id: 'run-two', resultJson: { operations: [{ ...op, confidence: .99 }] } });
  await repo.records.applyAnalysis('run-two', { operationId: 'apply-two', operationIndexes: [0] });
  assert.equal(repo.tasks.length, 1); assert.equal(repo.notifications.length, 1);
  repo.run({ ...original, id: 'run-three', resultJson: { operations: [{ ...op, changes: { ...op.changes, title: 'Provide the quote' }, evidence: 'Please send the quotation for review.' }] } });
  await assert.rejects(repo.records.applyAnalysis('run-three', { operationId: 'apply-three', operationIndexes: [0] }), conflict('FACT_REANALYSIS_REVIEW_REQUIRED'));
  assert.equal(repo.tasks.length, 1); assert.equal(repo.reviews.length, 1);
});
test('two distinct tasks in one message remain distinct and client keys still reject changed payloads', async () => {
  const repo = factRepository(); const first = repo.getRun();
  repo.run({ ...first, resultJson: { operations: [operation('Send quote', 'Please send the quotation.'), operation('Book transport', 'Please book transport for Friday.')] } });
  await repo.records.applyAnalysis('run-one', { operationId: 'batch', operationIndexes: [0, 1] });
  assert.equal(repo.tasks.length, 2);
  repo.run({ ...repo.getRun(), resultJson: { operations: [operation('Changed fact', 'Different evidence.')] } });
  await assert.rejects(repo.records.applyAnalysis('run-one', { operationId: 'batch', operationIndexes: [0] }), conflict('IDEMPOTENCY_KEY_REUSED'));
});
test('task PATCH validates the complete merged state and honors explicit null', async () => {
  const current = { id: 'task', title: 'Task', version: 1, projectId: 'old', topicId: 'topic', deadlineAt: null, deadlineDate: '2026-10-02', deadlineTimezone: 'Europe/Rome', status: 'open', waitingOn: 'none', waitingSince: null };
  let saved; let before;
  const db = { mailAccount: { findUnique: async () => ({ id: 'account' }) }, businessOperation: { findUnique: async () => null, findFirst: async () => null, create: async () => ({}) },
    project: { findFirst: async ({ where }) => ({ id: where.id }), findUnique: async ({ where }) => ({ id: where.id, status: 'active', version: 1 }) },
    topic: { findFirst: async () => ({ id: 'topic', projectId: 'old' }), findMany: async ({ where }) => where.id?.in?.includes('topic') ? [{ projectId: 'old' }] : [] },
    task: { findFirst: async () => current, updateMany: async ({ data }) => { saved = { ...current, ...data, version: 2 }; return { count: 1 }; }, findUniqueOrThrow: async () => saved },
    agentEvent: { create: async () => ({ id: 'event' }) }, agentWakeupDelivery: { create: async () => ({}) }, $queryRaw: async () => [], $transaction: async work => work(db) };
  const records = new BusinessRecordsService(config, db, {}, {}, { recordBusinessMutation: async (...args) => { before = args[7]; } });
  for (const data of [{ projectId: null }, { deadlineTimezone: null }, { deadlineAt: '2026-10-04T10:00:00Z' }, { deadlineDate: '2026-99-99' }]) await assert.rejects(records.updateTask('task', { operationId: 'invalid', expectedVersion: 1, ...data }), error => error.status === 400);
  assert.equal(saved, undefined);
  const detached = await records.updateTask('task', { operationId: 'detach', expectedVersion: 1, projectId: null, topicId: null });
  assert.equal(detached.projectId, null); assert.equal(detached.topicId, null); assert.equal(before.projectId, 'old');
  await records.updateTask('task', { operationId: 'topic-only', expectedVersion: 1, topicId: 'topic' });
});
test('task movement and detachment recompute the former project in the same transaction', async () => {
  for (const next of ['new', null]) {
    const changes = [];
    const tx = { $queryRaw: async () => [], timelineEvent: { create: async () => ({}) }, project: { findUnique: async ({ where }) => ({ id: where.id, status: 'active', version: 1, waitingOn: 'us', waitingParties: ['us'], replyRequired: true, followUpAt: null }), updateMany: async ({ where, data }) => { changes.push({ id: where.id, ...data }); return { count: 1 }; } }, task: { findMany: async ({ where }) => where.projectId === 'old' ? [] : [{ status: 'open', kind: 'action', ownerType: 'customer', waitingOn: 'customer', deadlineAt: null }] } };
    const summaries = new SummaryTimelineService(config, {});
    await summaries.recordBusinessMutation(tx, 'task', 'update', { id: 'task', projectId: next }, null, 'move', undefined, { projectId: 'old' });
    assert.ok(changes.some(item => item.id === 'old' && item.waitingOn === 'none' && !item.replyRequired));
    if (next) assert.ok(changes.some(item => item.id === 'new' && item.waitingOn === 'customer'));
  }
});
test('summary application cannot relabel stale model input as a fresh version', async () => {
  const run = { status: 'completed', validationStatus: 'valid', resultJson: { summary: 'Old model proposal' }, sourceMessage: { id: 'mail', projectId: 'project', sentAt: new Date() }, inputSummaryJson: { summaryInputVersions: [{ entityType: 'project', entityId: 'project', version: 0 }] } };
  const db = { mailAccount: { findUnique: async () => ({ id: 'account' }) }, analysisRun: { findFirst: async () => run }, businessOperation: { findUnique: async () => null }, $transaction: async work => work(db) };
  const service = new SummaryTimelineService(config, db);
  await assert.rejects(service.applyAnalysisSummary('run', { operationId: 'stale', entityType: 'project', entityId: 'project', expectedVersion: 2 }), conflict('SUMMARY_INPUT_STALE'));
  run.inputSummaryJson = {};
  await assert.rejects(service.applyAnalysisSummary('run', { operationId: 'legacy', entityType: 'project', entityId: 'project', expectedVersion: 0 }), conflict('SUMMARY_INPUT_STALE'));
  const context = buildAnalysisContext({ current: { id: 'mail', date: null, direction: 'inbound', from: [], subject: null, text: 'Body' }, recent: [], contact: null, company: null, projects: [], currentProject: null, currentTopic: null, priorSummaries: [{ entityType: 'thread', entityId: '<root>', version: 0, summary: null }], businessTimezone: 'Europe/Rome', maxChars: 5000 });
  assert.equal(context.summary.summaryInputVersions[0].version, 0);
});
function analysisRepository(initial = null, messageOverrides = {}) {
  let row = initial; let next = 0;
  const copy = value => value && structuredClone(value);
  const message = { id: 'mail', threadId: null, direction: 'inbound', subject: 'Quote', bodyText: null, bodyHtml: '<p>Please send the quotation</p><blockquote>OLD HISTORY</blockquote>', headersJson: {}, fromJson: [], toJson: [], classification: 'BUSINESS_HUMAN', classificationManualOverride: false, receivedAt: new Date(), sentAt: new Date(), contactId: null, companyId: null, projectId: null, topicId: null, contact: null, company: null, project: null, topic: null, ...messageOverrides };
  const matches = where => row && (!where.id || row.id === where.id) && (!where.status || row.status === where.status) && (!('leaseToken' in where) || row.leaseToken === where.leaseToken) && (!where.leaseExpiresAt?.gt || row.leaseExpiresAt > where.leaseExpiresAt.gt) && (!where.OR || (row.status === 'processing' && (!row.leaseExpiresAt || row.leaseExpiresAt <= new Date())) || (row.status === 'failed' && row.errorCode === 'AI_ANALYSIS_INTERRUPTED'));
  const db = { mailAccount: { findUnique: async () => ({ id: 'account' }) }, emailMessage: { findFirst: async () => message, findUnique: async () => message },
    analysisRun: { findUnique: async () => copy(row), findUniqueOrThrow: async () => copy(row), findFirst: async () => copy(row), findMany: async () => [],
      create: async ({ data }) => { assert.equal(row, null); row = { id: `run-${++next}`, ...data }; return copy(row); },
      updateMany: async ({ where, data }) => { if (!matches(where)) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    }, $queryRaw: async () => [], $transaction: async work => work(db) };
  return { db, row: () => row };
}
test('HTML-only analysis recovers an expired attempt using the same operation ID', async () => {
  const repo = analysisRepository({ id: 'interrupted', sourceMessageId: 'mail', status: 'processing', leaseToken: 'old', leaseExpiresAt: new Date(0) });
  let prompt;
  const analyzer = new EmailAnalyzerService(config, repo.db, { name: 'fixture', model: 'fixture', generateStructured: async value => { prompt = value; return result; } }, systemMailSenders);
  const run = await analyzer.analyze('mail', 'same-key'); assert.equal(run.id, 'interrupted'); assert.equal(run.status, 'completed'); assert.equal(run.validationStatus, 'valid');
  assert.ok(prompt.includes('Please send the quotation')); assert.ok(!prompt.includes('OLD HISTORY')); assert.ok(!prompt.includes('<p>'));
});
test('a late analysis worker cannot overwrite a recovered result', async () => {
  const repo = analysisRepository(); let release; let entered; let calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const analyzer = new EmailAnalyzerService(config, repo.db, { name: 'fixture', model: 'fixture', generateStructured: async () => { if (++calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); return { ...result, summary: 'Late old proposal' }; } return { ...result, summary: 'Recovered proposal' }; } }, systemMailSenders);
  const old = analyzer.analyze('mail', 'same-key'); await started; repo.row().leaseExpiresAt = new Date(0);
  await analyzer.analyze('mail', 'same-key'); release(); await assert.rejects(old, conflict('ANALYSIS_LEASE_LOST'));
  assert.equal(repo.row().status, 'completed'); assert.equal(repo.row().resultJson.summary, 'Recovered proposal');
});
test('importance triage reads legacy HTML through the same current-content projection', async () => {
  let prompt;
  const db = { emailMessage: { findUnique: async () => ({ id: 'mail', mailAccountId: 'account', direction: 'inbound', classification: 'BUSINESS_HUMAN', classificationManualOverride: false, historicalImport: false, receivedAt: new Date(), bodyText: null, bodyHtml: '<p>Please send us a quote.</p><blockquote>OLD HISTORY</blockquote>', headersJson: {}, fromJson: [], subject: 'Quotation' }) } };
  const service = new EmailImportanceTriageService(db, config, { name: 'fixture', model: 'fixture', generateStructured: async value => { prompt = value; return { schema_version: '1', importance: 'high', intent: 'customer_inquiry', confidence: .95, reason: 'Quote requested.', evidence: ['Please send us a quote.'], review_required: false }; } }, { canonicalMailId: async (_tx, id) => id }, systemMailSenders);
  service.finish = async (_item, verdict) => verdict.status;
  assert.equal(await service.processOne({ id: 'triage', sourceMessageId: 'mail', source: 'realtime', attempts: 1, maxAttempts: 3 }), 'high');
  assert.ok(prompt.includes('Please send us a quote.')); assert.ok(!prompt.includes('OLD HISTORY'));
});
test('expired status reads become visible interrupted failures rather than permanent processing', async () => {
  const repo = analysisRepository({ id: 'run', sourceMessageId: 'mail', status: 'processing', leaseToken: 'old', leaseExpiresAt: new Date(0) });
  const analyzer = new EmailAnalyzerService(config, repo.db, {}, systemMailSenders);
  const run = await analyzer.getRun('run'); assert.equal(run.status, 'failed'); assert.equal(run.errorCode, 'AI_ANALYSIS_INTERRUPTED');
});
test('configured system From is blocked before analysis; recipient matches do not count', async () => {
  const repo = analysisRepository(null, { fromJson: [{ address: ' OPS@Example.Test ' }] });
  let calls = 0;
  const analyzer = new EmailAnalyzerService(config, repo.db, { name: 'fixture', model: 'fixture', generateStructured: async () => { calls++; return result; } }, systemMailSenders);
  await assert.rejects(analyzer.analyze('mail', 'system-mail'), error => error.status === 409 && error.response.code === 'SYSTEM_SENDER_AI_BLOCKED');
  assert.equal(calls, 0, 'configured sender never reaches the provider');
  assert.equal(await isConfiguredSystemSender('inbound', [{ address: 'customer@example.test' }], systemMailSenders.matchSystemSenderAddresses), false, 'a configured recipient address does not disable AI');
  assert.equal(await isConfiguredSystemSender('outbound', [{ address: 'ops@example.test' }], systemMailSenders.matchSystemSenderAddresses), false, 'outbound mail is outside the configured sender gate');
});
test('configuration added while single-message AI runs discards the late result', async () => {
  let registered = false; let calls = 0;
  const repo = analysisRepository(null, { fromJson: [{ address: 'ops@example.test' }] });
  const liveSenderMatcher = { matchSystemSenderAddresses: async addresses => registered && addresses.some(address => address.trim().toLowerCase() === 'ops@example.test') ? ['ops@example.test'] : [] };
  const analyzer = new EmailAnalyzerService(config, repo.db, { name: 'fixture', model: 'fixture', generateStructured: async () => { calls++; registered = true; return result; } }, liveSenderMatcher);
  await assert.rejects(analyzer.analyze('mail', 'system-added-in-flight'), error => error.status === 409 && error.response.code === 'SYSTEM_SENDER_AI_BLOCKED');
  assert.equal(calls, 1); assert.equal(repo.row().status, 'failed'); assert.equal(repo.row().errorCode, 'SYSTEM_SENDER_AI_BLOCKED');
});
test('Italian automatic responses and temporary delivery failures keep their proper classes', () => {
  const input = (subject, from, body, extra = '') => ({ subject, direction: 'inbound', fromJson: [{ address: from }], toJson: [], bodyText: body, rawSource: Buffer.from(`From: ${from}\r\nSubject: ${subject}\r\n${extra}\r\n${body}`) });
  assert.equal(classifyMail(input('Risposta automatica: richiesta preventivo', 'alice@test.invalid', 'Sono fuori ufficio fino al 10 ottobre.')).classification, 'OUT_OF_OFFICE');
  assert.equal(classifyMail(input('Risposta automatica: richiesta preventivo', 'alice@test.invalid', 'Sono assente.', 'Auto-Submitted: auto-replied\r\n')).classification, 'OUT_OF_OFFICE');
  assert.equal(classifyMail(input('Re: richiesta preventivo', 'alice@test.invalid', 'Il collega è fuori ufficio. Ti invio il preventivo.')).classification, 'BUSINESS_HUMAN');
  assert.equal(classifyMail(input('Temporary delivery failure', 'mailer-daemon@test.invalid', 'Retrying delivery')).classification, 'DELIVERY_DELAY');
  assert.equal(classifyMail(input('Permanent delivery failure', 'mailer-daemon@test.invalid', 'Recipient does not exist')).classification, 'DELIVERY_FAILURE');
});
(async () => {
  let failures = 0;
  for (const { name, run } of tests) { try { await run(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); } }
  console.log(JSON.stringify({ passed: tests.length - failures, failed: failures, productionWrites: 0 })); if (failures) process.exitCode = 1;
})();
