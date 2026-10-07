const assert = require('node:assert/strict');
const { EmailImportanceTriageService } = require('../dist/modules/mail/email-importance-triage.service.js');
const { AIProviderError } = require('../dist/modules/ai/ai-provider.js');

// Advance a simulated clock instead of waiting for model calls. No database or
// provider connection is created by these repository and provider fixtures.
const RealDate = Date;
let now = RealDate.parse('2026-09-30T10:00:00Z');
class FixtureDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const config = { get: (_key, fallback) => fallback };
const projectAnalysis = { canonicalMailId: async (_tx, id) => id };
const systemMailSenders = { matchSystemSenderAddresses: async () => [] };
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && !(value instanceof RealDate)) {
      if ('gt' in value) return row[key] > value.gt;
      if ('lte' in value) return row[key] <= value.lte;
      throw new Error(`Unsupported fixture filter ${key}`);
    }
    return row[key] === value;
  });
}
function repository(count) {
  const rows = Array.from({ length: count }, (_, index) => ({ id: `triage-${index}`, sourceMessageId: `message-${index}`,
    source: 'realtime', status: 'pending', attempts: 0, maxAttempts: 3, createdAt: new Date(now + index),
    nextAttemptAt: new Date(now), leaseToken: null, leaseExpiresAt: null }));
  const message = { direction: 'inbound', mailAccountId: 'account', classification: 'BUSINESS_HUMAN', classificationManualOverride: false,
    receivedAt: new Date(now - 60000), sentAt: new Date(now - 60000), reviewRequired: false, senderRuleSnapshot: null,
    subject: 'Project update', fromJson: [{ address: 'client@example.test' }], bodyText: 'Everything is on schedule. No action is needed.', classificationReason: 'Business mail' };
  const claimedLimits = [];
  function apply(row, data) { for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value; }
  const tx = {
    emailImportanceTriage: {
      updateMany: async ({ where, data }) => { const selected = rows.filter((row) => matches(row, where)); selected.forEach((row) => apply(row, data)); return { count: selected.length }; },
      update: async ({ where, data }) => { const row = rows.find((item) => item.id === where.id); assert.ok(row); apply(row, data); return { ...row }; },
      findFirst: async ({ where }) => rows.find((row) => matches(row, where)) ?? null,
    },
    emailMessage: { findUnique: async ({ where }) => ({ ...message, id: where.id }) },
    agentEvent: { createMany: async () => assert.fail('Quiet model result must not create an event') },
    $executeRaw: async () => { let changed = 0; for (const row of rows) if (row.status === 'pending' && row.attempts >= row.maxAttempts) { row.status = 'failed'; changed++; } return changed; },
    $queryRaw: async (query) => {
      if (!query.sql.includes('FROM "EmailImportanceTriage"')) return [];
      const limit = query.values[query.values.length - 1]; claimedLimits.push(limit);
      return rows.filter((row) => row.status === 'pending' && row.nextAttemptAt <= new Date() && row.attempts < row.maxAttempts).slice(0, limit).map((row) => ({ id: row.id, sourceMessageId: row.sourceMessageId }));
    },
  };
  let tail = Promise.resolve();
  const db = { ...tx, $transaction(callback) {
    const result = tail.then(() => callback(tx)); tail = result.catch(() => undefined); return result;
  } };
  return { db, rows, claimedLimits };
}
const quietResult = { schema_version: '1', importance: 'normal', intent: 'routine', confidence: 0.95,
  reason: 'The customer reported normal progress without an action request.', evidence: ['No action is needed.'], review_required: false };
async function main() {
  global.Date = FixtureDate;
  let passed = 0;
  try {
    {
      const repo = repository(5); let calls = 0;
      const provider = { name: 'fixture', model: 'slow-model', async generateStructured(_prompt, _schema, options) {
        assert.equal(options.retryCount, 0); assert.equal(options.timeoutMs, 60000);
        assert.equal(repo.rows.filter((row) => row.status === 'processing').length, 1, 'Only the current row may be leased');
        calls++; now += 55_000; return quietResult;
      } };
      const result = await new EmailImportanceTriageService(repo.db, config, provider, projectAnalysis, systemMailSenders).processBatch(5);
      assert.equal(calls, 5); assert.equal(result.claimed, 5); assert.equal(result.quiet, 5); assert.equal(result.leaseLost, 0);
      assert.ok(repo.rows.every((row) => row.status === 'quiet' && row.attempts === 1 && row.leaseToken === null));
      assert.deepEqual(repo.claimedLimits, [1, 1, 1, 1, 1]); passed++;
    }
    {
      const repo = repository(1);
      const provider = { name: 'fixture', model: 'lost-lease', async generateStructured() { now += 121_000; return quietResult; } };
      const service = new EmailImportanceTriageService(repo.db, config, provider, projectAnalysis, systemMailSenders);
      const result = await service.processBatch(1);
      assert.equal(result.claimed, 1); assert.equal(result.leaseLost, 1); assert.equal(result.quiet, 0); assert.equal(result.failed, 0);
      assert.equal(repo.rows[0].status, 'processing');
      provider.generateStructured = async () => quietResult;
      const recovered = await service.processBatch(1);
      assert.equal(recovered.quiet, 1); assert.equal(repo.rows[0].attempts, 2); passed++;
    }
    {
      const repo = repository(1);
      const provider = { name: 'fixture', model: 'timeout', async generateStructured() { throw new AIProviderError('AI_TIMEOUT', 'Fixture timeout'); } };
      const service = new EmailImportanceTriageService(repo.db, config, provider, projectAnalysis, systemMailSenders);
      const result = await service.processBatch(1);
      assert.equal(result.pending, 1); assert.equal(result.failed, 0); assert.equal(result.leaseLost, 0);
      assert.equal(repo.rows[0].status, 'pending'); assert.equal(repo.rows[0].leaseToken, null); passed++;
    }
    {
      const repo = repository(1);
      const provider = { name: 'fixture', model: 'expired-timeout', async generateStructured() { now += 121_000; throw new AIProviderError('AI_TIMEOUT', 'Fixture timeout'); } };
      const result = await new EmailImportanceTriageService(repo.db, config, provider, projectAnalysis, systemMailSenders).processBatch(1);
      assert.equal(result.leaseLost, 1); assert.equal(result.pending, 0); assert.equal(repo.rows[0].status, 'processing'); passed++;
    }
    {
      const repo = repository(2); const releases = []; let bothEntered;
      const entered = new Promise((resolve) => { bothEntered = resolve; });
      const provider = { name: 'fixture', model: 'parallel', async generateStructured() {
        return new Promise((resolve) => { releases.push(resolve); if (releases.length === 2) bothEntered(); });
      } };
      const one = new EmailImportanceTriageService(repo.db, config, provider, projectAnalysis, systemMailSenders).processBatch(1);
      const two = new EmailImportanceTriageService(repo.db, config, provider, projectAnalysis, systemMailSenders).processBatch(1);
      await entered;
      assert.ok(repo.rows.every((row) => row.status === 'processing' && row.attempts === 1));
      assert.notEqual(repo.rows[0].leaseToken, repo.rows[1].leaseToken);
      releases.forEach((resolve) => resolve(quietResult));
      assert.equal((await one).quiet, 1); assert.equal((await two).quiet, 1); passed++;
    }
    {
      const repo = repository(1); const service = new EmailImportanceTriageService(repo.db, config, {}, projectAnalysis, systemMailSenders);
      await assert.rejects(service.processBatch(0), /Invalid triage batch size/);
      await assert.rejects(service.processBatch(21), /Invalid triage batch size/);
      assert.equal(repo.rows[0].attempts, 0); passed++;
    }
    for (const output of [{ ...quietResult, importance: '3' }, { ...quietResult, confidence: '95%' }, { ...quietResult, schema_version: 1 }]) {
      const repo = repository(1);
      const service = new EmailImportanceTriageService(repo.db, config, {name:'fixture',model:'invalid',generateStructured:async()=>output}, projectAnalysis, systemMailSenders);
      for (let attempt=1;attempt<=3;attempt++) {
        await service.processBatch(1); now+=120_000;
      }
      assert.equal(repo.rows[0].status,'review'); assert.equal(repo.rows[0].importance,'uncertain');
      assert.equal(repo.rows[0].lastErrorCode,'TRIAGE_OUTPUT_SCHEMA_INVALID');
      assert.match(repo.rows[0].reason,/Output validation:/); passed++;
    }
    console.log(`Triage lease fixtures passed: ${passed}; production writes: 0`);
  } finally { global.Date = RealDate; }
}
const watchdog = setTimeout(() => { console.error('Triage lease fixture timed out'); process.exitCode = 1; }, 10_000);
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
