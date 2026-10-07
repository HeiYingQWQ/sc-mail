// Read-only live checks. The optional model call contains only a synthetic connectivity prompt.
const assert = require('node:assert/strict');
const { OpenAIResponsesProvider } = require(process.cwd() + '/dist/modules/ai/openai-responses.provider.js');
(async () => {
  const results = {};
  const get = async (path, timeoutMs = 15000) => {
    const response = await fetch(`http://127.0.0.1:3000${path}`, { headers: { authorization: `Bearer ${process.env.IMAP_API_TOKEN}` }, signal: AbortSignal.timeout(timeoutMs) });
    assert.equal(response.status, 200, path); return response.json();
  };
  results.health = (await get('/health')).status;
  const mail = await get('/api/v1/mail/status'); results.mail = { configured: mail.configured, status: mail.account?.status ?? mail.status, lastErrorCode: mail.account?.lastErrorCode ?? null };
  const sync = await get('/api/v1/mail/sync/status'); results.sync = { folders: sync.folders.length, failed: sync.folders.filter(f => f.lastErrorCode).map(f => ({ mailbox: f.mailbox, status: f.status, lastErrorCode: f.lastErrorCode })), latestSuccess: sync.folders.map(f => f.lastSuccessfulSyncAt).filter(Boolean).sort().at(-1), queue: sync.queue, deletionSync: sync.deletionSync };
  const initial = await get('/api/v1/mail/sync/initial'); results.initial = { folders: initial.folders.length, completed: initial.folders.filter(f => f.status === 'completed').length };
  const reconciliation = await get('/api/v1/mail/reconciliation/status'); results.reconciliation = { status: reconciliation.checkpoint?.status, lastErrorCode: reconciliation.checkpoint?.lastErrorCode };
  for (const path of ['tasks','requirements','decisions','projects','crm/contacts','crm/companies','reviews']) results[path] = { total: (await get(`/api/v1/mail/${path}`)).total };
  const brief = await get('/api/v1/mail/brief?date=today'); results.brief = { timezone: brief.timezone, total: brief.total, truncated: brief.truncated };
  const integration = await get('/api/v1/mail/integrations/status'); results.integrations = { eventWakeup: integration.eventWakeup.configured, telegram: integration.telegram.configured, pollingEnabled: integration.telegram.pollingEnabled };
  console.log(JSON.stringify({ liveReadChecks: results }));
  if (process.env.LIVE_LEGACY_AUDIT === 'true') {
    const audit = await get('/api/v1/mail/sync/deletion/legacy-audit', 180000);
    console.log(JSON.stringify({ legacyAudit: audit }));
  }
  if (process.env.ACCEPTANCE_MODEL_SMOKE === 'true') {
    const config = { get: (key, fallback) => process.env[key] || fallback };
    const provider = new OpenAIResponsesProvider(config);
    const output = await provider.generateStructured('Synthetic connectivity check. Return exactly {"ok":true}. There is no email to analyze.', { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }, { timeoutMs: 60000, retryCount: 0 });
    assert.deepEqual(output, { ok: true }); console.log(JSON.stringify({ modelSmoke: 'passed', model: provider.model, reasoningEffort: config.get('AI_REASONING_EFFORT') }));
  }
})().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.name, message: String(error.message).slice(0, 300) })); process.exitCode = 1; });
