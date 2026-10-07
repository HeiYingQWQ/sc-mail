const assert = require('node:assert/strict');
const { InitialSyncService, SyncCheckpointChangedError } = require('../dist/modules/mail/initial-sync.service.js');
const { RealtimeSyncService } = require('../dist/modules/mail/realtime-sync.service.js');
const { EmailNormalizer } = require('../dist/modules/mail/email-normalizer.js');

// In-memory repository fixtures only. This script never opens PostgreSQL or IMAP.
const logger = { info() {}, warn() {}, error() {} };
const email = 'owner@example.test';
const config = { get: (key, fallback) => ({ IMAP_EMAIL: email, IMAP_SYNC_FOLDERS: 'INBOX,Sent,Archive', IMAP_SYNC_PAGE_SIZE: 1 }[key] ?? fallback) };
const copy = (value) => structuredClone(value);
function checkpoint(mailbox, overrides = {}) {
  return { id: mailbox, mailAccountId: 'account', mailbox, status: 'failed', uidValidity: 10n, targetUid: 12, lastUid: 10,
    fromDate: new Date('2025-09-30T10:00:00Z'), throughDate: new Date('2026-09-30T10:00:00Z'),
    updatedAt: new Date(Date.now() - 20 * 60_000), scannedCount: 0, importedCount: 0, reconciliationRequired: false,
    lastErrorCode: 'INITIAL_SYNC_FAILED', ...overrides };
}
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((entry) => matches(row, entry));
    if (key === 'mailAccountId_mailbox') return matches(row, value);
    if (value instanceof Date) return row[key]?.getTime() === value.getTime();
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('lte' in value) return row[key] <= value.lte;
      throw new Error(`Unsupported fixture filter ${key}`);
    }
    return row[key] === value;
  });
}
function repository(rows) {
  const checkpoints = rows.map(copy);
  const messages = [];
  let writes = 0;
  function apply(row, data) {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : copy(value);
    }
    if (!data.updatedAt) row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
    return copy(row);
  }
  const db = {
    mailAccount: { findUnique: async ({ where }) => { assert.equal(where.email, email); return { id: 'account', email }; } },
    syncCheckpoint: {
      findMany: async ({ where }) => checkpoints.filter((row) => matches(row, where)).sort((a, b) => a.mailbox.localeCompare(b.mailbox)).map(copy),
      findUniqueOrThrow: async ({ where }) => { const row = checkpoints.find((item) => matches(item, where)); assert.ok(row); return copy(row); },
      updateMany: async ({ where, data }) => { const rows = checkpoints.filter((item) => matches(item, where)); rows.forEach((row) => apply(row, data)); return { count: rows.length }; },
      update: async ({ where, data }) => { const row = checkpoints.find((item) => matches(item, where)); assert.ok(row); return apply(row, data); },
    },
    $queryRaw: async () => [],
    mailDeletionTombstone: { findUnique: async () => null },
    emailMessage: {
      findUnique: async ({ where }) => copy(messages.find((item) => where.id ? item.id === where.id : item.providerMessageId === where.mailAccountId_providerMessageId.providerMessageId) ?? null),
      findFirst: async ({ where }) => copy(messages.find((item) => item.rfcMessageId === where.rfcMessageId) ?? null),
      create: async ({ data }) => { const row = { id: `message-${messages.length + 1}`, classificationManualOverride: false, senderRuleSnapshot: null, ...data }; messages.push(row); writes++; return copy(row); },
      update: async ({ where, data }) => { const row = messages.find((item) => item.id === where.id); assert.ok(row); Object.assign(row, data); writes++; return copy(row); },
      findUniqueOrThrow: async ({ where }) => { const row = messages.find((item) => item.id === where.id); assert.ok(row); return copy(row); },
    },
    processingRecord: { upsert: async () => ({}) },
    emailImportanceTriage: { upsert: async () => { throw new Error('Historical recovery must not enqueue AI triage'); } },
    agentEvent: { upsert: async () => { throw new Error('Historical recovery must not create Agent events'); } },
    agentWakeupDelivery: { upsert: async () => { throw new Error('Historical recovery must not wake an Agent'); } },
  };
  db.$transaction = async (callback) => callback(db);
  return { db, checkpoints, messages, writes: () => writes };
}
const noRules = { snapshotForNewMessage: async () => { throw new Error('Initial historical recovery must stay silent'); } };
const noSystemSenders = { matchSystemSenderAddresses: async () => [] };
function initial(repo, imap, senderRules = noRules, projectAnalysis = { canonicalMailId: async (_tx, id) => id, enqueueIncoming: async () => null }, systemMailSenders = noSystemSenders) { return new InitialSyncService(config, repo.db, imap, new EmailNormalizer(), senderRules, projectAnalysis, logger, systemMailSenders); }
function page(overrides = {}) { return { uidValidity: 10n, targetUid: 12, throughDate: new Date('2026-09-30T10:00:00Z'), messages: [], nextUid: 12, hasMore: false, ...overrides }; }
function wire(uid, { from = 'Client <client@example.test>', subject = 'Project inquiry', body = 'Please send the revised quotation.' } = {}) {
  const text = `From: ${from}\r\nTo: ${email}\r\nSubject: ${subject}\r\nMessage-ID: <sync-recovery-${uid}@example.test>\r\nDate: Wed, 30 Sep 2026 10:00:00 +0000\r\n\r\n${body}\r\n`;
  return { uid, receivedAt: new Date('2026-09-30T10:00:00Z'), rawSourceBase64: Buffer.from(text).toString('base64') };
}
async function main() {
  let passed = 0;
  for (const status of ['pending', 'failed', 'interrupted', 'in_progress']) {
    const repo = repository([checkpoint('INBOX', { status })]);
    const calls = [];
    const service = initial(repo, { fetchPage: async (...args) => { calls.push(args); return page({ messages: [wire(12)] }); } });
    await service.resumeFolder('account', email, 'INBOX', 'INBOX', 20);
    assert.equal(calls.length, 1); assert.equal(calls[0][3], 10); assert.equal(calls[0][5], 12);
    assert.equal(repo.checkpoints[0].status, 'completed'); assert.equal(repo.checkpoints[0].lastUid, 12);
    assert.equal(repo.checkpoints[0].targetUid, null); assert.equal(repo.checkpoints[0].lastErrorCode, null);
    assert.equal(repo.messages.length, 1); assert.ok(repo.checkpoints[0].lastSuccessfulSyncAt); passed++;
    assert.equal(repo.messages[0].historicalImport, true);
    await service.persistPage({ accountId: 'account', accountEmail: email, mailbox: 'INBOX', uidValidity: 10n,
      messages: [{ ...wire(12), rawSource: Buffer.from(wire(12).rawSourceBase64, 'base64') }], nextUid: 12, hasMore: false,
      auditOnly: true, importanceTriageSource: 'reconciliation', importanceTriageCatchupCutoff: new Date('2026-09-29T10:00:00Z') });
    assert.equal(repo.messages.length, 1); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX')]);
    const incoming = wire(13, { from: 'Operations <ops@example.test>', subject: 'Unrelated greeting', body: 'Hello, hope you are well.' });
    let enqueueCalls = 0; let eventCalls = 0; let triageCalls = 0;
    repo.db.agentEvent.upsert = async () => { eventCalls++; throw new Error('Configured system sender must not create an event'); };
    repo.db.agentWakeupDelivery.upsert = async () => { throw new Error('Configured system sender must not create a wakeup'); };
    repo.db.emailImportanceTriage.upsert = async () => { triageCalls++; throw new Error('Configured system sender must not enter AI triage'); };
    const senderRules = { snapshotForNewMessage: async () => ({ action: 'whitelist', matchedRule: { matchType: 'email', pattern: 'ops@example.test' } }) };
    const projectAnalysis = { canonicalMailId: async (_tx, id) => id, enqueueIncoming: async () => { enqueueCalls++; return null; } };
    const systemMailSenders = { matchSystemSenderAddresses: async addresses => addresses.filter(address => address.trim().toLowerCase() === 'ops@example.test') };
    const service = initial(repo, {}, senderRules, projectAnalysis, systemMailSenders);
    await service.persistPage({ accountId: 'account', accountEmail: email, mailbox: 'INBOX', uidValidity: 10n,
      messages: [{ ...incoming, rawSource: Buffer.from(incoming.rawSourceBase64, 'base64') }], nextUid: 13, hasMore: false,
      checkpointId: 'INBOX', emitAgentEvents: true });
    assert.equal(repo.messages.length, 1);
    assert.equal(repo.messages[0].classification, 'SYSTEM_NOTIFICATION', 'configured From overrides an ordinary topic and sender whitelist');
    assert.match(repo.messages[0].classificationReason, /Configured system sender/);
    assert.equal(repo.messages[0].historicalImport, false, 'realtime system mail is still persisted as a live mail row');
    assert.equal(eventCalls, 0); assert.equal(triageCalls, 0); assert.equal(enqueueCalls, 0);
    passed++;
  }
  {
    const repo = repository([checkpoint('INBOX', { status: 'in_progress', updatedAt: new Date() })]);
    const service = initial(repo, { fetchPage: async () => assert.fail('Active page was stolen') });
    await service.resumeFolder('account', email, 'INBOX', 'INBOX', 20);
    assert.equal(repo.checkpoints[0].status, 'in_progress'); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX')]); let release; let entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const service = initial(repo, { fetchPage: async () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
    const first = service.resumeFolder('account', email, 'INBOX', 'INBOX', 20);
    await waiting;
    await service.resumeFolder('account', email, 'INBOX', 'INBOX', 20);
    assert.equal(repo.writes(), 0);
    // A recovered owner advances the version while the first network call is stuck.
    Object.assign(repo.checkpoints[0], { status: 'completed', lastUid: 99, updatedAt: new Date(repo.checkpoints[0].updatedAt.getTime() + 1) });
    release(page({ messages: [wire(12)] })); await first;
    assert.equal(repo.checkpoints[0].lastUid, 99); assert.equal(repo.checkpoints[0].status, 'completed');
    assert.equal(repo.writes(), 0); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX')]); const calls = [];
    const service = initial(repo, { fetchPage: async (...args) => { calls.push(args); return calls.length === 1 ? page({ messages: [wire(11)], nextUid: 11, hasMore: true }) : page({ messages: [wire(12)] }); } });
    await service.resumeFolder('account', email, 'INBOX', 'INBOX', 1);
    assert.equal(repo.checkpoints[0].status, 'pending'); assert.equal(repo.checkpoints[0].lastUid, 11);
    await service.resumeFolder('account', email, 'INBOX', 'INBOX', 1);
    assert.equal(calls[1][3], 11); assert.equal(calls[1][5], 12);
    assert.equal(calls[0][1].getTime(), calls[1][1].getTime()); assert.equal(calls[0][2].getTime(), calls[1][2].getTime());
    assert.equal(repo.checkpoints[0].status, 'completed'); assert.equal(repo.messages.length, 2); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX', { status: 'completed' }), checkpoint('Sent', { status: 'completed' })]);
    const attempted = [];
    const imap = { fetchIncrementalPage: async (_account, mailbox) => { attempted.push(mailbox); if (mailbox === 'INBOX') throw new Error('fixture unavailable folder'); return page(); } };
    const service = new RealtimeSyncService(config, repo.db, imap, initial(repo, imap), {}, logger);
    await assert.rejects(service.syncConfiguredFolders(), /1 IMAP folder/);
    assert.deepEqual(attempted, ['INBOX', 'Sent']);
    assert.equal(repo.checkpoints[0].lastErrorCode, 'INCREMENTAL_SYNC_FAILED'); assert.ok(repo.checkpoints[1].lastSuccessfulSyncAt); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX'), checkpoint('Sent', { status: 'completed' })]); const calls = [];
    const imap = { fetchPage: async (mailbox) => { calls.push(`initial:${mailbox}`); return page({ messages: [wire(12)] }); }, fetchIncrementalPage: async (_account, mailbox) => { calls.push(`incremental:${mailbox}`); return page(); } };
    const service = new RealtimeSyncService(config, repo.db, imap, initial(repo, imap), {}, logger);
    await service.syncConfiguredFolders();
    assert.deepEqual(calls, ['initial:INBOX', 'incremental:Sent']); assert.ok(repo.checkpoints.every((item) => item.status === 'completed')); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX')]);
    const service = initial(repo, { fetchPage: async () => { throw new Error('fixture network failure'); } });
    await assert.rejects(service.resumeFolder('account', email, 'INBOX', 'INBOX', 20), /network failure/);
    assert.equal(repo.checkpoints[0].status, 'failed'); assert.equal(repo.checkpoints[0].lastUid, 10);
    assert.equal(repo.checkpoints[0].lastErrorCode, 'INITIAL_SYNC_FAILED'); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX'), checkpoint('Sent', { status: 'completed' })]); const calls = [];
    const imap = { fetchPage: async (mailbox) => { calls.push(`initial:${mailbox}`); throw new Error('fixture initial failure'); }, fetchIncrementalPage: async (_account, mailbox) => { calls.push(`incremental:${mailbox}`); return page(); } };
    const service = new RealtimeSyncService(config, repo.db, imap, initial(repo, imap), {}, logger);
    await assert.rejects(service.syncConfiguredFolders(), /1 IMAP folder/);
    assert.deepEqual(calls, ['initial:INBOX', 'incremental:Sent']); assert.equal(repo.checkpoints[0].status, 'failed');
    assert.equal(repo.checkpoints[0].lastErrorCode, 'INITIAL_SYNC_FAILED'); assert.ok(repo.checkpoints[1].lastSuccessfulSyncAt); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX')]); const calls = [];
    const service = initial(repo, { fetchPage: async (...args) => { calls.push(args); return page({ uidValidity: 20n, targetUid: 5, nextUid: 5, messages: [wire(5)] }); } });
    await service.resumeFolder('account', email, 'INBOX', 'INBOX', 20);
    assert.equal(calls.length, 2); assert.equal(calls[0][3], 10); assert.equal(calls[1][3], 0);
    assert.equal(calls[1][5], 5); assert.equal(repo.checkpoints[0].uidValidity, 20n);
    assert.equal(repo.checkpoints[0].lastUid, 5); assert.equal(repo.messages.length, 1); passed++;
  }
  {
    const repo = repository([checkpoint('INBOX', { status: 'completed' })]);
    const oldVersion = new Date(repo.checkpoints[0].updatedAt.getTime() - 1);
    await assert.rejects(initial(repo, {}).persistPage({ accountId: 'account', accountEmail: email, checkpointId: 'INBOX', mailbox: 'INBOX', expectedCheckpointUpdatedAt: oldVersion, uidValidity: 10n, messages: [], nextUid: 1, hasMore: false }), SyncCheckpointChangedError);
    assert.equal(repo.checkpoints[0].lastUid, 10); passed++;
  }
  console.log(`Sync recovery fixtures passed: ${passed}; production writes: 0`);
}
const watchdog = setTimeout(() => { console.error('Sync recovery fixture timed out'); process.exitCode = 1; }, 10_000);
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
