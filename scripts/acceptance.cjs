/* Integration acceptance: real PostgreSQL and HTTP; synthetic mail, AI and delivery boundaries. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const { join } = require('node:path');
const { PrismaClient, Prisma } = require('@prisma/client');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const load = (name, area = 'mail') => require(join(process.cwd(), 'dist/modules', area, name));
const { EmailNormalizer } = load('email-normalizer');
const { InitialSyncService, SyncCheckpointChangedError } = load('initial-sync.service');
const { BusinessGateService } = load('business-gate.service');
const { ContactResolverService } = load('contact-resolver.service');
const { ProjectReviewService } = load('project-review.service');
const { ProjectEmailAnalysisService } = load('project-email-analysis.service');
const { SummaryTimelineService } = load('summary-timeline.service');
const { BusinessRecordsService } = load('business-records.service');
const { BusinessBriefService } = load('business-brief.service');
const { AgentEventsService } = load('agent-events.service');
const { AgentIntegrationService } = load('agent-integration.service');
const { MailReconciliationService } = load('mail-reconciliation.service');
const { EmailAnalyzerService } = load('email-analyzer.service', 'ai');
const { ANALYSIS_OUTPUT_SCHEMA } = load('analysis.schema', 'ai');
const { IMPORTANCE_TRIAGE_OUTPUT_SCHEMA } = load('importance-triage.schema', 'ai');
const { AIProviderError } = load('ai-provider', 'ai');
const { EmailImportanceTriageService } = load('email-importance-triage.service');
const { IMPORTANCE_TRIAGE_QUEUE } = load('email-importance-triage.service');
const { SenderRulesService } = load('sender-rules.service');
const { MailDeletionSyncService } = load('mail-deletion-sync.service');
const { MailController } = load('mail.controller');
const { SystemMailSendersService } = load('system-mail-senders.service');
const { DeliveryFailuresService } = load('delivery-failures.service');
const { AuthService } = load('auth.service', 'auth');
const { AuthController } = load('auth.controller', 'auth');
const { ImapMailService } = load('imap-mail.service');
const { RealtimeSyncService } = load('realtime-sync.service');
const { classifyMail, extractAutomationDetails, senderRuleSnapshotAction } = load('business-gate.rules');
const { backfill: backfillAutomationDetails } = require('./backfill-automation-details.cjs');
const { recoverEvent: recoverMissedActionableEvent } = require('./recover-missed-actionable-event.cjs');
const dbName = `aimail_acceptance_${Date.now()}_${process.pid}`;
assert.match(dbName, /^aimail_acceptance_\d+_\d+$/);
const adminUrl = process.env.DATABASE_URL;
assert.ok(adminUrl, 'Run through verify-integration.mjs with Docker Compose');
const testUrl = new URL(adminUrl); testUrl.pathname = `/${dbName}`;
const admin = new PrismaClient({ datasourceUrl: adminUrl });
let db, app, created = false, passed = 0, failures = [];
const settings = { APP_ROLE: 'acceptance', IMAP_EMAIL: 'owner@acceptance.test', IMAP_HOST: 'imap.acceptance.test',
  IMAP_SYNC_FOLDERS: 'INBOX', IMAP_SYNC_PAGE_SIZE: 5, BUSINESS_TIMEZONE: 'Europe/Rome',
  IMAP_API_TOKEN: randomUUID(), NOTIFICATION_ALLOWED_CHANNELS: 'telegram', NOTIFICATION_ALLOWED_RECIPIENTS: 'test-chat',
  DASHBOARD_INITIAL_EMAIL: 'sales@acceptance.test', DASHBOARD_INITIAL_PASSWORD: 'initial-acceptance-password' };
const config = { get: (key, fallback) => settings[key] === undefined ? fallback : settings[key] };
const logger = { info() {}, warn() {}, error() {} };
const now = new Date();
let seq = 0, account, checkpoint, initial, gate, contacts, projects, summaries, records, events, integrations, brief, analyzer, reconciliation, importanceTriage, senderRules;
let systemMailSenders, deliveryFailures;
let wireMessages = [], fetchFailure = false, providerResult, providerCalls = 0, providerPrompt;
let importanceResult, importanceResults = [], importanceHooks = [], importanceProviderErrors = [], importanceCalls = 0, importancePrompt, failedTriageIds = [], reviewTriageId;
const imap = { status: async () => ({ configured: true, status: 'connected' }),
  fetchIncrementalPage: async (_account, _folder, lastUid, limit, _range, target) => {
    if (fetchFailure) throw new Error('SIMULATED_IMAP_OUTAGE');
    const available = wireMessages.filter(m => m.uid > lastUid && (target == null || m.uid <= target));
    const messages = available.slice(0, limit);
    return { messages, uidValidity: 1n, nextUid: messages.at(-1)?.uid ?? lastUid,
      targetUid: target ?? wireMessages.at(-1)?.uid ?? 0, hasMore: available.length > messages.length, throughDate: now };
  } };
const provider = { name: 'acceptance', model: 'fixture', generateStructured: async (prompt, schema) => {
  providerCalls++; providerPrompt = prompt;
  if (schema === IMPORTANCE_TRIAGE_OUTPUT_SCHEMA) {
    importanceCalls++; importancePrompt = prompt;
    if (importanceProviderErrors.length) throw new AIProviderError(importanceProviderErrors.shift());
    if (importanceHooks.length) await importanceHooks.shift()();
    return structuredClone(importanceResults.length ? importanceResults.shift() : importanceResult);
  }
  return structuredClone(providerResult);
} };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) {
    failures.push(name);
    const details = String(error.stack ?? error.message).split(adminUrl).join('[redacted-admin-db-url]')
      .split(testUrl.toString()).join('[redacted-test-db-url]');
    console.log(`FAIL ${name}: ${details.slice(0, 2200)}`);
  }
}
function mail(from = 'client@customer.test', subject = 'Acceptance project', body = 'Please send the revised drawing.', date = now) {
  const uid = ++seq;
  return { uid, receivedAt: date, rawSource: Buffer.from(`From: ${from}\r\nTo: owner@acceptance.test\r\nSubject: ${subject}\r\nMessage-ID: <acceptance-${uid}@example.test>\r\nDate: ${date.toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`) };
}
function mailWithHeader(from, subject, body, header) {
  const wire = mail(from, subject, body);
  const source = Buffer.from(wire.rawSource).toString('utf8').replace('\r\n\r\n', `\r\n${header}\r\n\r\n`);
  wire.rawSource = Buffer.from(source);
  return wire;
}
function dsnMail(recipient, messageId = '<priority-dsn-1@example.test>', deliveredRecipient = null) {
  const uid = ++seq;
  const boundary = `dsn-${uid}-boundary`;
  const rawSource = [
    'From: Mail Delivery Subsystem <mailer-daemon@whitelist.test>', 'To: owner@acceptance.test',
    'Subject: Delivery Status Notification (Failure)', `Message-ID: ${messageId}`,
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', 'Delivery failed.',
    `--${boundary}`, 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.acceptance.test', '',
    `Final-Recipient: rfc822; ${recipient}`, 'Action: failed', 'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 recipient address rejected',
    ...(deliveredRecipient ? ['', `Final-Recipient: rfc822; ${deliveredRecipient}`, 'Action: delivered', 'Status: 2.0.0'] : []),
    `--${boundary}--`, '',
  ].join('\r\n');
  return { uid, receivedAt: now, rawSource: Buffer.from(rawSource) };
}
async function persist(messages, extra = {}) {
  return initial.persistPage({ accountId: account.id, accountEmail: account.email, checkpointId: checkpoint.id,
    mailbox: 'INBOX', uidValidity: 1n, messages, nextUid: messages.at(-1)?.uid ?? seq, hasMore: false, ...extra });
}
async function messageFor(wire) { return db.emailMessage.findFirstOrThrow({ where: { uid: wire.uid, mailAccountId: account.id } }); }
function result(message, operations = [], overrides = {}) { return { schema_version: '3', classification: 'BUSINESS_HUMAN', classification_confidence: 0.94,
  classification_evidence: ['Please send the revised drawing.'], summary: 'Acceptance summary', operations,
  reply_required_suggestion: false, importance: 'normal', requires_deep_analysis: false, review_reasons: [], ...overrides }; }
function triageResult(importance = 'normal', intent = 'routine', evidence = 'Routine project update.', overrides = {}) {
  return { schema_version: '1', importance, intent, confidence: 0.96, reason: 'Synthetic acceptance triage result.', evidence: [evidence], review_required: false, ...overrides };
}
function operation(message, changes, overrides = {}) {
  const blank = Object.fromEntries(Object.keys(ANALYSIS_OUTPUT_SCHEMA.properties.operations.items.properties.changes.properties).map(k => [k, null]));
  return { entity_type: 'task', action: 'create', target_id: null, source_message_id: message.id,
    evidence: 'Please send the revised drawing.', confidence: 0.99, task_outcome: 'none', changes: { ...blank, ...changes }, ...overrides };
}
async function childJson(file, args = [], input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, file), ...args], { env: { ...process.env, AI_MAIL_API_URL: `${base}/api/v1`, AI_MAIL_API_TOKEN: settings.IMAP_API_TOKEN }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', v => out += v); child.stderr.on('data', v => err += v);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Tool subprocess timeout')); }, 15000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code) reject(new Error(err)); else { try { resolve(input ? out.trim().split('\n').map(JSON.parse) : JSON.parse(out)); } catch (e) { reject(e); } } });
    if (input) { child.stdin.write(input); setTimeout(() => child.stdin.end(), 1000); } else child.stdin.end();
  });
}
let base;
async function api(path, method = 'GET', body, token = settings.IMAP_API_TOKEN) {
  const response = await fetch(`${base}/api/v1/mail${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function createAcceptanceProject(name, key) {
  const contact = await contacts.createContact({ email: `${key}@acceptance.test`, displayName: `${key} Contact`, operationId: `${key}-contact` });
  const company = await contacts.createCompany({ name: `${key} Company`, contactIds: [contact.id], operationId: `${key}-company` });
  return projects.createProject({ name, companyId: company.id, contactIds: [contact.id], operationId: `${key}-project` });
}
async function main() {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`); created = true;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: testUrl.toString() }, stdio: 'pipe' });
  db = new PrismaClient({ datasourceUrl: testUrl.toString() });
  const dashboardAuth = new AuthService(db, config);
  await dashboardAuth.onModuleInit();
  account = await db.mailAccount.create({ data: { email: settings.IMAP_EMAIL, host: settings.IMAP_HOST, port: 993, tlsMode: 'implicit', username: settings.IMAP_EMAIL, passwordCiphertext: 'synthetic-not-a-secret' } });
  checkpoint = await db.syncCheckpoint.create({ data: { mailAccountId: account.id, mailbox: 'INBOX', fromDate: new Date(now.getTime() - 86400000), throughDate: now, status: 'completed' } });
  senderRules = new SenderRulesService(db, config);
  systemMailSenders = new SystemMailSendersService(db);
  deliveryFailures = new DeliveryFailuresService(config, db, systemMailSenders);
  const projectAnalysis = new ProjectEmailAnalysisService(db, config, provider, systemMailSenders);
  initial = new InitialSyncService(config, db, imap, new EmailNormalizer(), senderRules, projectAnalysis, logger, systemMailSenders);
  gate = new BusinessGateService(config, db, systemMailSenders);
  contacts = new ContactResolverService(config, db, projectAnalysis); projects = new ProjectReviewService(config, db, projectAnalysis);
  summaries = new SummaryTimelineService(config, db); records = new BusinessRecordsService(config, db, contacts, projects, summaries);
  events = new AgentEventsService(db, config, projectAnalysis, systemMailSenders); integrations = new AgentIntegrationService(db, config, projectAnalysis, logger, systemMailSenders); brief = new BusinessBriefService(db, config);
  analyzer = new EmailAnalyzerService(config, db, provider, systemMailSenders);
  importanceTriage = new EmailImportanceTriageService(db, config, provider, projectAnalysis, systemMailSenders);
 reconciliation = new MailReconciliationService(config, db, imap, initial, gate, contacts, projects, logger);
  const deletionSync = new MailDeletionSyncService(config, db, imap, {}, logger);
  class AcceptanceModule {}
  Module({ controllers: [MailController, AuthController], providers: [
    [ConfigService, config], [ImapMailService, imap], [InitialSyncService, initial], [BusinessGateService, gate],
    [RealtimeSyncService, { status: async () => ({ configured: true }) }], [ContactResolverService, contacts], [ProjectReviewService, projects],
    [SummaryTimelineService, summaries], [BusinessRecordsService, records], [AgentEventsService, events],
    [AgentIntegrationService, integrations], [BusinessBriefService, brief], [EmailAnalyzerService, analyzer], [MailReconciliationService, reconciliation],
   [EmailImportanceTriageService, importanceTriage], [SenderRulesService, senderRules],
    [MailDeletionSyncService, deletionSync],
    [AuthService, dashboardAuth], [SystemMailSendersService, systemMailSenders], [DeliveryFailuresService, deliveryFailures],
  ].map(([provide, useValue]) => ({ provide, useValue })) })(AcceptanceModule);
  app = await NestFactory.create(AcceptanceModule, { logger: false }); app.setGlobalPrefix('api/v1'); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  let source, project, topic, task, analysis;

  await test('Dashboard email login, password change and session revocation', async () => {
    const user = await db.dashboardUser.findUniqueOrThrow({ where: { email: settings.DASHBOARD_INITIAL_EMAIL } });
    assert.notEqual(user.passwordHash, settings.DASHBOARD_INITIAL_PASSWORD);
    const wrong = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'wrong' }) });
    assert.equal(wrong.status, 401);
    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: settings.DASHBOARD_INITIAL_PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /sc_mail_session=([^;]+);/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const token = cookie.match(/sc_mail_session=([^;]+)/)[1];
    assert.equal((await login.json()).user.mustChangePassword, true);
    assert.equal(await dashboardAuth.isActiveSessionToken(token), false);
    const current = await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(current.status, 200);
    const changed = await fetch(`${base}/api/v1/auth/change-password`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: settings.DASHBOARD_INITIAL_PASSWORD, newPassword: 'new-acceptance-password' }) });
    assert.equal(changed.status, 200);
    assert.equal((await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    await dashboardAuth.onModuleInit();
    assert.equal((await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: settings.DASHBOARD_INITIAL_PASSWORD }) })).status, 401);
    const second = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'new-acceptance-password' }) });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).user.mustChangePassword, false);
    const secondToken = second.headers.get('set-cookie').match(/sc_mail_session=([^;]+)/)[1];
    assert.equal(await dashboardAuth.isActiveSessionToken(secondToken), true);
    assert.equal((await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${secondToken}` } })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${secondToken}` } })).status, 401);
  });

  await test('M1 HTTP auth, input validation and read endpoints', async () => {
    assert.equal((await api('/tasks', 'GET', undefined, 'wrong')).status, 401);
    assert.equal((await api('/agent-events/review-summary', 'POST', { operationId: 'unauthorized' }, 'wrong')).status, 401);
    assert.equal((await api('/tasks?limit=-1')).status, 400);
    for (const path of ['/tasks','/requirements','/decisions','/crm/contacts','/crm/companies','/projects','/reviews','/agent-events','/importance-triage','/integrations/status','/reconciliation/status','/classifications/summary','/classifications/messages?classification=BUSINESS_HUMAN']) assert.equal((await api(path)).status, 200, path);
  });
  await test('M2 credential encryption is randomized and rejects tampering', async () => {
    const { encryptCredential, decryptCredential } = load('credential-cipher');
    const key = require('node:crypto').randomBytes(32).toString('base64');
    const cipher = encryptCredential('synthetic-password', key);
    assert.equal(decryptCredential(cipher, key), 'synthetic-password');
    assert.notEqual(cipher, encryptCredential('synthetic-password', key));
    const pieces = cipher.split('.'); const bytes = Buffer.from(pieces[3], 'base64'); bytes[0] ^= 1; pieces[3] = bytes.toString('base64');
    assert.throws(() => decryptCredential(pieces.join('.'), key));
  });
  await test('M5 PostgreSQL queue survives restart and retries a failed job', async () => {
    const { PgBoss } = require('pg-boss'); const name = 'acceptance-jobs'; let boss = new PgBoss(testUrl.toString());
    try {
      await boss.start(); await boss.createQueue(name, { retryLimit: 2, retryDelay: 0 });
      const id = await boss.send(name, { synthetic: true }); await boss.stop();
      boss = new PgBoss(testUrl.toString()); await boss.start();
      const [job] = await boss.fetch(name); assert.equal(job.id, id);
      await boss.fail(name, id, { reason: 'simulated' });
      const [retry] = await boss.fetch(name); assert.equal(retry.id, id);
      await boss.complete(name, id); assert.equal((await boss.getJobById(name, id)).state, 'completed');
    } finally { await boss.stop(); }
  });
  await test('M19 triage scheduler uses its own durable pg-boss queue', async () => {
    assert.equal(IMPORTANCE_TRIAGE_QUEUE, 'email-importance-triage');
    assert.notEqual(IMPORTANCE_TRIAGE_QUEUE, 'mailbox-incremental-sync');
    const { PgBoss } = require('pg-boss'); const boss = new PgBoss(testUrl.toString());
    try {
      await boss.start(); await boss.createQueue(IMPORTANCE_TRIAGE_QUEUE, { retryLimit: 2, retryDelay: 0 });
      const id = await boss.send(IMPORTANCE_TRIAGE_QUEUE, { source: 'acceptance-fixture' });
      const [job] = await boss.fetch(IMPORTANCE_TRIAGE_QUEUE); assert.equal(job.id, id);
      await boss.complete(IMPORTANCE_TRIAGE_QUEUE, id);
    } finally { await boss.stop(); }
  });
  await test('M3 import atomicity, duplicate scan and silent historical import', async () => {
    const wire = mail(); assert.equal(await persist([wire]), 1); assert.equal(await persist([wire]), 0);
    source = await messageFor(wire); assert.ok(Buffer.from(source.rawSource).equals(wire.rawSource));
    assert.equal(await db.agentEvent.count(), 0); assert.equal(await db.processingRecord.count(), 1);
    assert.equal(source.historicalImport, true);
    await persist([wire], { auditOnly: true, importanceTriageSource: 'reconciliation', importanceTriageCatchupCutoff: new Date(now.getTime() - 86400000) });
    assert.equal(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: source.id } }), null);
    assert.equal(await db.agentEvent.count(), 0);
    const broken = mail(); await assert.rejects(persist([broken], { checkpointId: 'missing-checkpoint' }));
    assert.equal(await db.emailMessage.count({ where: { uid: broken.uid } }), 0);
  });
  await test('M20-M22 sender rules, human-only whitelist, silent queryable DSN and no retroactive changes', async () => {
    assert.equal((await api('/sender-rules', 'GET', undefined, 'wrong')).status, 401);
    assert.equal((await api('/sender-rules')).body.rules.length, 0);
    assert.equal((await api('/sender-rules', 'PUT', { action: 'blacklist', matchType: 'domain', pattern: '*.blocked.test', actorId: 'acceptance', operationId: 'm20-invalid-wildcard' })).status, 400);

    const historicalWire = mail('stored@future.test', 'Historical business message', 'Please send the drawing.');
    await persist([historicalWire], { incremental: true, emitAgentEvents: true });
    const historicalMessage = await messageFor(historicalWire);
    assert.equal(historicalMessage.senderRuleSnapshot.action, 'none');
    const historicalTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: historicalMessage.id } });
    await db.emailImportanceTriage.update({ where: { id: historicalTriage.id }, data: { status: 'review', importance: 'uncertain', lastErrorCode: 'M20_SNAPSHOT_FIXTURE', analyzedAt: new Date() } });

    const setRule = (action, matchType, pattern, operationId) => api('/sender-rules', 'PUT', {
      action, matchType, pattern, actorId: 'acceptance-user', operationId,
    });
    const historicalRuleBody = { action: 'blacklist', matchType: 'address', pattern: ' Stored@Future.Test ', actorId: 'acceptance-user', operationId: 'm20-historical-blacklist' };
    const historicalRule = await api('/sender-rules', 'PUT', historicalRuleBody);
    assert.equal(historicalRule.status, 200); assert.equal(historicalRule.body.pattern, 'stored@future.test');
    assert.deepEqual((await api('/sender-rules', 'PUT', historicalRuleBody)).body, historicalRule.body);
    assert.equal((await api('/sender-rules', 'PUT', { ...historicalRuleBody, pattern: 'other@future.test' })).status, 409);
    const futureBlockedWire = mail('stored@future.test', 'New blocked message', 'Please send the drawing.');
    await persist([futureBlockedWire], { incremental: true, emitAgentEvents: true });
    const futureBlocked = await messageFor(futureBlockedWire);
    assert.equal(futureBlocked.classification, 'BLACKLISTED');
    assert.equal(futureBlocked.senderRuleSnapshot.action, 'blacklist');
    assert.equal(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: futureBlocked.id } }), null);

    const domainBlack = await setRule('blacklist', 'domain', ' BLOCKED.TEST ', 'm20-domain-blacklist');
    const addressWhite = await setRule('whitelist', 'address', 'special@blocked.test', 'm20-address-whitelist');
    const bounceWhite = await setRule('whitelist', 'address', 'mailer-daemon@whitelist.test', 'm20-bounce-whitelist');
    const personWhite = await setRule('whitelist', 'address', 'vip@priority.test', 'm21-person-whitelist');
    const deliveredPersonWhite = await setRule('whitelist', 'address', 'vip-delivered@priority.test', 'm21-delivered-person-whitelist');
    for (const saved of [domainBlack, addressWhite, bounceWhite, personWhite, deliveredPersonWhite]) assert.equal(saved.status, 200);
    const blackOperation = await db.businessOperation.findUniqueOrThrow({ where: { operationId: 'm20-domain-blacklist' } });
    assert.equal(blackOperation.entityType, 'sender_rule'); assert.equal(blackOperation.action, 'upsert');

    const blackMail = mail('special@blocked.test', 'Blocked offer', 'Please send your latest offer.');
    const subdomainBounce = mail('mailer-daemon@sub.blocked.test', 'Undelivered Mail Returned to Sender', 'Delivery failed.');
    const whiteBounce = mail('MAILER-DAEMON@whitelist.test', 'Undelivered Mail Returned to Sender', 'Delivery failed for the order update.');
    const whiteOoo = mailWithHeader('vip@priority.test', 'Out of Office: Away', 'I am away.', 'Auto-Submitted: auto-replied');
    const whiteTicket = mailWithHeader('vip@priority.test', 'Ticket created #12345', 'We received your request.', 'Auto-Submitted: auto-generated');
    const whiteHuman = mail('vip@priority.test', 'VIGX reply', 'We are not reviewing partners and will keep your details on file.');
    const whiteRecipientDsn = dsnMail('VIP@priority.test', '<priority-dsn-1@example.test>', 'vip-delivered@priority.test');
    const eventCountBefore = await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } });
    const callsBefore = importanceCalls;
    await persist([blackMail, subdomainBounce, whiteBounce, whiteOoo, whiteTicket, whiteHuman, whiteRecipientDsn], { incremental: true, emitAgentEvents: true });
    const blocked = await messageFor(blackMail), subdomain = await messageFor(subdomainBounce), whitelisted = await messageFor(whiteBounce);
    assert.equal(blocked.classification, 'BLACKLISTED');
    assert.equal(blocked.senderRuleSnapshot.action, 'blacklist');
    assert.deepEqual(blocked.senderRuleSnapshot.matchingRules.map(rule => rule.action), ['blacklist', 'whitelist']);
    assert.ok(await db.processingRecord.findUnique({ where: { sourceMessageId: blocked.id } }));
    assert.equal(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: blocked.id } }), null);
    assert.equal(await db.agentEvent.findFirst({ where: { entityId: blocked.id, eventType: 'INBOUND_EMAIL_RECEIVED' } }), null);
    assert.equal(subdomain.classification, 'DELIVERY_FAILURE');
    assert.equal(subdomain.senderRuleSnapshot.action, 'none');
    assert.equal(await db.agentEvent.findFirst({ where: { entityId: subdomain.id, eventType: 'INBOUND_EMAIL_RECEIVED' } }), null);
    assert.equal(whitelisted.classification, 'DELIVERY_FAILURE');
    assert.equal(whitelisted.senderRuleSnapshot.action, 'whitelist');
    assert.equal(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: whitelisted.id } }), null);
    assert.equal(await db.agentEvent.count({ where: { entityId: whitelisted.id } }), 0);
    assert.equal((await messageFor(whiteOoo)).classification, 'OUT_OF_OFFICE');
    assert.equal((await messageFor(whiteTicket)).classification, 'TICKET_CONFIRMATION');
    for (const wire of [whiteOoo, whiteTicket]) assert.equal(await db.agentEvent.findFirst({ where: { entityId: (await messageFor(wire)).id } }), null);
    const personMessage = await messageFor(whiteHuman);
    assert.equal(personMessage.classification, 'BUSINESS_HUMAN');
    assert.equal(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: personMessage.id } }), null);
    const personEvent = await db.agentEvent.findFirstOrThrow({ where: { entityId: personMessage.id, eventType: 'INBOUND_EMAIL_RECEIVED' } });
    assert.equal(personEvent.payloadJson.notificationRequired, true);
    assert.equal(personEvent.payloadJson.importanceReason.includes('bypasses importance scoring'), true);
    assert.equal(await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } }), eventCountBefore + 1);
    const dsnMessage = await messageFor(whiteRecipientDsn);
    assert.equal(dsnMessage.classification, 'DELIVERY_FAILURE');
    assert.equal(dsnMessage.senderRuleSnapshot.action, 'whitelist');
    assert.equal(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: dsnMessage.id } }), null);
    assert.equal(await db.agentEvent.count({ where: { entityId: dsnMessage.id } }), 0);
    const dsnListing = await api('/classifications/messages?classification=DELIVERY_FAILURE&limit=100');
    assert.equal(dsnListing.status, 200);
    const listedDsn = dsnListing.body.messages.find((message) => message.id === dsnMessage.id);
    assert.ok(listedDsn);
    assert.ok(listedDsn.automationDetails.facts.some((fact) => fact.type === 'recipient' && fact.value === 'vip@priority.test'));
    assert.equal(listedDsn.automationDetails.facts.some((fact) => fact.type === 'recipient' && fact.value === 'vip-delivered@priority.test'), false);
    assert.ok(listedDsn.automationDetails.facts.some((fact) => fact.type === 'delivery_action' && fact.value === 'failed'));
    assert.ok(listedDsn.automationDetails.facts.some((fact) => fact.type === 'status_code' && fact.value === '5.1.1'));
    assert.ok(listedDsn.automationDetails.facts.some((fact) => fact.type === 'diagnostic'));
    const duplicateDsn = dsnMail('vip@priority.test'); duplicateDsn.rawSource = Buffer.from(whiteRecipientDsn.rawSource);
    await persist([duplicateDsn], { incremental: true, emitAgentEvents: true });
    assert.equal(await db.emailMessage.count({ where: { rfcMessageId: dsnMessage.rfcMessageId } }), 1);
    assert.equal(await db.agentEvent.count({ where: { entityId: dsnMessage.id } }), 0);
    assert.equal(await db.agentEvent.count({ where: { eventType: 'WHITELIST_CONTACT_DELIVERY_FAILURE' } }), 0);
    assert.equal(importanceCalls, callsBefore);

    const priorChannels = settings.NOTIFICATION_ALLOWED_CHANNELS, priorRecipients = settings.NOTIFICATION_ALLOWED_RECIPIENTS;
    settings.NOTIFICATION_ALLOWED_CHANNELS = 'whatsapp'; settings.NOTIFICATION_ALLOWED_RECIPIENTS = '+390000000001';
    try {
      const [claim] = await events.claim('acceptance-whitelist', 1, 60, personEvent.id);
      assert.ok(claim);
      const baseCompletion = { agentId: 'acceptance-whitelist', leaseToken: claim.leaseToken, result: { notified: true } };
      await assert.rejects(events.complete(personEvent.id, baseCompletion), error => error.status === 409 && error.response?.code === 'WHITELIST_NOTIFICATION_REQUIRED');
      const notice = { requestKey: 'm21-whitelist-person-notification', channel: 'whatsapp', recipientRef: '+390000000001', content: '重点联系人来信通知' };
      await assert.rejects(events.complete(personEvent.id, { ...baseCompletion, notifications: [{ ...notice, recipientRef: '+390000000002' }] }), error => error.status === 409 && error.response?.code === 'NOTIFICATION_TARGET_NOT_ALLOWED');
      const completed = await events.complete(personEvent.id, { ...baseCompletion, notifications: [notice] });
      assert.equal(completed.notifications.length, 1);
      assert.equal(await db.notificationDelivery.count({ where: { eventId: personEvent.id } }), 1);
      assert.equal((await events.complete(personEvent.id, { ...baseCompletion, notifications: [notice] })).replayed, true);
      await db.notificationDelivery.update({ where: { requestKey: notice.requestKey }, data: { status: 'failed', lastError: 'M21_ACCEPTANCE_FIXTURE_NO_TRANSPORT' } });
      await persist([whiteBounce, whiteRecipientDsn], { incremental: true, emitAgentEvents: true });
      assert.equal(await db.agentEvent.count({ where: { entityId: whitelisted.id } }), 0);
      assert.equal(await db.agentEvent.count({ where: { entityId: dsnMessage.id } }), 0);
      assert.equal(await db.notificationDelivery.count({ where: { requestKey: 'm21-whitelist-delivery-failure-notification' } }), 0);
    } finally {
      settings.NOTIFICATION_ALLOWED_CHANNELS = priorChannels; settings.NOTIFICATION_ALLOWED_RECIPIENTS = priorRecipients;
    }

    // A rule added after import must not rewrite that already stored message, even when a recovery scan revisits it.
    await persist([historicalWire], { auditOnly: true, importanceTriageSource: 'reconciliation', importanceTriageCatchupCutoff: new Date(Date.now() - 86400000) });
    const historicalAfter = await messageFor(historicalWire);
    assert.equal(historicalAfter.senderRuleSnapshot.action, 'none');
    assert.equal(historicalAfter.classification, 'BUSINESS_HUMAN');
    assert.ok(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: historicalAfter.id } }));
    const deletedHistoricalRule = await api(`/sender-rules/${encodeURIComponent(historicalRule.body.id)}`, 'DELETE', { actorId: 'acceptance-user', operationId: 'm20-delete-historical-rule' });
    assert.equal(deletedHistoricalRule.status, 200);
    await persist([historicalWire, futureBlockedWire], { auditOnly: true, importanceTriageSource: 'reconciliation', importanceTriageCatchupCutoff: new Date(Date.now() - 86400000) });
    assert.equal((await messageFor(historicalWire)).senderRuleSnapshot.action, 'none');
    assert.equal((await messageFor(futureBlockedWire)).senderRuleSnapshot.action, 'blacklist');
    assert.equal((await messageFor(futureBlockedWire)).classification, 'BLACKLISTED');

    const cliRules = await childJson('ai-mail.mjs', ['sender-rules']);
    const mcpRules = await childJson('ai-mail-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sender_rules', arguments: {} } }) + '\n');
    assert.deepEqual(cliRules.rules, (await api('/sender-rules')).body.rules);
    assert.deepEqual(JSON.parse(mcpRules[0].result.content[0].text).rules, cliRules.rules);
    const cliSet = await childJson('ai-mail.mjs', ['sender-rule-set', 'whitelist', 'domain', 'cli-rule.test', 'acceptance-cli', 'm20-cli-set']);
    assert.equal(cliSet.pattern, 'cli-rule.test');
    await childJson('ai-mail.mjs', ['sender-rule-delete', cliSet.id, 'acceptance-cli', 'm20-cli-delete']);
    const mcpSet = await childJson('ai-mail-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set_sender_rule', arguments: { action: 'blacklist', matchType: 'domain', pattern: 'mcp-rule.test', actorId: 'acceptance-mcp', operationId: 'm20-mcp-set' } } }) + '\n');
    const mcpRule = JSON.parse(mcpSet[0].result.content[0].text);
    assert.equal(mcpRule.pattern, 'mcp-rule.test');
    await childJson('ai-mail-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_sender_rule', arguments: { ruleId: mcpRule.id, actorId: 'acceptance-mcp', operationId: 'm20-mcp-delete' } } }) + '\n');
    assert.equal((await db.businessOperation.findUniqueOrThrow({ where: { operationId: 'm20-mcp-delete' } })).action, 'delete');
  });
  await test('M5 new arrival queues one durable local triage; UIDVALIDITY recovery preserves manual classification', async () => {
    const inboundEventCount = await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } });
    const wire = mail(); await persist([wire], { incremental: true, emitAgentEvents: true }); await persist([wire], { incremental: true, emitAgentEvents: true });
    assert.equal(await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } }), inboundEventCount);
    const stored = await messageFor(wire); await db.emailMessage.update({ where: { id: stored.id }, data: { classificationManualOverride: true, classification: 'NEWSLETTER', reviewRequired: false } });
    assert.equal(await db.emailImportanceTriage.count({ where: { sourceMessageId: stored.id } }), 1);
    await persist([wire], { uidValidity: 2n }); assert.equal((await db.emailMessage.findUnique({ where: { id: stored.id } })).classification, 'NEWSLETTER');
    assert.equal(await db.emailMessage.count({ where: { rfcMessageId: stored.rfcMessageId } }), 1);
  });
  await test('M15 deterministic noise stays silent; candidates wait for local importance triage', async () => {
    const bounce = mail('MAILER-DAEMON@zmail.test', 'Undelivered Mail Returned to Sender', 'Final-Recipient: rfc822; invalid@vendor.test\nDiagnostic-Code: smtp; 550 5.1.1 User unknown');
    const autoReply = mail('info@vendor.test', 'Automatic reply: booth design', 'I will be back on October 12, 2026.\nFor urgent matters, please contact Alex at alex@vendor.test or +39 02 12345678.');
    const ticket = mail('customerservice@vendor.zendesk.com', 'Request received - Ticket 138359', 'We created ticket #138359. Track it here: https://support.vendor.test/tickets/138359');
    const newsletter = mail('newsletter@vendor.test', 'Weekly offers', 'Offers inside.');
    const rfq = mail('no-reply@vendor.test', 'REQUEST FOR QUOTATION', '');
    const phishing = mail('no-reply@vendor.test', 'Webmail Login Expired', 'Update your password now https://untrusted.example/login');
    const uncertain = mail('no-reply@vendor.test', 'Service notice', 'Unclassified automatic message.');
    newsletter.rawSource = Buffer.from(newsletter.rawSource.toString().replace('\r\n\r\n', '\r\nList-Id: offers.vendor.test\r\nList-Unsubscribe: <mailto:unsubscribe@vendor.test>\r\nPrecedence: bulk\r\n\r\n'));
    const before = await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } });
    await persist([bounce, autoReply, ticket, newsletter, rfq, phishing, uncertain], { incremental: true, emitAgentEvents: true });
    assert.equal((await messageFor(bounce)).classification, 'DELIVERY_FAILURE');
    assert.equal((await messageFor(autoReply)).classification, 'OUT_OF_OFFICE');
    assert.equal((await messageFor(ticket)).classification, 'TICKET_CONFIRMATION');
    assert.equal((await messageFor(newsletter)).classification, 'NEWSLETTER');
    assert.equal((await messageFor(rfq)).classification, 'BUSINESS_HUMAN');
    assert.equal((await messageFor(phishing)).classification, 'SPAM');
    assert.equal((await messageFor(uncertain)).classification, 'UNKNOWN');
    assert.equal(await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } }), before);
    assert.equal(await db.emailImportanceTriage.count({ where: { sourceMessageId: { in: [(await messageFor(rfq)).id, (await messageFor(uncertain)).id] } } }), 2);
    assert.equal(await db.agentEvent.findFirst({ where: { entityId: (await messageFor(bounce)).id } }), null);
    const summary = await gate.classificationSummary();
    assert.ok(summary.categories.find((category) => category.classification === 'DELIVERY_FAILURE').count >= 1);
    const listed = await gate.listClassifiedMessages('DELIVERY_FAILURE', undefined, 10, 0);
    const bounceRecord = await messageFor(bounce);
    const listedBounce = listed.messages.find((message) => message.id === bounceRecord.id);
    assert.ok(listedBounce);
    assert.ok(listedBounce.automationDetails.facts.some((fact) => fact.type === 'recipient' && fact.value === 'invalid@vendor.test'));
    assert.ok(listedBounce.automationDetails.facts.some((fact) => fact.type === 'status_code' && fact.value === '5.1.1'));
    const listedOoo = await gate.listClassifiedMessages('OUT_OF_OFFICE', undefined, 10, 0);
    const oooRecord = await messageFor(autoReply);
    const oooDetails = listedOoo.messages.find((message) => message.id === oooRecord.id)?.automationDetails;
    assert.ok(oooDetails.facts.some((fact) => fact.type === 'return_date_text' && fact.value === 'October 12, 2026'));
    assert.ok(oooDetails.facts.some((fact) => fact.type === 'alternate_contact_email' && fact.value === 'alex@vendor.test'));
    assert.ok(oooDetails.facts.some((fact) => fact.type === 'alternate_contact_phone'));
    const listedTickets = await gate.listClassifiedMessages('TICKET_CONFIRMATION', undefined, 10, 0);
    const ticketRecord = await messageFor(ticket);
    const ticketDetails = listedTickets.messages.find((message) => message.id === ticketRecord.id)?.automationDetails;
    assert.ok(ticketDetails.facts.some((fact) => fact.type === 'ticket_id' && fact.value === '138359'));
    assert.ok(ticketDetails.facts.some((fact) => fact.type === 'ticket_or_request_url'));
    importanceResults = [
      triageResult('normal', 'customer_inquiry', 'REQUEST FOR QUOTATION'),
      triageResult('uncertain', 'uncertain', 'Unclassified automatic message.', { confidence: 0.3, review_required: true }),
    ];
    await importanceTriage.processBatch(5);
    const rfqMessage = await messageFor(rfq); const uncertainMessage = await messageFor(uncertain);
    const rfqTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: rfqMessage.id } });
    const uncertainTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: uncertainMessage.id } });
    assert.equal(rfqTriage.status, 'high'); assert.equal(rfqTriage.importance, 'high');
    assert.equal(uncertainTriage.status, 'review'); assert.equal(uncertainTriage.importance, 'uncertain');
    assert.equal(await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } }), before + 1);
    assert.equal((await db.agentEvent.findFirstOrThrow({ where: { entityId: rfqMessage.id } })).payloadJson.importance, 'high');
    assert.equal(await db.agentEvent.findFirst({ where: { entityId: uncertainMessage.id } }), null);
  });
  await test('M20 only actionable high or urgent mail creates an individual event', async () => {
    const routine = mail('client@customer.test', 'Weekly project update', 'The installation is proceeding as planned; no action is needed.');
    const urgent = mail('client@customer.test', 'Production halted today', 'Production line is stopped. Please call us now to resolve the issue.');
    const refusal = mail('partners@vigx.example', 'Re: CES 2027 booth support', 'Dear Leonardo, Thank you for reaching out and for your interest in supporting VIGX at CES 2027. We appreciate the introduction to Space Concept and your turnkey exhibition services. At this time, we are not reviewing booth design or build partners, but we will keep your information on file should our needs change. Thank you again for your message. Warm regards, The VIGX Team');
    const before = await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } });
    await persist([routine, urgent, refusal], { incremental: true, emitAgentEvents: true });
    assert.equal(await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } }), before);
    importanceResults = [
      triageResult('normal', 'routine', 'no action is needed'),
      triageResult('urgent', 'important_change', 'Production line is stopped.'),
      triageResult('high', 'non_actionable', 'not reviewing booth design or build partners', { reason: 'The sender declined and requested no follow-up.' }),
    ];
    const processed = await importanceTriage.processBatch(5);
    assert.equal(processed.quiet, 2); assert.equal(processed.urgent, 1);
    const routineMessage = await messageFor(routine); const urgentMessage = await messageFor(urgent); const refusalMessage = await messageFor(refusal);
    assert.equal((await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: routineMessage.id } })).status, 'quiet');
    assert.equal((await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: urgentMessage.id } })).status, 'urgent');
    const refusalTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: refusalMessage.id } });
    assert.equal(refusalTriage.status, 'quiet'); assert.equal(refusalTriage.importance, 'low');
    assert.equal(await db.agentEvent.findFirst({ where: { entityId: refusalMessage.id, eventType: 'INBOUND_EMAIL_RECEIVED' } }), null);
    assert.equal(await db.agentEvent.count({ where: { eventType: 'INBOUND_EMAIL_RECEIVED' } }), before + 1);
    const event = await db.agentEvent.findFirstOrThrow({ where: { entityId: urgentMessage.id } });
    assert.equal(event.priority, 10); assert.equal(event.payloadJson.importance, 'urgent');
    assert.equal(event.payloadJson.triageSource, 'realtime'); assert.equal(event.payloadJson.receivedAt, urgentMessage.receivedAt.toISOString());
    assert.equal(event.payloadJson.recoveredDuringReconciliation, false);
    const auditedTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: urgentMessage.id } });
    assert.equal(auditedTriage.promptVersion, 'm20.3'); assert.equal(auditedTriage.schemaVersion, '1');
    assert.match(importancePrompt, /untrusted data/);
    assert.match(importancePrompt, /clear refusal/i);
  });
  await test('M19 event creation rechecks current noise and manual classification under the transaction lock', async () => {
    const noiseRace = mail('client@customer.test', 'Potential customer matter', 'Please send the current quote.');
    const manualRace = mail('client@customer.test', 'Another customer matter', 'Please send the current quote.');
    await persist([noiseRace, manualRace], { incremental: true, emitAgentEvents: true });
    const noiseMessage = await messageFor(noiseRace), manualMessage = await messageFor(manualRace);
    importanceResults = [
      triageResult('high', 'customer_inquiry', 'Please send the current quote.'),
      triageResult('high', 'customer_inquiry', 'Please send the current quote.'),
    ];
    importanceHooks = [
      () => db.emailMessage.update({ where: { id: noiseMessage.id }, data: { classification: 'NEWSLETTER', classificationManualOverride: false, reviewRequired: false } }),
      () => db.emailMessage.update({ where: { id: manualMessage.id }, data: { classification: 'BUSINESS_HUMAN', classificationManualOverride: true, reviewRequired: false } }),
    ];
    await importanceTriage.processBatch(2);
    const noiseTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: noiseMessage.id } });
    const manualTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: manualMessage.id } });
    assert.equal(noiseTriage.status, 'quiet'); assert.equal(noiseTriage.lastErrorCode, 'TRIAGE_CLASSIFICATION_CHANGED_TO_NOISE');
    assert.equal(manualTriage.status, 'review'); assert.equal(manualTriage.lastErrorCode, 'TRIAGE_MANUAL_CLASSIFICATION_OVERRIDE');
    assert.equal(await db.agentEvent.count({ where: { entityId: { in: [noiseMessage.id, manualMessage.id] }, eventType: 'INBOUND_EMAIL_RECEIVED' } }), 0);
  });
  await test('M19 reconciliation only triages recent catch-up mail and records source/date', async () => {
    const recentDate = new Date(Date.now() - 30 * 60_000);
    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    const recovered = mail('client@customer.test', 'Request for current offer', 'Please send the updated offer before tomorrow.', recentDate);
    const old = mail('client@customer.test', 'Old project question', 'Could you send the old drawing?', oldDate);
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await persist([recovered, old], { auditOnly: true, importanceTriageSource: 'reconciliation', importanceTriageCatchupCutoff: cutoff });
    const recoveredMessage = await messageFor(recovered); const oldMessage = await messageFor(old);
    const recoveredTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: recoveredMessage.id } });
    assert.equal(recoveredTriage.source, 'reconciliation');
    assert.equal(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: oldMessage.id } }), null);
    importanceResult = triageResult('high', 'materials_request', 'Please send the updated offer');
    await importanceTriage.processBatch(5);
    const event = await db.agentEvent.findFirstOrThrow({ where: { entityId: recoveredMessage.id } });
    assert.equal(event.payloadJson.triageSource, 'reconciliation');
    assert.equal(event.payloadJson.recoveredDuringReconciliation, true);
    assert.equal(event.payloadJson.receivedAt, recentDate.toISOString());
  });
  await test('M19 recovery fills missing triage for existing mail and reviews unknown received dates', async () => {
    const existingWire = mail('client@customer.test', 'Recovered request', 'Please send the revised offer.', new Date(Date.now() - 20 * 60_000));
    await persist([existingWire], { incremental: true, emitAgentEvents: true });
    const existingMessage = await messageFor(existingWire);
    assert.equal(existingMessage.historicalImport, false);
    // Simulate a legacy realtime record whose triage index was lost, not an initial import.
    await db.emailImportanceTriage.delete({ where: { sourceMessageId: existingMessage.id } });
    assert.equal(await db.emailImportanceTriage.findUnique({ where: { sourceMessageId: existingMessage.id } }), null);
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    await persist([existingWire], { auditOnly: true, importanceTriageSource: 'reconciliation', importanceTriageCatchupCutoff: cutoff });
    const filled = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: existingMessage.id } });
    assert.equal(filled.source, 'reconciliation'); assert.equal(filled.status, 'pending');
    await persist([existingWire], { auditOnly: true, importanceTriageSource: 'reconciliation', importanceTriageCatchupCutoff: cutoff });
    assert.equal(await db.emailImportanceTriage.count({ where: { sourceMessageId: existingMessage.id } }), 1);
    importanceResult = triageResult('normal', 'routine', 'Please send the revised offer.');
    await importanceTriage.processBatch(1);
    assert.equal((await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: existingMessage.id } })).status, 'quiet');

    const unknownDateWire = mail('client@customer.test', 'Date missing request', 'Please provide the updated quote.');
    unknownDateWire.receivedAt = null;
    await persist([unknownDateWire], { auditOnly: true, importanceTriageSource: 'uidvalidity_recovery', importanceTriageCatchupCutoff: cutoff });
    const unknownMessage = await messageFor(unknownDateWire);
    const unknownTriage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: unknownMessage.id } });
    assert.equal(unknownTriage.source, 'uidvalidity_recovery'); assert.equal(unknownTriage.status, 'review');
    assert.equal(unknownTriage.lastErrorCode, 'TRIAGE_RECEIVED_DATE_UNKNOWN');
    reviewTriageId = unknownTriage.id;
    assert.equal(await db.agentEvent.findFirst({ where: { entityId: unknownMessage.id } }), null);
  });
  await test('M19 model/provider and structured output failures retry finitely and remain queryable', async () => {
    const timedOut = mail('client@customer.test', 'Customer question', 'Could you advise us about the next step?');
    await persist([timedOut], { incremental: true, emitAgentEvents: true });
    const message = await messageFor(timedOut);
    importanceProviderErrors = ['AI_TIMEOUT', 'AI_TIMEOUT', 'AI_TIMEOUT'];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await importanceTriage.processBatch(1);
      const record = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: message.id } });
      assert.equal(record.attempts, attempt); assert.equal(record.maxAttempts, 3);
      assert.equal(record.status, attempt < 3 ? 'pending' : 'failed');
      assert.equal(record.lastErrorCode, 'AI_TIMEOUT');
      if (attempt < 3) await db.emailImportanceTriage.update({ where: { id: record.id }, data: { nextAttemptAt: new Date(0) } });
    }
    assert.equal(await db.agentEvent.count({ where: { entityId: message.id } }), 0);
    failedTriageIds.push((await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: message.id } })).id);

    const malformed = mail('client@customer.test', 'Another customer question', 'Please let us know what changed.');
    await persist([malformed], { incremental: true, emitAgentEvents: true });
    const malformedMessage = await messageFor(malformed); importanceResult = { malformed: true };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await importanceTriage.processBatch(1);
      const record = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: malformedMessage.id } });
      assert.equal(record.attempts, attempt); assert.equal(record.status, attempt < 3 ? 'pending' : 'review');
      assert.match(record.reason, /Output validation:/);
      if (attempt < 3) await db.emailImportanceTriage.update({ where: { id: record.id }, data: { nextAttemptAt: new Date(0) } });
    }
    assert.equal((await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: malformedMessage.id } })).lastErrorCode, 'TRIAGE_OUTPUT_SCHEMA_INVALID');
    assert.equal(await db.agentEvent.count({ where: { entityId: malformedMessage.id } }), 0);
    const malformedReview = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: malformedMessage.id } });
    assert.equal(malformedReview.status, 'review'); assert.equal(malformedReview.importance, 'uncertain');
    failedTriageIds.push(malformedReview.id);

    const invalidResponse = mail('client@customer.test', 'Response format failure', 'Please quote the updated project scope.');
    await persist([invalidResponse], { incremental: true, emitAgentEvents: true });
    const invalidResponseMessage = await messageFor(invalidResponse);
    importanceProviderErrors = ['AI_INVALID_RESPONSE', 'AI_INVALID_RESPONSE', 'AI_INVALID_RESPONSE'];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await importanceTriage.processBatch(1);
      const record = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: invalidResponseMessage.id } });
      assert.equal(record.attempts, attempt);
      assert.equal(record.status, attempt < 3 ? 'pending' : 'failed');
      assert.equal(record.lastErrorCode, 'AI_INVALID_RESPONSE');
      if (attempt < 3) await db.emailImportanceTriage.update({ where: { id: record.id }, data: { nextAttemptAt: new Date(0) } });
    }
    assert.equal(await db.agentEvent.count({ where: { entityId: invalidResponseMessage.id } }), 0);
    const failedListing = await api('/importance-triage?status=failed&limit=100');
    assert.equal(failedListing.status, 200);
    assert.ok(failedListing.body.triages.some((record) => record.sourceMessageId === invalidResponseMessage.id && record.lastErrorCode === 'AI_INVALID_RESPONSE'));
  });
  await test('M19 unsupported AI evidence stays in review without waking the Agent', async () => {
    const unsupported = mail('client@customer.test', 'New project request', 'Please send a revised quote for the stand.');
    await persist([unsupported], { incremental: true, emitAgentEvents: true });
    const message = await messageFor(unsupported);
    importanceResult = triageResult('high', 'customer_inquiry', 'This exact evidence is absent from the email.');
    await importanceTriage.processBatch(1);
    const record = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: message.id } });
    assert.equal(record.status, 'review');
    assert.equal(record.importance, 'uncertain');
    assert.equal(record.lastErrorCode, 'TRIAGE_EVIDENCE_NOT_VERIFIABLE');
    assert.deepEqual(record.evidenceJson, []);
    assert.equal(await db.agentEvent.count({ where: { entityId: message.id } }), 0);
    const reviewListing = await api('/importance-triage?status=review&limit=100');
    assert.equal(reviewListing.status, 200);
    assert.ok(reviewListing.body.triages.some((item) => item.id === record.id && item.lastErrorCode === 'TRIAGE_EVIDENCE_NOT_VERIFIABLE'));
  });
  await test('M19 review/failed reruns require audited stable operation IDs across API, CLI and MCP', async () => {
    const [firstId, otherId] = failedTriageIds;
    assert.ok(firstId && otherId);
    assert.equal((await api(`/importance-triage/${firstId}/retry`, 'POST', {})).status, 400);
    const body = { operationId: 'm19-triage-retry-stable' };
    const http = await api(`/importance-triage/${firstId}/retry`, 'POST', body);
    assert.equal(http.status, 200); assert.equal(http.body.status, 'pending'); assert.equal(http.body.attempts, 0);
    const replay = await api(`/importance-triage/${firstId}/retry`, 'POST', body);
    assert.deepEqual(replay.body, http.body);
    const audit = await db.businessOperation.findUniqueOrThrow({ where: { operationId: body.operationId } });
    assert.equal(audit.entityType, 'email_importance_triage'); assert.equal(audit.entityId, firstId); assert.equal(audit.action, 'retry');
    assert.equal((await api(`/importance-triage/${otherId}/retry`, 'POST', body)).status, 409);
    const reviewRetry = await api(`/importance-triage/${reviewTriageId}/retry`, 'POST', { operationId: 'm19-review-retry-stable' });
    assert.equal(reviewRetry.status, 200); assert.equal(reviewRetry.body.status, 'pending');
    assert.deepEqual(await childJson('ai-mail.mjs', ['importance-triage-retry', firstId, body.operationId]), http.body);
    const mcp = await childJson('ai-mail-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'retry_email_importance_triage', arguments: { triageId: firstId, operationId: body.operationId },
    } }) + '\n');
    assert.deepEqual(JSON.parse(mcp[0].result.content[0].text), http.body);
    const reused = await childJson('ai-mail-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'retry_email_importance_triage', arguments: { triageId: otherId, operationId: body.operationId },
    } }) + '\n');
    assert.equal(reused[0].result.isError, true);
  });
  await test('M19 migration suppresses legacy mail-arrival wakeups and retains both missing and existing candidates for review', async () => {
    const noTriageWire = mail('client@customer.test', 'Legacy pending mail', 'Please send the updated plan.');
    const existingTriageWire = mail('client@customer.test', 'Legacy processing mail', 'Please send the revised quote.');
    await persist([noTriageWire]);
    await persist([existingTriageWire], { incremental: true, emitAgentEvents: true });
    const noTriageMessage = await messageFor(noTriageWire), existingTriageMessage = await messageFor(existingTriageWire);
    const legacyEvents = [];
    for (const [message, state] of [[noTriageMessage, 'pending'], [existingTriageMessage, 'processing']]) {
      const event = await db.agentEvent.create({ data: {
        eventKey: `mail-arrival:${message.id}`, eventType: 'INBOUND_EMAIL_RECEIVED', entityType: 'email_message', entityId: message.id,
        payloadJson: {}, status: state, leaseExpiresAt: state === 'processing' ? new Date(Date.now() + 60_000) : null,
      } });
      await db.agentWakeupDelivery.create({ data: { eventId: event.id, status: state === 'processing' ? 'sending' : 'pending', leaseExpiresAt: state === 'processing' ? new Date(Date.now() + 60_000) : null } });
      legacyEvents.push(event);
    }
    const sql = readFileSync('prisma/migrations/20260929140000_m19_suppress_legacy_arrival_events/migration.sql', 'utf8')
      .replace(/^\s*--.*$/gm, '').split(';').map(statement => statement.trim()).filter(statement => statement && !/^(BEGIN|COMMIT)$/i.test(statement));
    for (let repeat = 0; repeat < 2; repeat++) {
      await db.$transaction(async tx => { for (const statement of sql) await tx.$executeRawUnsafe(statement); });
    }
    for (const event of legacyEvents) {
      const stored = await db.agentEvent.findUniqueOrThrow({ where: { id: event.id } });
      const wakeup = await db.agentWakeupDelivery.findUniqueOrThrow({ where: { eventId: event.id } });
      assert.equal(stored.status, 'ignored'); assert.equal(stored.lastError, 'LEGACY_ARRIVAL_EVENT_SUPPRESSED');
      assert.equal(wakeup.status, 'failed'); assert.equal(wakeup.lastError, 'LEGACY_ARRIVAL_EVENT_SUPPRESSED');
    }
    for (const message of [noTriageMessage, existingTriageMessage]) {
      const triage = await db.emailImportanceTriage.findUniqueOrThrow({ where: { sourceMessageId: message.id } });
      assert.equal(triage.status, 'review'); assert.equal(triage.lastErrorCode, 'LEGACY_ARRIVAL_EVENT_SUPPRESSED');
    }
  });
  await test('M4 Mailinblack sender matching ignores display-name impersonation', async () => {
    const wire = mail('"invite@invitations.mailinblack.com" <actual@customer.test>');
    assert.equal(classifyMail({ ...wire, direction: 'inbound', subject: '', fromJson: [{ address: 'actual@customer.test' }], toJson: [] }).classification, 'BUSINESS_HUMAN');
  });
  await test('M6-M7 contact/project resolution and manual decision survive reprocessing', async () => {
    await gate.classifyImported(); await contacts.resolveImported(); await projects.resolveImported();
    let m = await db.emailMessage.findUniqueOrThrow({ where: { id: source.id } });
    assert.equal(m.contactId, null, 'unregistered senders remain unlinked until an operator creates a contact');
    assert.equal(m.contactResolutionStatus, 'unresolved');
    assert.equal(await db.reviewItem.count({ where: { entityType: 'contact', reasonCode: 'CONTACT_PROVISIONAL' } }), 0);
    const count = await db.reviewItem.count(); await projects.resolveImported(); assert.equal(await db.reviewItem.count(), count);
    const contactInput = { email: 'client@customer.test', displayName: 'Client', actorId: 'acceptance', operationId: 'accept-contact-create' };
    const contactCreated = await api('/crm/contacts', 'POST', contactInput); assert.equal(contactCreated.status, 201);
    const contact = contactCreated.body;
    assert.equal(contact.status, 'confirmed');
    assert.equal((await api('/crm/contacts', 'POST', contactInput)).body.id, contact.id);
    await contacts.resolveImported([source.id]);
    m = await db.emailMessage.findUniqueOrThrow({ where: { id: source.id } });
    assert.equal(m.contactId, contact.id, 'manually registered exact email matches existing history');
    const companyInput = { name: 'Acceptance Customer', domain: 'customer.test', contactIds: [contact.id], actorId: 'acceptance', operationId: 'accept-company-create' };
    const companyCreated = await api('/crm/companies', 'POST', companyInput); assert.equal(companyCreated.status, 201);
    const company = companyCreated.body;
    assert.equal((await api('/crm/companies', 'POST', companyInput)).body.id, company.id);
    const companyOperation = await db.businessOperation.findUniqueOrThrow({ where: { operationId: companyInput.operationId } });
    assert.equal(companyOperation.actorId, 'acceptance'); assert.equal(companyOperation.entityId, company.id);
    assert.deepEqual(companyOperation.afterJson.contactIds, [contact.id]);
    assert.equal((await api('/crm/companies', 'POST', { ...companyInput, name: 'Changed company' })).status, 409);

    const contactOperation = await db.businessOperation.findUniqueOrThrow({ where: { operationId: contactInput.operationId } });
    assert.equal(contactOperation.entityId, contact.id); assert.equal(contactOperation.beforeJson, null); assert.equal(contactOperation.afterJson.status, 'confirmed');

    const projectInput = { name: 'Acceptance project', companyId: company.id, contactIds: [contact.id], primaryContactId: contact.id, actorId: 'acceptance', operationId: 'accept-project-create' };
    const projectCreated = await api('/projects', 'POST', projectInput); assert.equal(projectCreated.status, 201);
    project = projectCreated.body;
    assert.equal((await api('/projects', 'POST', projectInput)).body.id, project.id);
    const projectOperation = await db.businessOperation.findUniqueOrThrow({ where: { operationId: projectInput.operationId } });
    assert.equal(projectOperation.entityId, project.id); assert.equal(projectOperation.actorId, 'acceptance');
    topic = await projects.createTopic(project.id, { name: 'Drawing', type: 'design' });
    const review = await db.reviewItem.create({ data: { entityType: 'email_message', entityId: source.id, sourceMessageId: source.id,
      reasonCode: 'PROJECT_UNRESOLVED', confidence: 0, dedupeKeyBase: `accept-project-review:${source.id}`, dedupeKey: `accept-project-review:${source.id}:1` } });
    await projects.resolveReview(review.id, { action: 'assign_project', projectId: project.id, topicId: topic.id, operationId: 'assign-project', actorId: 'acceptance' });
    await projects.resolveImported(); m = await db.emailMessage.findUniqueOrThrow({ where: { id: source.id } });
    assert.equal(m.projectId, project.id); assert.equal(m.topicId, topic.id); assert.equal(m.projectManualOverride, true); source = m;
  });
  await test('M9-M11 task CRUD, idempotency, version conflicts and mixed waiting state', async () => {
    const body = { operationId: 'create-task', title: 'Revised drawing', projectId: project.id, kind: 'reply', ownerType: 'us', waitingOn: 'us' };
    task = await records.createTask(body); assert.equal((await records.createTask(body)).id, task.id);
    await assert.rejects(records.createTask({ ...body, title: 'Different' }), e => e.status === 409);
    await records.createTask({ operationId: 'customer-task', title: 'Confirm drawing', projectId: project.id, ownerType: 'customer', waitingOn: 'customer' });
    let p = await projects.getProject(project.id); assert.equal(p.waitingOn, 'mixed'); assert.equal(p.replyRequired, true);
    const updates = await Promise.allSettled([records.updateTask(task.id, { operationId: 'update-a', expectedVersion: 1, status: 'done' }), records.updateTask(task.id, { operationId: 'update-b', expectedVersion: 1, status: 'done' })]);
    assert.equal(updates.filter(r => r.status === 'fulfilled').length, 1);
    p = await projects.getProject(project.id); assert.equal(p.waitingOn, 'customer'); assert.equal(p.replyRequired, false);
    const requirement = await records.createRequirement({ operationId: 'req-create', projectId: project.id, text: 'Use blue finish', sourceMessageId: source.id });
    assert.equal((await records.updateRequirement(requirement.id, { operationId: 'req-update', expectedVersion: 1, status: 'accepted' })).manualOverride, true);
    const decision = await records.createDecision({ operationId: 'decision-create', projectId: project.id, text: 'Drawing approved', sourceMessageId: source.id });
    assert.equal((await records.updateDecision(decision.id, { operationId: 'decision-update', expectedVersion: 1, status: 'accepted' })).manualOverride, true);
    assert.ok((await summaries.projectTimeline(project.id, 100, 0)).total >= 5);
  });
  await test('M8-M11 AI validation, explicit apply, source evidence and manual override', async () => {
    providerResult = result(source, [operation(source, { title: 'Revised drawing', kind: 'action', owner_type: 'us', waiting_on: 'us', status: 'open', priority: 'normal' })]);
    analysis = await analyzer.analyze(source.id, 'analysis-good'); assert.equal(analysis.validationStatus, 'valid');
    const count = await db.task.count(); const applied = await records.applyAnalysis(analysis.id, { operationId: 'apply-good', operationIndexes: [0] });
    await records.applyAnalysis(analysis.id, { operationId: 'apply-again', operationIndexes: [0] }); assert.equal(await db.task.count(), count + 1);
    assert.equal(applied.records[0].createdFromMessageId, source.id);
    const aiTask = applied.records[0]; await records.updateTask(aiTask.id, { operationId: 'manual-ai-task', expectedVersion: aiTask.version, title: 'User confirmed drawing task' });
    providerResult = result(source, [operation(source, { title: 'Model rename' }, { action: 'update', target_id: aiTask.id })]);
    const updated = await analyzer.analyze(source.id, 'analysis-update'); assert.equal(updated.validationStatus, 'valid');
    await assert.rejects(records.applyAnalysis(updated.id, { operationId: 'apply-protected', operationIndexes: [0] }), e => e.status === 409);
    providerResult = { malformed: true }; await assert.rejects(analyzer.analyze(source.id, 'analysis-bad'), e => e.status === 502);
    providerResult = result(source, [operation(source, { title: 'Unsupported' }, { evidence: 'Invented statement absent from this message' })]);
    const invalid = await analyzer.analyze(source.id, 'analysis-evidence'); assert.equal(invalid.validationStatus, 'review_required');
    await assert.rejects(records.applyAnalysis(invalid.id, { operationId: 'apply-invalid', operationIndexes: [0] }), e => e.status === 409);
  });
  await test('M10 summary versions, rollback and project stage audit', async () => {
    const first = await summaries.applyAnalysisSummary(analysis.id, { operationId: 'summary-one', entityType: 'project', entityId: project.id, expectedVersion: 0 });
    const before = await db.task.findMany({ orderBy: { id: 'asc' } });
    await assert.rejects(summaries.applyAnalysisSummary(analysis.id, { operationId: 'summary-stale', entityType: 'project', entityId: project.id, expectedVersion: 1 }), e => e.status === 409 && e.response.code === 'SUMMARY_INPUT_STALE');
    providerResult = result(source, []);
    const freshSummaryRun = await analyzer.analyze(analysis.sourceMessageId, 'summary-refresh');
    await summaries.applyAnalysisSummary(freshSummaryRun.id, { operationId: 'summary-two', entityType: 'project', entityId: project.id, expectedVersion: 1 });
    assert.equal((await summaries.rollback({ operationId: 'summary-rollback', summaryId: first.id, expectedVersion: 2, targetVersion: 1 })).version, 3);
    assert.deepEqual(await db.task.findMany({ orderBy: { id: 'asc' } }), before);
    const p = await projects.getProject(project.id); assert.equal((await summaries.changeProjectStage(p.id, { operationId: 'stage', expectedVersion: p.version, stage: 'quotation' })).stage, 'quotation');
  });
  await test('M12 concurrent claim, lease recovery, notification allowlist and replay', async () => {
    const event = await db.agentEvent.create({ data: { eventKey: 'acceptance-event', eventType: 'TEST', entityType: 'test', entityId: 'test', notificationPolicy: 'REALTIME', payloadJson: {} } });
    const claims = await Promise.all([events.claim('a', 1, 60, event.id), events.claim('b', 1, 60, event.id)]); assert.equal(claims.flat().length, 1);
    await db.agentEvent.update({ where: { id: event.id }, data: { leaseExpiresAt: new Date(0) } });
    const [claimed] = await events.claim('recovered', 1, 60, event.id); assert.ok(claimed);
    const body = { agentId: 'recovered', leaseToken: claimed.leaseToken, result: { z: 1, a: 2 }, notifications: [{ requestKey: 'notify-once', channel: 'telegram', recipientRef: 'test-chat', content: 'Synthetic acceptance notification' }] };
    await assert.rejects(events.complete(event.id, { ...body, notifications: [{ ...body.notifications[0], recipientRef: 'not-allowed' }] }), e => e.status === 409);
    await events.complete(event.id, body); assert.equal((await events.complete(event.id, body)).replayed, true);
    assert.equal(await db.notificationDelivery.count({ where: { eventId: event.id } }), 1);
  });
  await test('M12 expired event observes its own retry limit', async () => {
    const event = await db.agentEvent.create({ data: { eventKey: 'exhausted', eventType: 'TEST', entityType: 'test', entityId: 'test', status: 'processing', attempts: 2, maxAttempts: 2, leaseExpiresAt: new Date(0), payloadJson: {} } });
    assert.equal((await events.claim('recovery', 1, 60, event.id)).length, 0);
    assert.equal((await db.agentEvent.findUniqueOrThrow({ where: { id: event.id } })).status, 'failed');
  });
  await test('M22 actionable high and urgent human events require an allowlisted notification', async () => {
    const wire = mail('client@customer.test', 'Current actionable request', 'Please send the current offer.');
    await persist([wire], { incremental: true, emitAgentEvents: true });
    const notificationSource = await messageFor(wire);
    assert.equal(notificationSource.classification, 'BUSINESS_HUMAN');
    assert.equal(notificationSource.historicalImport, false);
    // This fixture exercises event completion, independently of importance model processing.
    await db.projectAnalysisItem.updateMany({
      where: { sourceMessageId: notificationSource.id, status: { in: ['pending', 'processing'] } },
      data: { status: 'completed', outcome: 'acceptance_analysis_finished', analyzedAt: new Date() },
    });
    await db.emailImportanceTriage.update({ where: { sourceMessageId: notificationSource.id }, data: { status: 'quiet' } });
    for (const importance of ['high', 'urgent']) {
      const event = await db.agentEvent.create({ data: {
        eventKey: `acceptance-actionable-${importance}`, eventType: 'INBOUND_EMAIL_RECEIVED',
        entityType: 'email_message', entityId: notificationSource.id, notificationPolicy: 'REALTIME',
        payloadJson: { sourceMessageId: notificationSource.id, classification: 'BUSINESS_HUMAN', importance },
      } });
      const [claimed] = await events.claim(`acceptance-actionable-${importance}`, 1, 60, event.id);
      assert.ok(claimed);
      const base = { agentId: `acceptance-actionable-${importance}`, leaseToken: claimed.leaseToken };
      await assert.rejects(events.complete(event.id, { ...base, result: {} }), error => error.status === 400 && error.response?.code === 'ACTIONABLE_DECISION_REQUIRED');
      await assert.rejects(events.complete(event.id, { ...base, result: { actionable: true } }), error => error.status === 409 && error.response?.code === 'ACTIONABLE_NOTIFICATION_REQUIRED');
      assert.equal(await db.notificationDelivery.count({ where: { eventId: event.id } }), 0);
      const notice = { requestKey: `acceptance-actionable-${importance}-notice`, channel: 'telegram', recipientRef: 'test-chat', content: '客户请求需要跟进' };
      const completion = { ...base, result: { actionable: true }, notifications: [notice] };
      assert.equal((await events.complete(event.id, completion)).notifications.length, 1);
      assert.equal((await events.complete(event.id, completion)).replayed, true);
      assert.equal(await db.notificationDelivery.count({ where: { eventId: event.id } }), 1);
      // This fixture verifies the outbox request, not transport; keep it out of later delivery tests.
      await db.notificationDelivery.update({ where: { requestKey: notice.requestKey }, data: { status: 'failed', lastError: 'ACCEPTANCE_FIXTURE_NO_TRANSPORT' } });
    }
  });
  await test('M22 clear customer decline may complete silently after an explicit non-actionable decision', async () => {
    const decline = mail('partners@refusal.test', 'Re: CES booth offer', 'Thank you. We are not reviewing booth partners and need no follow-up.');
    await persist([decline]);
    const message = await messageFor(decline);
    assert.equal(message.classification, 'BUSINESS_HUMAN');
    const event = await db.agentEvent.create({ data: {
      eventKey: 'acceptance-explicit-decline', eventType: 'INBOUND_EMAIL_RECEIVED',
      entityType: 'email_message', entityId: message.id, notificationPolicy: 'REALTIME',
      payloadJson: { sourceMessageId: message.id, classification: 'BUSINESS_HUMAN', importance: 'high' },
    } });
    const [claimed] = await events.claim('acceptance-explicit-decline', 1, 60, event.id);
    assert.ok(claimed);
    const completion = { agentId: 'acceptance-explicit-decline', leaseToken: claimed.leaseToken, result: { actionable: false, reason: 'Clear refusal without a request or next action.' } };
    await assert.rejects(events.complete(event.id, { ...completion, notifications: [{ requestKey: 'decline-must-stay-silent', channel: 'telegram', recipientRef: 'test-chat', content: 'Must not be queued' }] }),
      error => error.status === 409 && error.response?.code === 'NON_ACTIONABLE_NOTIFICATION_BLOCKED');
    assert.equal(await db.notificationDelivery.count({ where: { eventId: event.id } }), 0);
    assert.equal((await events.complete(event.id, completion)).notifications.length, 0);
    assert.equal((await events.complete(event.id, completion)).replayed, true);
    assert.equal(await db.notificationDelivery.count({ where: { eventId: event.id } }), 0);
  });
  await test('M14 review summary waits for terminal events and creates one idempotent wakeup', async () => {
    assert.ok(await db.agentEvent.count({ where: { status: 'pending', eventType: { not: 'BACKLOG_REVIEW_SUMMARY' } } }));
    await assert.rejects(events.createBacklogReviewSummary('premature-run'), error => error.status === 409);
    assert.equal(await db.agentEvent.count({ where: { eventType: 'BACKLOG_REVIEW_SUMMARY' } }), 0);
    await db.agentEvent.updateMany({ where: { status: 'pending' }, data: { status: 'completed', processedAt: now, resultJson: { fixture: true } } });
    const summary = await events.createBacklogReviewSummary('acceptance-final-run');
    assert.equal(summary.replayed, false); assert.equal(summary.status, 'pending');
    assert.ok(summary.payload.totalEvents > 0); assert.ok(Array.isArray(summary.payload.eventCounts));
    assert.equal(await db.agentWakeupDelivery.count({ where: { eventId: summary.eventId } }), 1);
    const replay = await events.createBacklogReviewSummary('acceptance-final-run');
    assert.equal(replay.replayed, true); assert.equal(replay.eventId, summary.eventId);
    assert.equal(await db.agentEvent.count({ where: { eventType: 'BACKLOG_REVIEW_SUMMARY' } }), 1);
  });
  await test('M13 API/CLI/MCP read parity and mutation error propagation', async () => {
    const http = await api('/tasks?status=open'); const cli = await childJson('ai-mail.mjs', ['tasks', '--status', 'open']);
    assert.deepEqual(cli, http.body);
    const classificationHttp = await api('/classifications/summary');
    const withoutGenerationTime = ({ generatedAt, ...value }) => value;
    assert.deepEqual(withoutGenerationTime(await childJson('ai-mail.mjs', ['classification-summary'])), withoutGenerationTime(classificationHttp.body));
    const classifiedCli = await childJson('ai-mail.mjs', ['classified-emails', 'DELIVERY_FAILURE']);
    assert.ok(classifiedCli.messages.every(message => message.classification === 'DELIVERY_FAILURE'));
    const triageHttp = await api('/importance-triage?status=all');
    assert.deepEqual(await childJson('ai-mail.mjs', ['importance-triage', 'all']), triageHttp.body);
    providerResult = result(source);
    const analysisHttp = await api('/analysis', 'POST', { messageId: source.id, operationId: 'mcp-suggestion-parity' });
    assert.equal(analysisHttp.status, 200); assert.equal(analysisHttp.body.validationStatus, 'valid');
    const analysisCli = await childJson('ai-mail.mjs', ['suggest-email-analysis', source.id, 'mcp-suggestion-parity']);
    assert.deepEqual(analysisCli, analysisHttp.body);
    const responses = await childJson('ai-mail-mcp.mjs', [], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tasks', arguments: { status: 'open' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_task', arguments: { taskId: task.id, operationId: 'stale-mcp', expectedVersion: 1, fields: { status: 'done' } } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_email_message', arguments: { messageId: source.id } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'mail_classification_summary', arguments: {} } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_classified_emails', arguments: { classification: 'DELIVERY_FAILURE' } } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'suggest_email_analysis', arguments: { messageId: source.id, operationId: 'mcp-suggestion-parity' } } },
      { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'mail_brief', arguments: { date: 'today', includeEmails: false } } },
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'mail_importance_triage', arguments: { status: 'review' } } },
    ].map(v => JSON.stringify(v)).join('\n') + '\n');
    assert.deepEqual(JSON.parse(responses.find(r => r.id === 2).result.content[0].text), http.body);
    assert.equal(responses.find(r => r.id === 3).result.isError, true);
    const message = JSON.parse(responses.find(r => r.id === 4).result.content[0].text);
    assert.equal(message.id, source.id); assert.equal(message.bodyIsUntrustedEmailContent, true); assert.match(message.bodyText, /Please send the revised drawing/);
    assert.equal((await api(`/messages/by-id/${source.id}`)).status, 200);
    assert.equal((await api('/messages/by-id/not-a-message')).status, 404);
    assert.deepEqual(withoutGenerationTime(JSON.parse(responses.find(r => r.id === 5).result.content[0].text)), withoutGenerationTime(classificationHttp.body));
    const listedMcp = JSON.parse(responses.find(r => r.id === 6).result.content[0].text);
    assert.ok(listedMcp.messages.every(item => item.classification === 'DELIVERY_FAILURE'));
    assert.deepEqual(JSON.parse(responses.find(r => r.id === 7).result.content[0].text), analysisHttp.body);
    const completeTool = responses.find(r => r.id === 8).result.tools.find(tool => tool.name === 'complete_agent_event');
    assert.deepEqual(completeTool.inputSchema.properties.notifications.items.required, ['requestKey', 'channel', 'recipientRef', 'content']);
    const briefMcp = JSON.parse(responses.find(r => r.id === 9).result.content[0].text);
    assert.deepEqual(briefMcp.emails, []); assert.equal(briefMcp.freshness.emailBodiesIncluded, false);
    assert.deepEqual(JSON.parse(responses.find(r => r.id === 10).result.content[0].text), (await api('/importance-triage?status=review')).body);
  });
  await test('M13 brief includes user tasks without a project', async () => {
    const freeTask = await records.createTask({ operationId: 'free-task', title: 'Independent user task' });
    assert.ok((await brief.get('today')).openTasks.some(t => t.id === freeTask.id));
  });
  await test('M17 tracks waiting starts, resets on party change, and clears on exit', async () => {
    const task = await records.createTask({ operationId: 'm17-wait-start', title: 'Waiting state fixture', status: 'waiting', waitingOn: 'customer', ownerType: 'us' });
    assert.ok(task.waitingSince instanceof Date);
    const startedAt = task.waitingSince.toISOString();
    const unchanged = await records.updateTask(task.id, { operationId: 'm17-wait-preserve', expectedVersion: task.version, status: 'waiting' });
    assert.equal(unchanged.waitingSince.toISOString(), startedAt);
    const reassigned = await records.updateTask(task.id, { operationId: 'm17-wait-reassign', expectedVersion: unchanged.version, waitingOn: 'third_party' });
    assert.ok(reassigned.waitingSince.getTime() >= unchanged.waitingSince.getTime());
    const resumed = await records.updateTask(task.id, { operationId: 'm17-wait-exit', expectedVersion: reassigned.version, status: 'in_progress' });
    assert.equal(resumed.waitingSince, null);
  });
  await test('M17 brief reports bounded structured follow-ups and can omit email excerpts', async () => {
    const overdue = await records.createTask({ operationId: 'm17-overdue', title: 'Overdue follow-up fixture', ownerType: 'us', deadlineAt: new Date(Date.now() - 2 * 86400000).toISOString() });
    const waiting = await records.createTask({ operationId: 'm17-customer-wait', title: 'Customer wait fixture', status: 'waiting', waitingOn: 'customer', ownerType: 'us' });
    await db.task.update({ where: { id: waiting.id }, data: { waitingSince: new Date(Date.now() - 9 * 86400000) } });
    await records.createTask({ operationId: 'm17-mixed-wait', title: 'Mixed wait fixture', status: 'waiting', waitingOn: 'mixed', ownerType: 'us' });
    const lead = await db.project.create({ data: { name: 'M17 synthetic lead', stage: 'lead' } });
    await db.reviewItem.create({ data: { entityType: 'project', entityId: lead.id, reasonCode: 'M17_ACCEPTANCE_FIXTURE', confidence: 0.5, dedupeKeyBase: randomUUID(), dedupeKey: randomUUID() } });
    const fixtureCorrection = await db.agentEvent.create({ data: { eventKey: `m17-reconciliation:${randomUUID()}`, eventType: 'MAIL_RECONCILIATION_CORRECTED', entityType: 'mail_account', entityId: account.id, payloadJson: { importedCount: 1, processingRecordsCreated: 2, crmRepaired: 3, needsReviewCount: 0 } } });
    const report = await brief.get('today', undefined, false);
    await db.agentEvent.delete({ where: { id: fixtureCorrection.id } });
    const reportCli = await childJson('ai-mail.mjs', ['brief', 'today', '--no-emails']);
    assert.deepEqual(reportCli.emails, []); assert.equal(reportCli.freshness.emailBodiesIncluded, false);
    assert.deepEqual(report.emails, []); assert.equal(report.freshness.emailBodiesIncluded, false);
    assert.equal(report.preferences.language, 'zh-CN'); assert.equal(report.preferences.waitingThresholdDays, 7);
    assert.equal(report.followUps.taskScanComplete, true);
    assert.ok(report.followUps.overdue.tasks.some(item => item.id === overdue.id));
    assert.ok(report.followUps.waitingForCustomer.tasks.some(item => item.id === waiting.id && item.daysWaiting >= 7));
    assert.ok(report.followUps.waitingByParty.mixed >= 1);
    assert.ok(report.audit.newLeads.projects.some(item => item.id === lead.id));
    assert.ok(report.audit.pendingReviews.count >= 1);
    assert.ok(report.audit.reconciliation.correctionEventCount >= 1);
    assert.ok(report.audit.reconciliation.totals.crmRepaired >= 3);
    assert.equal((await api('/brief?includeEmails=no')).status, 400);
    assert.deepEqual((await api('/brief?includeEmails=false')).body.emails, []);
  });
  await test('M19 brief reports current importance triage counts without email bodies and preserves M17 date/schema', async () => {
    const privateBodies = [
      'M19_PRIVATE_REVIEW_BODY_DO_NOT_EXPOSE',
      'M19_PRIVATE_FAILED_BODY_DO_NOT_EXPOSE',
      'M19_PRIVATE_PENDING_BODY_DO_NOT_EXPOSE',
    ];
    const fixtures = privateBodies.map((body, index) => mail(`triage-${index}@customer.test`, `Triage count fixture ${index}`, body));
    await persist(fixtures, { incremental: true });
    const messages = await Promise.all(fixtures.map(messageFor));
    const statuses = ['review', 'failed', 'pending'];
    const before = Object.fromEntries(await Promise.all(statuses.map(async status => [
      status, await db.emailImportanceTriage.count({ where: { mailAccountId: account.id, status } }),
    ])));
    await Promise.all(statuses.map((status, index) => db.emailImportanceTriage.create({ data: {
      mailAccountId: account.id, sourceMessageId: messages[index].id, source: 'realtime', status,
      ...(status === 'review' ? { importance: 'uncertain', confidence: 0.4, reason: 'Synthetic low-confidence review fixture.' } : {}),
      ...(status === 'failed' ? { lastErrorCode: 'TRIAGE_ACCEPTANCE_FAILURE' } : {}),
    } })));

    const expectedCounts = Object.fromEntries(statuses.map(status => [status, before[status] + 1]));
    const serviceReport = await brief.get('today', undefined, false);
    const triage = serviceReport.audit.emailImportanceTriage;
    assert.ok(typeof triage.asOf === 'string' && !Number.isNaN(Date.parse(triage.asOf)));
    assert.equal(triage.reviewCount, expectedCounts.review);
    assert.equal(triage.failedCount, expectedCounts.failed);
    assert.equal(triage.pendingCount, expectedCounts.pending);
    assert.deepEqual(serviceReport.emails, []);
    assert.equal(serviceReport.freshness.emailBodiesIncluded, false);
    assert.equal(serviceReport.preferences.language, 'zh-CN');
    assert.equal(typeof serviceReport.followUps.taskScanComplete, 'boolean');
    assert.equal(typeof serviceReport.audit.pendingReviews.count, 'number');
    assert.equal(typeof serviceReport.audit.inboundClassifications.actionableCount, 'number');
    assert.equal(typeof serviceReport.audit.reconciliation.correctionEventCount, 'number');
    assert.ok(!JSON.stringify(serviceReport).includes('M19_PRIVATE_'));

    const apiReport = (await api('/brief?includeEmails=false')).body;
    const cliReport = await childJson('ai-mail.mjs', ['brief', 'today', '--no-emails']);
    const mcpResponses = await childJson('ai-mail-mcp.mjs', [], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mail_brief', arguments: { date: 'today', includeEmails: false } } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const mcpReport = JSON.parse(mcpResponses.find(response => response.id === 2).result.content[0].text);
    for (const report of [apiReport, cliReport, mcpReport]) {
      const reportTriage = report.audit.emailImportanceTriage;
      assert.ok(typeof reportTriage.asOf === 'string' && !Number.isNaN(Date.parse(reportTriage.asOf)));
      assert.equal(reportTriage.reviewCount, expectedCounts.review);
      assert.equal(reportTriage.failedCount, expectedCounts.failed);
      assert.equal(reportTriage.pendingCount, expectedCounts.pending);
      assert.deepEqual(report.emails, []);
      assert.equal(report.freshness.emailBodiesIncluded, false);
      assert.ok(!JSON.stringify(report).includes('M19_PRIVATE_'));
    }

    const spring = await brief.get('2026-03-29', undefined, false);
    const autumn = await brief.get('2026-10-25', undefined, false);
    assert.equal((Date.parse(spring.rangeUtc.until) - Date.parse(spring.rangeUtc.from)) / 3600000, 23);
    assert.equal((Date.parse(autumn.rangeUtc.until) - Date.parse(autumn.rangeUtc.from)) / 3600000, 25);
    assert.equal(spring.date, '2026-03-29');
    assert.equal(autumn.date, '2026-10-25');
    for (const report of [spring, autumn]) {
      const reportTriage = report.audit.emailImportanceTriage;
      assert.equal(reportTriage.reviewCount, expectedCounts.review);
      assert.equal(reportTriage.failedCount, expectedCounts.failed);
      assert.equal(reportTriage.pendingCount, expectedCounts.pending);
      assert.equal(typeof report.preferences.waitingThresholdDays, 'number');
      assert.equal(typeof report.followUps.waitingForCustomer.count, 'number');
      assert.equal(typeof report.audit.pendingReviews.count, 'number');
      assert.equal(typeof report.audit.inboundClassifications.count, 'number');
      assert.equal(typeof report.audit.reconciliation.status, 'string');
    }
  });
  await test('M13 sender query filters before the 200-message limit', async () => {
    const day = '2026-01-15'; const target = mail('target@sender.test', 'Target', 'Target mail', new Date(`${day}T09:00:00Z`));
    await persist([target]);
    for (let n = 0; n < 205; n += 5) await persist(Array.from({ length: 5 }, () => mail('other@sender.test', 'Other', 'Other mail', new Date(`${day}T10:00:00Z`))));
    const found = await brief.get(day, 'target@sender.test'); assert.equal(found.total, 1); assert.equal(found.emails.length, 1); assert.equal(found.truncated, false);
    const spring = await brief.get('2026-03-29'); assert.equal((Date.parse(spring.rangeUtc.until) - Date.parse(spring.rangeUtc.from)) / 3600000, 23);
    const autumn = await brief.get('2026-10-25'); assert.equal((Date.parse(autumn.rangeUtc.until) - Date.parse(autumn.rangeUtc.from)) / 3600000, 25);
    const categorySpring = await gate.classificationSummary('2026-03-29');
    assert.equal((Date.parse(categorySpring.rangeUtc.until) - Date.parse(categorySpring.rangeUtc.from)) / 3600000, 23);
    assert.equal((await api('/classifications/summary?date=not-a-date')).status, 400);
  });
  await test('Sent mail is queryable through API, CLI, MCP and contact history without changing inbound brief', async () => {
    const contact = await db.contact.create({ data: { displayName: 'Sent recipient', emails: { create: { email: 'recipient@customer.test' } } } });
    const inbound = mail('recipient@customer.test', 'Customer reply', 'Thank you.', new Date('2026-01-15T08:00:00Z'));
    await persist([inbound]);
    await db.emailMessage.update({ where: { id: (await messageFor(inbound)).id }, data: { contactId: contact.id } });
    const before = (await brief.get('2026-01-15', undefined, false)).total;
    const sentDate = new Date('2026-01-15T10:00:00Z');
    const outgoing = Buffer.from('From: owner@acceptance.test\r\nTo: Other <other@example.test>\r\nCc: Recipient <recipient@customer.test>\r\nSubject: Sent acceptance\r\nMessage-ID: <sent-acceptance@example.test>\r\nDate: Thu, 15 Jan 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSent body');
    const normalized = await new EmailNormalizer().normalize({ mailbox: 'Sent', uidValidity: 1n, uid: 50001, rawSource: outgoing, receivedAt: sentDate, accountEmail: account.email });
    const sent = await db.emailMessage.create({ data: { ...normalized, mailAccountId: account.id, mailbox: 'Sent', uidValidity: 1n, uid: 50001, classification: 'OUTREACH_OUTBOUND' } });
    await db.processingRecord.create({ data: {
      mailAccountId: account.id, sourceMessageId: sent.id, provider: 'imap', providerMessageId: sent.providerMessageId,
      classification: sent.classification, status: 'completed', analysisVersion: 'acceptance.sent-fixture',
    } });
    assert.equal(sent.direction, 'outbound');
    assert.equal((await brief.get('2026-01-15', undefined, false)).total, before);
    assert.equal((await api('/sent', 'GET', undefined, 'wrong')).status, 401);
    assert.equal((await api('/sent?date=invalid')).status, 400);
    assert.equal((await api('/sent?limit=0')).status, 400);
    const path = '/sent?date=2026-01-15&toEmail=recipient%40customer.test&limit=1&offset=0';
    const http = await api(path); assert.equal(http.status, 200); assert.equal(http.body.total, 1);
    assert.equal(http.body.messages[0].id, sent.id); assert.equal('bodyText' in http.body.messages[0], false);
    assert.equal((await api('/sent?toEmail=unrelated%40customer.test')).body.total, 0);
    assert.equal((await api('/sent?date=2026-01-15&toEmail=recipient%40customer.test&limit=1&offset=1')).body.messages.length, 0);
    const cli = await childJson('ai-mail.mjs', ['sent', '--date', '2026-01-15', '--to', 'recipient@customer.test', '--limit', '1', '--offset', '0']);
    assert.deepEqual(cli.messages, http.body.messages);
    const mcp = await childJson('ai-mail-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sent_emails', arguments: { date: '2026-01-15', toEmail: 'recipient@customer.test', limit: 1, offset: 0 } } }) + '\n');
    assert.deepEqual(JSON.parse(mcp[0].result.content[0].text).messages, http.body.messages);
    const history = await api(`/crm/contacts/${contact.id}/messages`);
    assert.equal(history.body.total, 2);
    assert.deepEqual(new Set(history.body.messages.map(item => item.id)), new Set([sent.id, (await messageFor(inbound)).id]));
    assert.equal(history.body.messages[0].id, sent.id);
    assert.equal((await api(`/crm/contacts/${contact.id}/messages?limit=1&offset=1`)).body.messages[0].id, (await messageFor(inbound)).id);
    assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: sent.id } })).contactId, null);
    const search = await api('/crm/contacts?search=recipient%40customer.test');
    assert.ok(search.body.contacts.some(item => item.id === contact.id));
    const oneCharacterSearch = await api('/crm/contacts?search=r');
    assert.equal(oneCharacterSearch.status, 200);
    assert.ok(oneCharacterSearch.body.contacts.some(item => item.id === contact.id));
    assert.equal((await api('/crm/contacts?search=x')).body.total, 0);
    const initialReply = await api(`/crm/contacts/${contact.id}/reply-status`);
    assert.equal(initialReply.body.status, 'no_human_reply_observed');
    assert.equal(initialReply.body.latestSent.id, sent.id);
    const unrelated = mail('recipient@customer.test', 'Another topic', 'Here is an unrelated update.', new Date('2026-01-15T10:30:00Z'));
    await persist([unrelated]);
    await db.emailMessage.update({ where: { id: (await messageFor(unrelated)).id }, data: { contactId: contact.id, classification: 'BUSINESS_HUMAN' } });
    assert.equal((await api(`/crm/contacts/${contact.id}/reply-status`)).body.status, 'later_human_message');
    const reply = mail('recipient@customer.test', 'Re: Sent acceptance', 'Yes, I confirm the drawing is approved.', new Date('2026-01-15T11:00:00Z'));
    reply.rawSource = Buffer.from(reply.rawSource.toString().replace('\r\n\r\n', '\r\nIn-Reply-To: <sent-acceptance@example.test>\r\nReferences: <sent-acceptance@example.test>\r\n\r\n'));
    await persist([reply]);
    const replyRow = await db.emailMessage.update({ where: { id: (await messageFor(reply)).id }, data: { contactId: contact.id, classification: 'BUSINESS_HUMAN' } });
    const replyStatus = await api(`/crm/contacts/${contact.id}/reply-status`);
    assert.equal(replyStatus.body.status, 'direct_human_reply');
    assert.equal(replyStatus.body.directReply.id, replyRow.id);
    const full = await api(`/crm/contacts/${contact.id}/messages?limit=4&includeBodies=true`);
    assert.equal(full.body.total, 4); assert.equal(full.body.hasMore, false);
    assert.equal(full.body.messages[0].id, replyRow.id);
    assert.match(full.body.messages[0].bodyText, /drawing is approved/);
    assert.equal((await api(`/crm/contacts/${contact.id}/messages?limit=21&includeBodies=true`)).status, 400);
    assert.equal((await api(`/crm/contacts/${contact.id}/messages?includeBodies=maybe`)).status, 400);
    const decision = await db.decision.create({ data: { text: 'Drawing approved', status: 'accepted', sourceMessageId: replyRow.id, decidedByContactId: contact.id } });
    const decisions = await api(`/crm/contacts/${contact.id}/decisions`);
    assert.ok(decisions.body.decisions.some(item => item.id === decision.id && item.sourceMessage.id === replyRow.id));
    const cliReply = await childJson('ai-mail.mjs', ['contact-reply-status', contact.id]); assert.equal(cliReply.status, replyStatus.body.status);
    const mcpReply = await childJson('ai-mail-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'contact_reply_status', arguments: { contactId: contact.id } } }) + '\n');
    assert.equal(JSON.parse(mcpReply[0].result.content[0].text).directReply.id, replyRow.id);
    const mcpDecisions = await childJson('ai-mail-mcp.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_contact_decisions', arguments: { contactId: contact.id } } }) + '\n');
    assert.ok(JSON.parse(mcpDecisions[0].result.content[0].text).decisions.some(item => item.id === decision.id));
    await db.decision.delete({ where: { id: decision.id } });
    await db.processingRecord.delete({ where: { sourceMessageId: sent.id } });
    await db.emailMessage.delete({ where: { id: sent.id } });
  });
  await test('M16 second audit provides evidence and history, then requires explicit review without overriding manual decisions', async () => {
    const wire = mail('offers@vendor.test', 'Special offer', 'Please send the revised drawing.'); await persist([wire]);
    const candidate = await messageFor(wire);
    await db.emailMessage.update({ where: { id: candidate.id }, data: { classification: 'SPAM', classificationReason: 'Synthetic first-pass false filter', classificationEvidence: ['Synthetic rule fixture'], reviewRequired: false, classificationManualOverride: false } });

    const filteredHttp = await api('/ai-audit/candidates?scope=filtered');
    assert.ok(filteredHttp.body.messages.some(message => message.id === candidate.id));
    assert.equal('bodyText' in filteredHttp.body.messages.find(message => message.id === candidate.id), false);
    assert.deepEqual(await childJson('ai-mail.mjs', ['audit-candidates', 'filtered']), filteredHttp.body);
    const mcp = await childJson('ai-mail-mcp.mjs', [], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_ai_audit_candidates', arguments: { scope: 'filtered' } } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    assert.deepEqual(JSON.parse(mcp.find(response => response.id === 2).result.content[0].text), filteredHttp.body);

    providerResult = result(candidate, [], { classification: 'BUSINESS_HUMAN', classification_evidence: ['Fabricated evidence not present in source'] });
    const unverified = await analyzer.analyze(candidate.id, 'm16-unverified-evidence');
    assert.equal(unverified.validationStatus, 'review_required');
    assert.equal(await db.reviewItem.count({ where: { sourceMessageId: candidate.id, reasonCode: 'AI_CLASSIFICATION_DISAGREEMENT' } }), 0);

    providerResult = result(candidate, [], { classification: 'BUSINESS_HUMAN', classification_confidence: 0.91, classification_evidence: ['Please send the revised drawing.'] });
    const audit = await analyzer.analyze(candidate.id, 'm16-verified-evidence');
    assert.equal(audit.validationStatus, 'valid');
    assert.equal(audit.inputSummaryJson.firstPassClassification.classification, 'SPAM');
    assert.deepEqual(audit.inputSummaryJson.priorAuditRunIds, [unverified.id]);
    assert.match(providerPrompt, /first_pass_classification/); assert.match(providerPrompt, /prior_ai_audits/);
    let stored = await db.emailMessage.findUniqueOrThrow({ where: { id: candidate.id } }); assert.equal(stored.classification, 'SPAM');
    const review = await db.reviewItem.findFirstOrThrow({ where: { sourceMessageId: candidate.id, reasonCode: 'AI_CLASSIFICATION_DISAGREEMENT', status: 'pending' } });
    assert.equal(review.proposedChangeJson.suggestedClassification, 'BUSINESS_HUMAN');
    assert.deepEqual(review.proposedChangeJson.evidence, ['Please send the revised drawing.']);
    const resolved = await api(`/reviews/${review.id}/resolve`, 'POST', { action: 'confirm_classification', classification: 'BUSINESS_HUMAN', actorId: 'acceptance-user', operationId: 'm16-confirm' });
    assert.equal(resolved.status, 200); assert.equal(resolved.body.status, 'resolved');
    assert.equal(resolved.body.resolutionJson.previousClassification, 'SPAM');
    assert.equal(resolved.body.resolutionJson.analysisRunId, audit.id);
    stored = await db.emailMessage.findUniqueOrThrow({ where: { id: candidate.id } }); assert.equal(stored.classificationManualOverride, true); assert.equal(stored.classification, 'BUSINESS_HUMAN');
    await gate.classifyImported();
    stored = await db.emailMessage.findUniqueOrThrow({ where: { id: candidate.id } }); assert.equal(stored.classification, 'BUSINESS_HUMAN');

    providerResult = result(candidate, [], { classification: 'SPAM', classification_evidence: ['Please send the revised drawing.'] });
    const recheck = await analyzer.analyze(candidate.id, 'm16-after-manual-confirm');
    assert.equal(recheck.inputSummaryJson.firstPassClassification.manualOverride, true);
    assert.equal(await db.reviewItem.count({ where: { sourceMessageId: candidate.id, reasonCode: 'AI_CLASSIFICATION_DISAGREEMENT', status: 'pending' } }), 0);
    const remainingFiltered = await analyzer.listAuditCandidates('filtered', 100, 0);
    assert.ok(!remainingFiltered.messages.some(message => message.id === candidate.id));
  });
  await test('M14 webhook retry, daily event deduplication, Telegram delivery and chat bridge (mock transport)', async () => {
    const savedFetch = global.fetch; let webhookMode = 'fail', sendMode = 'ok', eventCalls = 0, chatCalls = 0, sends = 0;
    const eventKeys = [];
    Object.assign(settings, { AGENT_EVENT_WEBHOOK_URL: 'https://agent.acceptance.test/events', AGENT_CHAT_WEBHOOK_URL: 'https://agent.acceptance.test/chat',
      AGENT_WEBHOOK_TOKEN: 'synthetic-webhook-token', TELEGRAM_BOT_TOKEN: 'synthetic-token', TELEGRAM_ALLOWED_CHAT_IDS: 'test-chat', TELEGRAM_ALLOWED_USER_IDS: 'test-user', DAILY_BRIEF_ENABLED: true, DAILY_BRIEF_TIME: '00:00', DAILY_BRIEF_LANGUAGE: 'zh-CN', DAILY_BRIEF_STYLE: 'concise', DAILY_BRIEF_WAITING_THRESHOLD_DAYS: 9, DAILY_BRIEF_FOLLOW_UP_WINDOW_DAYS: 5, DAILY_BRIEF_NOTIFY_WHEN_EMPTY: false });
    global.fetch = async (url, options) => {
      if (String(url).includes('agent.acceptance.test/events')) {
        eventCalls++; eventKeys.push(options.headers['Idempotency-Key']);
        return new Response('{}', { status: webhookMode === 'fail' ? 503 : 200 });
      }
      if (String(url).includes('agent.acceptance.test/chat')) { chatCalls++; return Response.json({ text: 'Synthetic assistant reply' }); }
      if (String(url).includes('/getUpdates')) return Response.json({ ok: true, result: [
        { update_id: 1, message: { message_id: 1, chat: { id: 'unauthorized-chat' }, from: { id: 'test-user' }, text: 'Ignored' } },
        { update_id: 2, message: { message_id: 2, chat: { id: 'test-chat' }, from: { id: 'test-user' }, text: 'Show today mail' } },
      ] });
      if (String(url).includes('api.telegram.org') && String(url).includes('/sendMessage')) {
        sends++; if (sendMode === 'network') throw new Error('Simulated response loss');
        if (sendMode === '429') return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 });
        return Response.json({ ok: true, result: { message_id: 123 } });
      }
      throw new Error('Unexpected external request in acceptance');
    };
    try {
      await db.agentWakeupDelivery.updateMany({ data: { status: 'delivered', deliveredAt: new Date() } });
      await integrations.ensureDailyBriefEvent(); await integrations.ensureDailyBriefEvent();
      assert.equal(await db.agentEvent.count({ where: { eventType: 'DAILY_BRIEF' } }), 1);
      const scheduledBrief = await db.agentEvent.findFirstOrThrow({ where: { eventType: 'DAILY_BRIEF' } });
      assert.deepEqual(scheduledBrief.payloadJson.preferences, { language: 'zh-CN', style: 'concise', waitingThresholdDays: 9, followUpWindowDays: 5, notifyWhenEmpty: false });
      await integrations.deliverAgentWakeup();
      const pending = await db.agentWakeupDelivery.findFirstOrThrow({ where: { status: 'pending' } });
      assert.equal(pending.attempts, 1); await db.agentWakeupDelivery.update({ where: { id: pending.id }, data: { nextAttemptAt: new Date(0) } });
      webhookMode = 'ok'; await integrations.deliverAgentWakeup(); await integrations.deliverAgentWakeup();
      assert.equal(eventCalls, 2); assert.equal(eventKeys[0], eventKeys[1]);
      await integrations.deliverNotification(); const delivered = await db.notificationDelivery.findUniqueOrThrow({ where: { requestKey: 'notify-once' } });
      assert.equal(delivered.status, 'delivered');
      const firstAttempts = delivered.attempts, firstProviderDeliveryId = delivered.providerDeliveryId;
      assert.equal(firstAttempts, 1); assert.equal(firstProviderDeliveryId, '123');
      await integrations.deliverNotification();
      const deliveredAgain = await db.notificationDelivery.findUniqueOrThrow({ where: { requestKey: 'notify-once' } });
      assert.equal(deliveredAgain.status, 'delivered');
      assert.equal(deliveredAgain.attempts, firstAttempts);
      assert.equal(deliveredAgain.providerDeliveryId, firstProviderDeliveryId);
      await db.notificationDelivery.create({ data: { requestKey: 'rate-limit', requestHash: 'fixture', channel: 'telegram', recipientRef: 'test-chat', content: 'Synthetic retry' } });
      sendMode = '429'; await integrations.deliverNotification(); assert.equal((await db.notificationDelivery.findUniqueOrThrow({ where: { requestKey: 'rate-limit' } })).status, 'pending');
      await db.notificationDelivery.update({ where: { requestKey: 'rate-limit' }, data: { nextAttemptAt: new Date(0) } });
      sendMode = 'network'; await integrations.deliverNotification(); assert.equal((await db.notificationDelivery.findUniqueOrThrow({ where: { requestKey: 'rate-limit' } })).status, 'unknown');
      const uncertainSends = sends; await integrations.deliverNotification(); assert.equal(sends, uncertainSends);
      sendMode = 'ok'; await integrations.pollTelegram(); await integrations.pollTelegram(); assert.equal(await db.telegramInboxMessage.count(), 1);
      await integrations.processTelegramMessage(); await integrations.processTelegramMessage();
      assert.equal(chatCalls, 1); assert.equal((await db.telegramInboxMessage.findFirstOrThrow()).status, 'completed');
    } finally {
      global.fetch = savedFetch;
      for (const key of ['AGENT_EVENT_WEBHOOK_URL','AGENT_CHAT_WEBHOOK_URL','AGENT_WEBHOOK_TOKEN','TELEGRAM_BOT_TOKEN','TELEGRAM_ALLOWED_CHAT_IDS','TELEGRAM_ALLOWED_USER_IDS','DAILY_BRIEF_ENABLED','DAILY_BRIEF_TIME','DAILY_BRIEF_LANGUAGE','DAILY_BRIEF_STYLE','DAILY_BRIEF_WAITING_THRESHOLD_DAYS','DAILY_BRIEF_FOLLOW_UP_WINDOW_DAYS','DAILY_BRIEF_NOTIFY_WHEN_EMPTY']) delete settings[key];
    }
  });
  await test('M14 WhatsApp E.164 recipient validation and confirmed delivery (mock transport)', async () => {
    const savedFetch = global.fetch; const savedSettings = { ...settings }; let payload; const recipient = '+15555550123';
    Object.assign(settings, { OPENCLAW_WHATSAPP_NOTIFY_URL: 'https://openclaw.acceptance.test/hooks/agent', AGENT_WEBHOOK_TOKEN: 'synthetic-webhook-token',
      NOTIFICATION_ALLOWED_CHANNELS: 'whatsapp', NOTIFICATION_ALLOWED_RECIPIENTS: recipient });
    global.fetch = async (url, options) => {
      assert.equal(String(url), settings.OPENCLAW_WHATSAPP_NOTIFY_URL); payload = JSON.parse(options.body);
      return Response.json({ runId: 'synthetic-openclaw-run', completion: { status: 'ok', delivered: true } });
    };
    try {
      await db.notificationDelivery.create({ data: { requestKey: 'whatsapp-valid-e164', requestHash: 'fixture', channel: 'whatsapp', recipientRef: recipient, content: 'Synthetic WhatsApp notification' } });
      await integrations.deliverNotification();
      const delivered = await db.notificationDelivery.findUniqueOrThrow({ where: { requestKey: 'whatsapp-valid-e164' } });
      assert.equal(delivered.status, 'delivered'); assert.equal(delivered.providerDeliveryId, 'openclaw:synthetic-openclaw-run');
      assert.equal(payload.channel, 'whatsapp'); assert.equal(payload.to, recipient); assert.equal(payload.deliver, true); assert.equal(payload.waitForCompletion, true);
      assert.match(payload.message, /Synthetic WhatsApp notification/);

      settings.NOTIFICATION_ALLOWED_RECIPIENTS = `${recipient},not-a-phone`;
      await db.notificationDelivery.create({ data: { requestKey: 'whatsapp-invalid-e164', requestHash: 'fixture', channel: 'whatsapp', recipientRef: 'not-a-phone', content: 'Synthetic invalid target' } });
      await integrations.deliverNotification();
      const invalid = await db.notificationDelivery.findUniqueOrThrow({ where: { requestKey: 'whatsapp-invalid-e164' } });
      assert.equal(invalid.status, 'failed'); assert.equal(invalid.lastError, 'WHATSAPP_RECIPIENT_INVALID');
    } finally {
      global.fetch = savedFetch;
      for (const key of Object.keys(settings)) delete settings[key];
      Object.assign(settings, savedSettings);
    }
  });
  await test('M15 missing processing record is repaired and reported across scan retry', async () => {
    // A missing record for mail present in both the database and the IMAP scan must count as a correction.
    const wire = mail('invite@invitations.mailinblack.com', 'Human verification'); await persist([wire]); const m = await messageFor(wire);
    await db.processingRecord.delete({ where: { sourceMessageId: m.id } }); wireMessages = [wire];
    fetchFailure = true; assert.equal((await reconciliation.runNow()).status, 'failed'); fetchFailure = false;
    const completed = await reconciliation.runNow(); assert.equal(completed.status, 'completed'); assert.equal(completed.processingRecordsCreated, 1);
    assert.equal((await db.processingRecord.findUniqueOrThrow({ where: { sourceMessageId: m.id } })).status, 'ignored');
    const eventCount = await db.agentEvent.count({ where: { eventType: 'MAIL_RECONCILIATION_CORRECTED' } }); assert.equal(eventCount, 1);
    const repeat = await reconciliation.runNow(); assert.equal(repeat.processingRecordsCreated, 0);
    assert.equal(await db.agentEvent.count({ where: { eventType: 'MAIL_RECONCILIATION_CORRECTED' } }), eventCount);
    assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: source.id } })).projectId, project.id);
  });
  await test('M15 active audit lease excludes a second worker', async () => {
    await db.mailReconciliationCheckpoint.update({ where: { mailAccountId: account.id }, data: { leaseToken: 'another-worker', leaseExpiresAt: new Date(Date.now() + 60000) } });
    assert.equal((await reconciliation.runNow()).status, 'running');
    await db.mailReconciliationCheckpoint.update({ where: { mailAccountId: account.id }, data: { leaseToken: null, leaseExpiresAt: null } });
  });
  await test('M15 audit resumes after its 20-page batch limit', async () => {
    wireMessages = Array.from({ length: 21 }, () => mail('invite@invitations.mailinblack.com', 'Verification batch'));
    settings.IMAP_SYNC_PAGE_SIZE = 1;
    try {
      const partial = await reconciliation.runNow(); assert.equal(partial.checkpoint.status, 'running'); assert.equal(partial.checkpoint.scannedCount, 20);
      const completed = await reconciliation.runNow(); assert.equal(completed.status, 'completed'); assert.equal(completed.scannedCount, 21); assert.equal(completed.importedCount, 21);
    } finally { settings.IMAP_SYNC_PAGE_SIZE = 5; wireMessages = []; }
  });
  await test('M4 verification cleanup preserves manually linked contacts/projects and unrelated reviews', async () => {
    const automated = mail('shared@invitations.mailinblack.com'); const manual = mail('shared@invitations.mailinblack.com'); await persist([automated, manual]);
    const a = await messageFor(automated), m = await messageFor(manual);
    const contact = await db.contact.create({ data: {
      displayName: 'Synthetic provisional', status: 'provisional', confidence: 0.25,
      provisionalReason: 'Unmapped inbound human sender from a legacy automatic resolution',
      emails: { create: { email: 'shared@invitations.mailinblack.com', verified: false } },
    } });
    await db.emailMessage.update({ where: { id: a.id }, data: { contactId: contact.id, contactResolutionStatus: 'provisional' } });
    await db.emailMessage.update({ where: { id: m.id }, data: { contactId: contact.id, classificationManualOverride: true, classification: 'BUSINESS_HUMAN', projectId: project.id, topicId: topic.id, projectManualOverride: true, topicManualOverride: true } });
    const review = await db.reviewItem.create({ data: { entityType: 'contact', entityId: contact.id, sourceMessageId: a.id, reasonCode: 'CONTACT_PROVISIONAL', confidence: 0, dedupeKeyBase: 'shared-contact', dedupeKey: 'shared-contact:1' } });
    await gate.classifyImported(); assert.ok(await db.contact.findUnique({ where: { id: contact.id } }));
    assert.equal((await db.reviewItem.findUniqueOrThrow({ where: { id: review.id } })).status, 'pending');
    const kept = await db.emailMessage.findUniqueOrThrow({ where: { id: m.id } }); assert.equal(kept.contactId, contact.id); assert.equal(kept.projectId, project.id);
    assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: a.id } })).contactId, null);
  });
  await test('M22 automation detail backfill previews, writes once, and protects concurrent updates', async () => {
    const oldBounce = mail('MAILER-DAEMON@backfill.test', 'Undelivered Mail Returned to Sender', 'Final-Recipient: rfc822; old@vendor.test\nDiagnostic-Code: smtp; 550 5.1.1 User unknown');
    await persist([oldBounce], { incremental: true, emitAgentEvents: true });
    const oldMessage = await messageFor(oldBounce);
    assert.equal(oldMessage.classification, 'DELIVERY_FAILURE');
    await db.emailMessage.update({ where: { id: oldMessage.id }, data: { automationDetails: {} } });
    const eventCount = await db.agentEvent.count();
    const dry = await backfillAutomationDetails(db, extractAutomationDetails, { apply: false, batchSize: 1 });
    assert.ok(dry.scanned >= 1); assert.equal(dry.updated, 0);
    assert.deepEqual((await messageFor(oldBounce)).automationDetails, {});
    const applied = await backfillAutomationDetails(db, extractAutomationDetails, { apply: true, batchSize: 1 });
    assert.ok(applied.updated >= 1); assert.equal(applied.extractionErrors, 0);
    const after = await messageFor(oldBounce);
    assert.equal(after.classification, 'DELIVERY_FAILURE');
    assert.ok(after.automationDetails.facts.some((fact) => fact.type === 'recipient' && fact.value === 'old@vendor.test'));
    assert.equal(await db.agentEvent.count(), eventCount);
    assert.equal((await backfillAutomationDetails(db, extractAutomationDetails, { apply: true, batchSize: 1 })).updated, 0);

    const raceBounce = mail('MAILER-DAEMON@backfill.test', 'Undelivered Mail Returned to Sender', 'Final-Recipient: rfc822; race@vendor.test\nDiagnostic-Code: smtp; 550 5.1.1 User unknown');
    await persist([raceBounce], { incremental: true, emitAgentEvents: true });
    const raceMessage = await messageFor(raceBounce);
    await db.emailMessage.update({ where: { id: raceMessage.id }, data: { automationDetails: {} } });
    const concurrentDetails = { version: 1, classification: 'DELIVERY_FAILURE', facts: [{ type: 'recipient', value: 'retained@vendor.test', evidence: 'existing concurrent result' }] };
    let raced = false;
    const racingDb = { emailMessage: {
      findFirst: (args) => db.emailMessage.findFirst(args),
      findMany: (args) => db.emailMessage.findMany(args),
      updateMany: async (args) => {
        if (args.where.id === raceMessage.id && !raced) {
          raced = true;
          await db.emailMessage.update({ where: { id: raceMessage.id }, data: { automationDetails: concurrentDetails } });
        }
        return db.emailMessage.updateMany(args);
      },
    } };
    const racedResult = await backfillAutomationDetails(racingDb, extractAutomationDetails, { apply: true, batchSize: 1 });
    assert.equal(raced, true); assert.equal(racedResult.conflicted, 1); assert.equal(racedResult.updated, 0);
    assert.deepEqual((await messageFor(raceBounce)).automationDetails, concurrentDetails);
    assert.equal(await db.agentEvent.count(), eventCount);

    const manualBounce = mail('MAILER-DAEMON@backfill.test', 'Undelivered Mail Returned to Sender', 'Final-Recipient: rfc822; manual@vendor.test');
    await persist([manualBounce]);
    const manualMessage = await messageFor(manualBounce);
    await db.emailMessage.update({ where: { id: manualMessage.id }, data: { classificationManualOverride: true, automationDetails: {} } });
    assert.equal((await backfillAutomationDetails(db, extractAutomationDetails, { apply: true, batchSize: 1 })).updated, 0);
    assert.deepEqual((await messageFor(manualBounce)).automationDetails, {});
  });
  await test('M22 missed actionable event recovery is guarded, audited and idempotent', async () => {
    const wire = mail('client@recovery.test', 'Request for revised quotation', 'Please send the revised quotation.');
    await persist([wire]);
    const message = await messageFor(wire);
    assert.equal(message.classification, 'BUSINESS_HUMAN');
    await db.emailImportanceTriage.create({ data: {
      mailAccountId: account.id, sourceMessageId: message.id, status: 'high', importance: 'high',
      evidenceJson: ['Please send the revised quotation.'],
    } });
    const event = await db.agentEvent.create({ data: {
      eventKey: `acceptance-missed-actionable-${message.id}`, eventType: 'INBOUND_EMAIL_RECEIVED',
      entityType: 'email_message', entityId: message.id, priority: 8, notificationPolicy: 'REALTIME',
      status: 'completed', attempts: 1, processedAt: new Date(), resultJson: { actionable: true },
      payloadJson: { sourceMessageId: message.id, classification: 'BUSINESS_HUMAN', importance: 'high' },
    } });
    await db.agentWakeupDelivery.create({ data: { eventId: event.id, status: 'delivered', attempts: 1, deliveredAt: new Date() } });
    const options = { eventId: event.id, operationId: 'acceptance-recover-missed-actionable', apply: false };
    assert.deepEqual(await recoverMissedActionableEvent(db, senderRuleSnapshotAction, Prisma, options), { eligible: 1, requeued: 0, replayed: 0 });
    assert.equal((await db.agentEvent.findUniqueOrThrow({ where: { id: event.id } })).status, 'completed');
    assert.equal(await db.businessOperation.findUnique({ where: { operationId: options.operationId } }), null);
    assert.deepEqual(await recoverMissedActionableEvent(db, senderRuleSnapshotAction, Prisma, { ...options, apply: true }), { eligible: 1, requeued: 1, replayed: 0 });
    const recovered = await db.agentEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(recovered.status, 'pending'); assert.equal(recovered.attempts, 0);
    assert.equal(recovered.resultJson, null); assert.equal(recovered.processedAt, null);
    assert.equal((await db.agentWakeupDelivery.findUniqueOrThrow({ where: { eventId: event.id } })).status, 'pending');
    assert.equal(await db.notificationDelivery.count({ where: { eventId: event.id } }), 0);
    const audit = await db.businessOperation.findUniqueOrThrow({ where: { operationId: options.operationId } });
    assert.equal(audit.entityType, 'agent_event'); assert.equal(audit.entityId, event.id);
    assert.equal(audit.action, 'recover_missing_actionable_notification');
    assert.deepEqual(await recoverMissedActionableEvent(db, senderRuleSnapshotAction, Prisma, { ...options, apply: true }), { eligible: 0, requeued: 0, replayed: 1 });
    await assert.rejects(recoverMissedActionableEvent(db, senderRuleSnapshotAction, Prisma, { eventId: 'cother-event-id', operationId: options.operationId, apply: true }), /OPERATION_ID_REUSED/);

    const alreadyNotified = await db.agentEvent.create({ data: {
      eventKey: `acceptance-already-notified-${message.id}`, eventType: 'INBOUND_EMAIL_RECEIVED',
      entityType: 'email_message', entityId: message.id, priority: 8, notificationPolicy: 'REALTIME',
      status: 'completed', resultJson: { actionable: true },
      payloadJson: { sourceMessageId: message.id, classification: 'BUSINESS_HUMAN', importance: 'high' },
    } });
    await db.notificationDelivery.create({ data: {
      eventId: alreadyNotified.id, requestKey: 'acceptance-already-notified', requestHash: 'fixture',
      channel: 'telegram', recipientRef: 'test-chat', content: 'Existing notification', status: 'delivered',
    } });
    const rejected = { eventId: alreadyNotified.id, operationId: 'acceptance-recover-already-notified', apply: false };
    assert.deepEqual(await recoverMissedActionableEvent(db, senderRuleSnapshotAction, Prisma, rejected), { eligible: 0, requeued: 0, replayed: 0 });
    await assert.rejects(recoverMissedActionableEvent(db, senderRuleSnapshotAction, Prisma, { ...rejected, apply: true }), /EVENT_NOT_ELIGIBLE/);
    assert.equal((await db.agentEvent.findUniqueOrThrow({ where: { id: alreadyNotified.id } })).status, 'completed');
    assert.equal(await db.businessOperation.findUnique({ where: { operationId: rejected.operationId } }), null);
  });
  await test('Legacy UIDVALIDITY audit is authenticated and read-only', async () => {
    const oldCount = await db.emailMessage.count({ where: { mailAccountId: account.id, mailbox: 'INBOX', uidValidity: 1n } });
    assert.ok(oldCount > 0);
    // Sent-query fixtures model a known current mailbox namespace so the legacy count
    // covers the old INBOX namespace only, as the assertions below intend.
    await db.syncCheckpoint.create({ data: { mailAccountId: account.id, mailbox: 'Sent', fromDate: new Date(now.getTime() - 86400000), throughDate: now, uidValidity: 1n, status: 'completed' } });
    const originalFolders = settings.IMAP_SYNC_FOLDERS;
    const originalSourceHashLister = imap.listMailboxSourceHashes;
    settings.IMAP_SYNC_FOLDERS = 'INBOX,Sent';
    try {
    const first = await db.emailMessage.findFirstOrThrow({ where: { mailAccountId: account.id, mailbox: 'INBOX', uidValidity: 1n } });
    const hash = createHash('sha256').update(first.rawSource).digest('hex');
    const tombstones = await db.mailDeletionTombstone.count();
    const messagesBefore = await db.emailMessage.count({ where: { mailAccountId: account.id } });
    await db.syncCheckpoint.update({ where: { id: checkpoint.id }, data: { uidValidity: 2n, status: 'completed', lastErrorCode: null, reconciliationRequired: false } });
    imap.listMailboxSourceHashes = async (_accountId, mailbox) => ({ uidValidity: mailbox === 'Sent' ? 1n : 2n, hashes: new Map([[hash, 1]]), scannedCount: 1 });
    assert.equal((await api('/sync/deletion/legacy-audit', 'GET', undefined, 'wrong')).status, 401);
    const status = await deletionSync.status();
    assert.equal(status.legacyNamespace.unverifiedCount, oldCount);
    const audited = await api('/sync/deletion/legacy-audit');
    assert.equal(audited.status, 200);
    assert.equal(audited.body.readOnly, true);
    assert.equal(audited.body.legacyCount, oldCount);
    assert.equal(audited.body.exactRawMatchCount + audited.body.noExactMatchCount, oldCount);
    assert.ok(audited.body.exactRawMatchCount >= 1);
    assert.equal(await db.emailMessage.count({ where: { mailAccountId: account.id } }), messagesBefore);
    assert.equal(await db.mailDeletionTombstone.count(), tombstones);
    imap.listMailboxSourceHashes = async (_accountId, mailbox) => ({ uidValidity: mailbox === 'Sent' ? 1n : 2n, hashes: new Map(), scannedCount: 0 });
    const unmatched = await api('/sync/deletion/legacy-audit');
    assert.equal(unmatched.status, 200);
    assert.equal(unmatched.body.noExactMatchCount, oldCount);
    imap.listMailboxSourceHashes = async (_accountId, mailbox) => ({ uidValidity: mailbox === 'Sent' ? 1n : 3n, hashes: new Map(), scannedCount: 0 });
    const unstable = await api('/sync/deletion/legacy-audit');
    assert.equal(unstable.status, 503);
    assert.equal(unstable.body.code, 'UIDVALIDITY_CHANGED');
    assert.equal(await db.mailDeletionTombstone.count(), tombstones);
    } finally {
    settings.IMAP_SYNC_FOLDERS = originalFolders;
    if (originalSourceHashLister === undefined) delete imap.listMailboxSourceHashes;
    else imap.listMailboxSourceHashes = originalSourceHashLister;
    }
  });
  await test('Review resolution protects concurrent decisions and audits replay', async () => {
    const wire = mail('review-race@customer.test', 'Concurrent project review', 'Please send the revised drawing.');
    await persist([wire]);
    const message = await messageFor(wire);
    const review = await db.reviewItem.create({ data: {
      entityType: 'email_message', entityId: message.id, sourceMessageId: message.id,
      reasonCode: 'PROJECT_UNRESOLVED', confidence: 0,
      dedupeKeyBase: `review-race:${message.id}`, dedupeKey: `review-race:${message.id}:1`,
    } });
    const projectContacts = await db.projectContact.findMany({ where: { projectId: project.id }, select: { contactId: true, isPrimary: true } });
    const inputs = ['a', 'b'].map(suffix => ({ action: 'create_project', projectName: 'Review concurrency fixture', companyId: project.companyId,
      contactIds: projectContacts.map(item => item.contactId), primaryContactId: projectContacts.find(item => item.isPrimary)?.contactId ?? null,
      operationId: `review-race-${suffix}`, actorId: `operator-${suffix}` }));
    const results = await Promise.allSettled(inputs.map(input => projects.resolveReview(review.id, input)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const conflict = results[1 - winner].reason;
    assert.equal(conflict.status, 409, JSON.stringify({ code: conflict.code, status: conflict.status, sqlState: conflict.meta?.code }));
    assert.equal(await db.project.count({ where: { name: 'Review concurrency fixture' } }), 1);
    const saved = await db.reviewItem.findUniqueOrThrow({ where: { id: review.id } });
    const linked = await db.emailMessage.findUniqueOrThrow({ where: { id: message.id } });
    assert.equal(linked.projectId, saved.resolutionJson.projectId);
    assert.equal(saved.resolvedBy, inputs[winner].actorId);
    assert.deepEqual(await projects.resolveReview(review.id, inputs[winner]), saved);
    await assert.rejects(projects.resolveReview(review.id, { ...inputs[winner], projectName: 'Changed retry' }),
      error => error.status === 409 && error.response?.code === 'IDEMPOTENCY_KEY_REUSED');
    await assert.rejects(projects.resolveReview(review.id, { action: 'dismiss', actorId: 'another', operationId: 'review-race-later' }),
      error => error.status === 409 && error.response?.code === 'REVIEW_ALREADY_RESOLVED');
    const audit = await db.businessOperation.findUniqueOrThrow({ where: { operationId: inputs[winner].operationId } });
    assert.equal(audit.entityId, review.id); assert.equal(audit.actorId, saved.resolvedBy);
  });
  await test('Review idempotency is bound to the path even when the body supplies another reviewId', async () => {
    const wire = mail('review-path@customer.test', 'Review path idempotency', 'Please send the revised drawing.');
    await persist([wire]);
    const message = await messageFor(wire);
    const reviews = [];
    for (const suffix of ['first', 'second']) {
      const key = `review-path:${message.id}:${suffix}`;
      reviews.push(await db.reviewItem.create({ data: {
        entityType: 'email_message', entityId: message.id, sourceMessageId: message.id,
        reasonCode: 'ACCEPTANCE_IDEMPOTENCY', confidence: 0, dedupeKeyBase: key, dedupeKey: `${key}:1`,
      } }));
    }
    const input = { action: 'dismiss', actorId: 'path-fixture', operationId: 'review-path-operation', reviewId: 'spoofed-body-review-id' };
    const first = await api(`/reviews/${reviews[0].id}/resolve`, 'POST', input);
    assert.equal(first.status, 200); assert.equal(first.body.id, reviews[0].id);
    const second = await api(`/reviews/${reviews[1].id}/resolve`, 'POST', input);
    assert.equal(second.status, 409); assert.equal(second.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await db.reviewItem.findUniqueOrThrow({ where: { id: reviews[1].id } })).status, 'pending');
  });
  await test('Audited mutations only map serialization and deadlock SQL errors to conflicts', async () => {
    const { executeAuditedMutation } = load('business-operation');
    const mutation = { operationId: 'raw-sql-error-fixture', entityType: 'fixture', action: 'create', input: {},
      execute: async () => assert.fail('Fixture transaction should throw before executing'), load: async () => null };
    for (const sqlState of ['40001', '40P01', '42P01']) {
      const rawError = Object.assign(new Error('Synthetic raw SQL failure'), { code: 'P2010', meta: { code: sqlState } });
      const fixture = { businessOperation: { findUnique: async () => null }, $transaction: async () => { throw rawError; } };
      await assert.rejects(executeAuditedMutation(fixture, mutation), error => sqlState === '42P01'
        ? error === rawError
        : error.status === 409 && error.response?.code === 'CONCURRENT_UPDATE');
    }
  });
  await test('Topic creation records the actor and replays the original operation', async () => {
    const p = await createAcceptanceProject('Topic audit fixture', 'topic-audit');
    const input = { name: 'Technical review', type: 'technical', actorId: 'topic-operator', operationId: 'topic-audit-create' };
    const createdTopic = await api(`/projects/${p.id}/topics`, 'POST', input);
    assert.equal(createdTopic.status, 201);
    const replayed = await api(`/projects/${p.id}/topics`, 'POST', input);
    assert.equal(replayed.status, 201); assert.equal(replayed.body.id, createdTopic.body.id);
    assert.equal((await api(`/projects/${p.id}/topics`, 'POST', { ...input, name: 'Different topic' })).status, 409);
    assert.equal(await db.topic.count({ where: { projectId: p.id } }), 1);
    const audit = await db.businessOperation.findUniqueOrThrow({ where: { operationId: input.operationId } });
    assert.equal(audit.actorId, input.actorId); assert.equal(audit.entityId, createdTopic.body.id); assert.equal(audit.entityType, 'topic');
  });
  await test('Active task query includes every unfinished status and project metadata', async () => {
    const p = await createAcceptanceProject('Active task query fixture', 'active-query');
    for (const status of ['open', 'in_progress', 'waiting', 'done', 'cancelled']) {
      await records.createTask({ title: `Query fixture ${status}`, status, projectId: p.id, operationId: `active-query-${status}` });
    }
    const response = await api(`/tasks?status=active&projectId=${p.id}&limit=2&offset=0`);
    assert.equal(response.status, 200); assert.equal(response.body.total, 3); assert.equal(response.body.tasks.length, 2);
    const second = await api(`/tasks?status=active&projectId=${p.id}&limit=2&offset=2`);
    assert.equal(second.body.tasks.length, 1);
    const tasks = [...response.body.tasks, ...second.body.tasks];
    assert.deepEqual(tasks.map(t => t.status).sort(), ['in_progress', 'open', 'waiting']);
    assert.ok(tasks.every(t => t.project.id === p.id && t.project.name === p.name));
  });
  await test('Sync checkpoint CAS rejects concurrent and stale pages while history stays silent', async () => {
    const mailbox = 'CAS-RECOVERY';
    const first = mail('cas-client@customer.test', 'Historical recovery page A', 'Please send the revised quotation.');
    const second = mail('cas-client@customer.test', 'Historical recovery page B', 'Please send the updated drawing.');
    const followup = mail('cas-client@customer.test', 'Historical recovery final page', 'Please confirm the delivery date.');
    const cp = await db.syncCheckpoint.create({ data: {
      mailAccountId: account.id, mailbox, fromDate: new Date(now.getTime() - 86400000), throughDate: now,
      uidValidity: 1n, targetUid: followup.uid, lastUid: 0, status: 'in_progress',
    } });
    const before = {
      triages: await db.emailImportanceTriage.count(), events: await db.agentEvent.count(),
      wakeups: await db.agentWakeupDelivery.count(), notifications: await db.notificationDelivery.count(),
    };
    const historicalPage = (wire, version, extra = {}) => ({
      accountId: account.id, accountEmail: account.email, checkpointId: cp.id, mailbox,
      uidValidity: 1n, messages: [wire], nextUid: wire.uid, hasMore: true,
      targetUid: followup.uid, throughDate: now, expectedCheckpointUpdatedAt: version,
      releaseInitialPage: true, ...extra,
    });
    const inputs = [first, second];
    const results = await Promise.allSettled(inputs.map(wire => initial.persistPage(historicalPage(wire, cp.updatedAt))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    assert.equal(results[winner].value, 1);
    assert.ok(results[1 - winner].reason instanceof SyncCheckpointChangedError);
    const saved = await db.syncCheckpoint.findUniqueOrThrow({ where: { id: cp.id } });
    assert.equal(saved.lastUid, inputs[winner].uid); assert.equal(saved.status, 'pending');
    assert.equal(saved.scannedCount, 1); assert.equal(saved.importedCount, 1);
    assert.ok(saved.updatedAt > cp.updatedAt);
    const imported = await db.emailMessage.findMany({ where: { mailAccountId: account.id, mailbox } });
    assert.equal(imported.length, 1); assert.equal(imported[0].uid, inputs[winner].uid);
    assert.equal(await db.processingRecord.count({ where: { sourceMessageId: { in: imported.map(item => item.id) } } }), 1);
    await assert.rejects(initial.persistPage(historicalPage(inputs[1 - winner], cp.updatedAt, { nextUid: 0 })), SyncCheckpointChangedError);
    assert.equal((await db.syncCheckpoint.findUniqueOrThrow({ where: { id: cp.id } })).lastUid, saved.lastUid);
    assert.equal(await db.emailMessage.count({ where: { mailAccountId: account.id, mailbox } }), 1);

    assert.equal(await initial.persistPage(historicalPage(followup, saved.updatedAt, { hasMore: false, clearTargetUid: true })), 1);
    const completed = await db.syncCheckpoint.findUniqueOrThrow({ where: { id: cp.id } });
    assert.equal(completed.status, 'completed'); assert.equal(completed.lastUid, followup.uid);
    assert.equal(completed.targetUid, null); assert.equal(completed.scannedCount, 2); assert.equal(completed.importedCount, 2);
    await assert.rejects(initial.persistPage(historicalPage(inputs[1 - winner], saved.updatedAt, { nextUid: 0 })), SyncCheckpointChangedError);
    assert.deepEqual(await db.syncCheckpoint.findUniqueOrThrow({ where: { id: cp.id } }), completed);
    assert.equal(await db.emailMessage.count({ where: { mailAccountId: account.id, mailbox } }), 2);
    assert.equal(await db.emailImportanceTriage.count(), before.triages);
    assert.equal(await db.agentEvent.count(), before.events);
    assert.equal(await db.agentWakeupDelivery.count(), before.wakeups);
    assert.equal(await db.notificationDelivery.count(), before.notifications);
  });
  await test('Review fixes: RFC-linked navigation, bottom replies, copies and account isolation', async () => {
    const base = new Date(now.getTime() - 3 * 3600_000);
    const make = (id, body, parent, offset = 0, from = 'thread-client@customer.test') => {
      const wire = mail(from, 'Review navigation unique fixture', body, new Date(base.getTime() + offset));
      let raw = wire.rawSource.toString('utf8').replace(/Message-ID: [^\r\n]+/, `Message-ID: ${id}`);
      if (parent) raw = raw.replace('\r\n\r\n', `\r\nIn-Reply-To: ${parent}\r\n\r\n`);
      if (from === account.email) raw = raw.replace(`To: ${account.email}`, 'To: thread-client@customer.test');
      wire.rawSource = Buffer.from(raw); return wire;
    };
    const root = make('<review-root@test.invalid>', 'Original request.', null, 0, account.email);
    const b = make('<review-b@test.invalid>', 'On Monday, owner wrote:\n> Original request.\n\nCurrent B.', '<review-root@test.invalid>', 3600_000);
    const c = make('<review-c@test.invalid>', 'From: Client\nSent: Tuesday\nTo: Owner\nSubject: Thread\n\nOn Monday, owner wrote:\n> Original request.\n\nCurrent B.\n\nCurrent C.', '<review-b@test.invalid>', 2 * 3600_000);
    const unrelated = make('<review-unrelated@test.invalid>', 'Unrelated same subject.', null, 4 * 3600_000);
    const copy = { ...root, uid: ++seq };
    const persist = (messages, mailbox, extra = {}) => initial.persistPage({ accountId: account.id, accountEmail: account.email, mailbox, uidValidity: 1n, messages, nextUid: messages.at(-1).uid, hasMore: false, auditOnly: true, ...extra });
    await persist([root, b, c, unrelated], 'ReviewNavigation'); await persist([copy], 'ReviewNavigationCopy');
    const foreign = await db.mailAccount.create({ data: { email: 'foreign-thread@test.invalid', host: 'imap.test.invalid', port: 993, tlsMode: 'tls', username: 'foreign', passwordCiphertext: 'synthetic' } });
    await initial.persistPage({ accountId: foreign.id, accountEmail: foreign.email, mailbox: 'INBOX', uidValidity: 1n, messages: [root], nextUid: root.uid, hasMore: false, auditOnly: true });
    const saved = await db.emailMessage.findMany({ where: { mailAccountId: account.id, mailbox: 'ReviewNavigation' } });
    const byRfc = new Map(saved.map(message => [message.rfcMessageId, message]));
    const current = await brief.getEmailMessage(byRfc.get('<review-c@test.invalid>').id);
    assert.equal(current.bodyText, 'Current C.'); assert.equal(current.threadNavigation.total, 3);
    assert.equal(current.threadNavigation.previous.id, byRfc.get('<review-b@test.invalid>').id); assert.equal(current.threadNavigation.next, null);
    assert.ok(current.quotedHistoryRemoved); assert.ok(byRfc.get('<review-c@test.invalid>').bodyText.includes('Current B.'));
    const middle = await brief.getEmailMessage(byRfc.get('<review-b@test.invalid>').id);
    assert.equal(middle.bodyText, 'Current B.'); assert.equal(middle.threadNavigation.next.id, current.id); assert.equal(middle.threadNavigation.position, 2);
    const isolated = await brief.getEmailMessage(byRfc.get('<review-unrelated@test.invalid>').id);
    assert.equal(isolated.threadNavigation.total, 1); assert.equal(isolated.threadNavigation.previous, null); assert.equal(isolated.threadNavigation.next, null);
    const beforeTriage = await db.emailImportanceTriage.count(); const beforeEvents = await db.agentEvent.count();
    await persist([root, b, c], 'ReviewNavigation', { importanceTriageSource: 'reconciliation', importanceTriageCatchupCutoff: new Date(now.getTime() - 24 * 3600_000) });
    assert.ok(saved.every(message => message.historicalImport)); assert.equal(await db.emailImportanceTriage.count(), beforeTriage); assert.equal(await db.agentEvent.count(), beforeEvents);
  });
  await test('Review fixes: real session deletion wins a delayed validation read', async () => {
    const user = await db.dashboardUser.findUniqueOrThrow({ where: { email: settings.DASHBOARD_INITIAL_EMAIL } });
    const token = randomUUID(); const tokenHash = createHash('sha256').update(token).digest('hex');
    await db.dashboardSession.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 60_000) } });
    let release; let entered; const started = new Promise(resolve => { entered = resolve; });
    const raceAuth = new AuthService({ dashboardSession: {
      findUnique: async query => { const row = await db.dashboardSession.findUnique(query); entered(); await new Promise(resolve => { release = resolve; }); return row; },
      updateMany: query => db.dashboardSession.updateMany(query), deleteMany: query => db.dashboardSession.deleteMany(query),
    } }, config);
    const validation = raceAuth.isActiveSessionToken(token); await started; await raceAuth.logout(token); release();
    assert.equal(await validation, false); assert.equal(await db.dashboardSession.count({ where: { tokenHash } }), 0);
  });
  await test('Review fixes: merged task PATCH and both project waiting states', async () => {
    const a = await createAcceptanceProject('Review move source', 'review-move-source'); const b = await createAcceptanceProject('Review move target', 'review-move-target');
    const t = await projects.createTopic(a.id, { name: 'Review move topic' });
    let task = await records.createTask({ operationId: 'review-move-create', title: 'Move reply obligation', kind: 'reply', ownerType: 'us', waitingOn: 'us', projectId: a.id, topicId: t.id, deadlineDate: '2026-10-03', deadlineTimezone: 'Europe/Rome' });
    await assert.rejects(records.updateTask(task.id, { operationId: 'review-clear-project', expectedVersion: task.version, projectId: null }), error => error.status === 400);
    await assert.rejects(records.updateTask(task.id, { operationId: 'review-clear-timezone', expectedVersion: task.version, deadlineTimezone: null }), error => error.status === 400);
    task = await records.updateTask(task.id, { operationId: 'review-topic-only', expectedVersion: task.version, topicId: t.id });
    task = await records.updateTask(task.id, { operationId: 'review-move', expectedVersion: task.version, projectId: b.id, topicId: null });
    assert.equal((await projects.getProject(a.id)).waitingOn, 'none'); assert.equal((await projects.getProject(a.id)).replyRequired, false); assert.equal((await projects.getProject(b.id)).replyRequired, true);
    task = await records.updateTask(task.id, { operationId: 'review-detach', expectedVersion: task.version, projectId: null, topicId: null });
    assert.equal(task.projectId, null); assert.equal((await projects.getProject(b.id)).waitingOn, 'none'); assert.equal((await projects.getProject(b.id)).replyRequired, false);
  });

}
main().catch(error => {
  failures.push('harness');
  console.error(String(error.stack ?? error.message).split(adminUrl).join('[redacted-admin-db-url]')
    .split(testUrl.toString()).join('[redacted-test-db-url]').slice(0, 2200));
}).finally(async () => {
  if (app) await app.close(); if (db) await db.$disconnect();
  if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`);
  await admin.$disconnect(); console.log(JSON.stringify({ passed, failed: failures.length, failures, temporaryDatabaseRemoved: created }));
  if (failures.length) process.exitCode = 1;
});
