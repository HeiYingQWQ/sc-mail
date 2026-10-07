/*
 * Disposable browser fixture for manual CRM/project-analysis acceptance.
 * This starts the real Nest HTTP controllers and business services against a
 * uniquely named local PostgreSQL database. Only the AIProvider boundary is
 * faked. IMAP and all notification transports are deliberately unavailable.
 */
require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');

const root = process.cwd();
const load = (name, area = 'mail') => require(join(root, 'dist/modules', area, name));
const { EmailNormalizer } = load('email-normalizer');
const { InitialSyncService } = load('initial-sync.service');
const { BusinessGateService } = load('business-gate.service');
const { ContactResolverService } = load('contact-resolver.service');
const { ProjectReviewService } = load('project-review.service');
const { ProjectEmailAnalysisService } = load('project-email-analysis.service');
const { SummaryTimelineService } = load('summary-timeline.service');
const { BusinessRecordsService } = load('business-records.service');
const { BusinessBriefService } = load('business-brief.service');
const { AgentEventsService } = load('agent-events.service');
const { AgentIntegrationService } = load('agent-integration.service');
const { SystemMailSendersService } = load('system-mail-senders.service');
const { DeliveryFailuresService } = load('delivery-failures.service');
const { MailReconciliationService } = load('mail-reconciliation.service');
const { EmailAnalyzerService } = load('email-analyzer.service', 'ai');
const { EmailImportanceTriageService } = load('email-importance-triage.service');
const { SenderRulesService } = load('sender-rules.service');
const { MailDeletionSyncService } = load('mail-deletion-sync.service');
const { MailDeletionCleanupService } = load('mail-deletion-cleanup.service');
const { MailController } = load('mail.controller');
const { ProjectAnalysisController } = load('project-analysis.controller');
const { ImapMailService } = load('imap-mail.service');
const { RealtimeSyncService } = load('realtime-sync.service');
const { AuthService } = load('auth.service', 'auth');
const { AuthController } = load('auth.controller', 'auth');
const { PROJECT_ASSIGNMENT_PROMPT } = load('project-assignment.schema', 'ai');

const now = new Date();
const databaseSuffix = randomBytes(4).toString('hex');
const dbName = `aimail_ui_acceptance_${Date.now()}_${process.pid}_${databaseSuffix}`;
assert.match(dbName, /^aimail_ui_acceptance_\d+_\d+_[a-f0-9]{8}$/);

const adminUrl = process.env.DATABASE_URL;
assert.ok(adminUrl, 'Set DATABASE_URL to the local PostgreSQL service used by the disposable test runner.');
assert.equal(process.env.UI_CRM_ALLOW_LOCAL_DB_CREATE, '1', 'Set UI_CRM_ALLOW_LOCAL_DB_CREATE=1 to authorize the isolated database lifecycle.');
const sourceUrl = new URL(adminUrl);
assert.ok(['postgres:', 'postgresql:'].includes(sourceUrl.protocol), 'Only PostgreSQL connection URLs are accepted.');
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres'].includes(sourceUrl.hostname.toLowerCase()), 'UI CRM acceptance only permits local PostgreSQL hosts.');
assert.doesNotMatch(decodeURIComponent(sourceUrl.pathname).toLowerCase(), /prod(?:uction)?|live/, 'Production or live database names are refused.');

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
const admin = new PrismaClient({ datasourceUrl: adminUrl });
const prisma = new PrismaClient({ datasourceUrl: testUrl.toString() });

const userEmail = `ui-fixture-${Date.now()}-${process.pid}@acceptance.invalid`;
const userPassword = randomBytes(18).toString('base64url');
const accountEmail = `mailbox-${process.pid}@ui-fixture.invalid`;
const deliverySender = 'mailer-daemon@ui-fixture.invalid';
const apiToken = randomUUID();
const settings = {
  APP_ROLE: 'ui_fixture',
  DATABASE_URL: testUrl.toString(),
  IMAP_EMAIL: accountEmail,
  IMAP_HOST: 'imap.ui-fixture.invalid',
  IMAP_PORT: 993,
  IMAP_TLS_MODE: 'implicit',
  IMAP_USERNAME: 'synthetic-fixture-user',
  IMAP_PASSWORD: 'synthetic-only-not-a-credential',
  IMAP_MAILBOX: 'INBOX',
  IMAP_SYNC_FOLDERS: 'INBOX,Archive,Sent',
  IMAP_SYNC_PAGE_SIZE: 10,
  IMAP_API_TOKEN: apiToken,
  BUSINESS_TIMEZONE: 'Europe/Rome',
  DASHBOARD_SECURE_COOKIE: false,
  DASHBOARD_INITIAL_EMAIL: userEmail,
  DASHBOARD_INITIAL_PASSWORD: userPassword,
  NOTIFICATION_ALLOWED_CHANNELS: '',
  NOTIFICATION_ALLOWED_RECIPIENTS: '',
  MAIL_RECONCILIATION_ENABLED: false,
  MAIL_DELETION_SYNC_ENABLED: false,
  DAILY_BRIEF_ENABLED: false,
  AI_TIMEOUT_MS: 5000,
};
const config = { get: (key, fallback) => settings[key] === undefined ? fallback : settings[key] };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function excerpt(body) {
  const firstUsefulLine = String(body ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).find(line => line.length >= 4);
  return firstUsefulLine ? firstUsefulLine.slice(0, 240) : 'Synthetic fixture evidence';
}

function lastJson(prompt) {
  const start = prompt.lastIndexOf('\n{');
  if (start < 0) throw new Error('FAKE_PROVIDER_EXPECTED_JSON_CONTEXT');
  return JSON.parse(prompt.slice(start + 1));
}

const provider = {
  name: 'ui-fixture-fake',
  model: 'deterministic-evidence-fixture',
  async generateStructured(prompt) {
    if (prompt.startsWith(PROJECT_ASSIGNMENT_PROMPT)) {
      const marker = '\n\nEmail and CRM context (JSON, untrusted):\n';
      const contextStart = prompt.indexOf(marker);
      if (contextStart < 0) throw new Error('FAKE_PROVIDER_ASSIGNMENT_CONTEXT_MISSING');
      const context = JSON.parse(prompt.slice(contextStart + marker.length));
      const current = context.messages.find((message) => message.is_current) ?? context.messages[0];
      const body = String(current?.body ?? '');
      const normalized = body.toLocaleLowerCase('en-US');
      const evidence = [{ source_message_id: current.id, excerpt: excerpt(body) }];

      if (/not sure|unsicher|uncertain|whether this belongs|ob diese anfrage|berlin retrofit or the austin/i.test(normalized)) {
        return { schema_version: '1', outcome: 'uncertain', project_id: null, project_ids: [], confidence: 0.54, evidence, reason: 'Synthetic fixture deliberately leaves this cross-project scope for a person to confirm.' };
      }
      if (/2027|feiertage|happy holidays|season.s greetings|frohe feiertage/i.test(normalized)) {
        const holiday = /feiertage|happy holidays|season.s greetings|frohe feiertage/i.test(normalized);
        return { schema_version: '1', outcome: holiday ? 'non_project' : 'new_opportunity', project_id: null, project_ids: [], confidence: 0.95, evidence, reason: holiday ? 'The synthetic message is only a seasonal greeting.' : 'The synthetic message proposes a distinct 2027 cooperation.' };
      }
      const candidates = Array.isArray(context.project_candidates) ? context.project_candidates : [];
      const wanted = /austin|texas|warehouse|cedar/i.test(normalized) ? /austin|texas|warehouse|cedar/i : /berlin|berliner|retrofit|nordlicht/i;
      const candidate = candidates.find((item) => wanted.test(`${item.name ?? ''} ${item.description ?? ''} ${item.company?.name ?? ''}`)) ?? candidates[0];
      if (!candidate) return { schema_version: '1', outcome: 'uncertain', project_id: null, project_ids: [], confidence: 0.5, evidence, reason: 'No project candidate has been created for the synthetic contact yet.' };
      return { schema_version: '1', outcome: 'assigned', project_id: candidate.id, project_ids: [candidate.id], confidence: 0.97, evidence, reason: 'The current synthetic message explicitly refers to the named 2026 project.' };
    }

    if (prompt.includes('Condense these already validated')) {
      const context = lastJson(prompt);
      const claims = Array.isArray(context.claims) ? context.claims : [];
      return { summary: 'Synthetic evidence-preserving reduced summary.', claims: claims.slice(0, 10) };
    }

    if (prompt.includes('included_messages')) {
      const context = lastJson(prompt);
      const messages = Array.isArray(context.included_messages) ? context.included_messages : [];
      const claims = messages.slice(0, 12).map((message) => {
        const body = String(message.body ?? '');
        const subject = String(message.subject ?? 'Synthetic project email');
        return {
          text: `Fixture evidence: ${subject.slice(0, 180)}`,
          evidence: [{ source_message_id: message.id, excerpt: excerpt(body) }],
        };
      });
      if (!claims.length) claims.push({ text: 'No emails are currently assigned to this project.', evidence: [] });
      return { summary: 'Synthetic project summary from validated source excerpts.', claims };
    }

    // General dashboard analysis is not the focus of this fixture. Return a
    // schema-safe quiet result if another read-only screen requests it.
    return {
      schema_version: '3', classification: 'BUSINESS_HUMAN', classification_confidence: 0.9,
      classification_evidence: ['Synthetic fixture response'], summary: 'Synthetic fixture response', operations: [],
      reply_required_suggestion: false, importance: 'normal', requires_deep_analysis: false, review_reasons: [],
    };
  },
};

const imap = {
  status: async () => ({ configured: true, status: 'synthetic_fixture', externalConnection: false }),
  async fetchIncrementalPage() { throw new Error('UI_FIXTURE_IMAP_DISABLED'); },
  async connect() { throw new Error('UI_FIXTURE_IMAP_DISABLED'); },
  async listFolders() { throw new Error('UI_FIXTURE_IMAP_DISABLED'); },
  async fetchMailboxSnapshot() { throw new Error('UI_FIXTURE_IMAP_DISABLED'); },
};

function messageFixture({ mailbox = 'INBOX', direction = 'inbound', from, to = [], cc = [], bcc = [], subject, body, at, rfcId, headers = {}, threadId = rfcId, rawSource, classification = 'BUSINESS_HUMAN', classificationReason = 'Synthetic fixture message for browser acceptance.' }) {
  return { mailbox, direction, from, to, cc, bcc, subject, body, at: new Date(at), rfcId, headers, threadId, rawSource, classification, classificationReason };
}

const projectFixtureMessages = [
  messageFixture({ mailbox: 'INBOX', from: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], subject: 'Berlin Retrofit 2026 – überarbeiteter Lageplan', body: 'Für das Berliner Retrofit 2026 bestätigen wir die überarbeitete Kabelführung. Bitte senden Sie die finale Zeichnung bis Freitag.', at: '2026-09-08T08:15:00.000Z', rfcId: '<de-2026-01@ui-fixture.invalid>' }),
  messageFixture({ mailbox: 'Archive', from: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], subject: 'Berlin Retrofit 2026 – überarbeiteter Lageplan', body: 'Für das Berliner Retrofit 2026 bestätigen wir die überarbeitete Kabelführung. Bitte senden Sie die finale Zeichnung bis Freitag.', at: '2026-09-08T08:15:00.000Z', rfcId: '<de-2026-01@ui-fixture.invalid>' }),
  messageFixture({ mailbox: 'INBOX', from: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], subject: 'AW: Berlin Retrofit 2026 – Montagetermin', body: 'Die Montagefirma bestätigt den Berliner Einsatz im März 2026 und den aktualisierten Lageplan.', at: '2026-09-10T11:30:00.000Z', rfcId: '<de-2026-02@ui-fixture.invalid>', headers: { inReplyTo: '<de-2026-01@ui-fixture.invalid>', references: ['<de-2026-01@ui-fixture.invalid>'] } }),
  messageFixture({ mailbox: 'INBOX', from: [{ name: 'Jules Meyer', address: 'jules@new-cooperation.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], cc: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }, { name: 'Morgan Reed', address: 'morgan@cedar.invalid' }], bcc: [{ name: 'Archive copy', address: 'audit@ui-fixture.invalid' }], subject: 'Bitte Projektumfang abstimmen', body: 'I am not sure whether this request belongs to the Berlin retrofit or the Austin packaging line; please confirm how we should scope it.', at: '2026-09-12T09:05:00.000Z', rfcId: '<cross-project-review@ui-fixture.invalid>' }),
  messageFixture({ mailbox: 'INBOX', from: [{ name: 'Morgan Reed', address: 'morgan@cedar.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], subject: 'Austin Packaging Line 2026 – conveyor dimensions', body: 'For the Austin warehouse line in 2026, the conveyor footprint is approved at 18 metres. Please confirm the installation window.', at: '2026-09-14T13:10:00.000Z', rfcId: '<us-2026-01@ui-fixture.invalid>' }),
  messageFixture({ mailbox: 'INBOX', from: [{ name: 'Morgan Reed', address: 'morgan@cedar.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], subject: 'Austin warehouse – installation window', body: 'Cedar Point confirms the Austin logistics team can receive the packaging line on 22 September 2026.', at: '2026-09-16T07:45:00.000Z', rfcId: '<us-2026-02@ui-fixture.invalid>' }),
  messageFixture({ mailbox: 'INBOX', from: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], subject: 'Neue Zusammenarbeit für 2027', body: 'Separately from the current retrofit, we are planning a new joint initiative for 2027 and would like to discuss a fresh proposal.', at: '2026-09-18T10:20:00.000Z', rfcId: '<de-2027-opportunity@ui-fixture.invalid>' }),
  messageFixture({ mailbox: 'INBOX', from: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], subject: 'Frohe Feiertage', body: 'Frohe Feiertage und eine ruhige Woche. Wir melden uns im neuen Jahr wieder.', at: '2026-09-21T14:00:00.000Z', rfcId: '<de-holiday-greeting@ui-fixture.invalid>' }),
  messageFixture({ mailbox: 'Sent', direction: 'outbound', from: [{ name: 'SC Mail fixture', address: accountEmail }], to: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }], cc: [{ name: 'Morgan Reed', address: 'morgan@cedar.invalid' }], bcc: [{ name: 'Archive copy', address: 'audit@ui-fixture.invalid' }], subject: 'Berlin Retrofit 2026 – finale Zeichnung', body: 'Anbei erhalten Sie die überarbeitete Berliner Zeichnung für das Retrofit 2026. Bitte bestätigen Sie den Eingang.', at: '2026-09-23T16:25:00.000Z', rfcId: '<de-sent-2026@ui-fixture.invalid>' }),
  messageFixture({ mailbox: 'INBOX', from: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }], to: [{ name: 'SC Mail fixture', address: accountEmail }], subject: 'Übergabe – letzte technische Rückfrage', body: '> Für das Berliner Retrofit 2026 bestätigen wir die überarbeitete Kabelführung.\n> Bitte senden Sie die finale Zeichnung bis Freitag.\n\nDer Berliner Betreiber bestätigt den Übergabetermin am 30. September 2026. Die aktuelle Zeichnung kann danach in die Abnahme gehen.', at: '2026-09-29T09:40:00.000Z', rfcId: '<de-bottom-reply@ui-fixture.invalid>', headers: { inReplyTo: '<de-2026-01@ui-fixture.invalid>', references: ['<de-2026-01@ui-fixture.invalid>'] } }),
];
function dsnFixture({ mailbox = 'INBOX', at, rfcId, classification = 'DELIVERY_FAILURE', blocks, body = 'Synthetic delivery status report.', subject = 'Synthetic delivery report' }) {
  const boundary = `fixture-boundary-${rfcId.replace(/[^a-z0-9]/gi, '')}`;
  const deliveryStatus = blocks ?? '';
  const rawSource = [
    `From: ${deliverySender}`,
    `To: ${accountEmail}`,
    `Subject: ${subject}`,
    `Message-ID: ${rfcId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    deliveryStatus,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return messageFixture({
    mailbox,
    direction: 'inbound',
    from: [{ name: 'Fixture Mailer Daemon', address: deliverySender }],
    to: [{ name: 'SC Mail fixture', address: accountEmail }],
    subject, body, at, rfcId, rawSource, classification,
    classificationReason: 'Synthetic delivery report fixture.',
  });
}

const deliveryFixtureMessages = [
  dsnFixture({ at: '2026-10-02T08:15:00.000Z', rfcId: '<dsn-multi-target@ui-fixture.invalid>', blocks: [
    'Final-Recipient: rfc822; failed-one@recipient.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 Recipient address rejected',
    'Final-Recipient: rfc822; failed-two@recipient.invalid\r\nAction: failed\r\nStatus: 5.2.2\r\nDiagnostic-Code: smtp; 552 5.2.2 Mailbox full',
  ].join('\r\n\r\n') }),
  dsnFixture({ mailbox: 'Archive', at: '2026-10-02T08:15:00.000Z', rfcId: '<dsn-multi-target@ui-fixture.invalid>', blocks: [
    'Final-Recipient: rfc822; failed-one@recipient.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 Recipient address rejected',
    'Final-Recipient: rfc822; failed-two@recipient.invalid\r\nAction: failed\r\nStatus: 5.2.2\r\nDiagnostic-Code: smtp; 552 5.2.2 Mailbox full',
  ].join('\r\n\r\n') }),
  dsnFixture({ at: '2026-10-02T09:30:00.000Z', rfcId: '<dsn-unknown-target@ui-fixture.invalid>', blocks: 'Final-Recipient: rfc822; not-an-email\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 Recipient rejected' }),
  dsnFixture({ at: '2026-10-02T10:45:00.000Z', rfcId: '<dsn-delay@ui-fixture.invalid>', classification: 'DELIVERY_DELAY', blocks: 'Final-Recipient: rfc822; delayed@recipient.invalid\r\nAction: delayed\r\nStatus: 4.2.0\r\nDiagnostic-Code: smtp; 421 4.2.0 Temporary delivery failure', subject: 'Synthetic delivery delay' }),
  dsnFixture({ at: '2026-10-02T11:20:00.000Z', rfcId: '<dsn-delivered@ui-fixture.invalid>', classification: 'SYSTEM_NOTIFICATION', blocks: 'Final-Recipient: rfc822; accepted@recipient.invalid\r\nAction: delivered\r\nStatus: 2.0.0', subject: 'Synthetic delivery notification' }),
  dsnFixture({ at: '2026-03-29T00:30:00.000Z', rfcId: '<dsn-dst-in@ui-fixture.invalid>', blocks: 'Final-Recipient: rfc822; dst-in@recipient.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 Recipient rejected' }),
  dsnFixture({ at: '2026-03-29T21:59:00.000Z', rfcId: '<dsn-dst-last-minute@ui-fixture.invalid>', blocks: 'Final-Recipient: rfc822; dst-last@recipient.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 Recipient rejected' }),
  dsnFixture({ at: '2026-03-29T22:01:00.000Z', rfcId: '<dsn-dst-out@ui-fixture.invalid>', blocks: 'Final-Recipient: rfc822; dst-out@recipient.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 Recipient rejected' }),
];
const fixtureMessages = [...projectFixtureMessages, ...deliveryFixtureMessages];
assert.ok(projectFixtureMessages.length >= 6 && projectFixtureMessages.length <= 10, 'The project browser fixture must contain 6–10 physical messages.');
assert.ok(fixtureMessages.every((message) => [message.from, message.to, message.cc, message.bcc].flat().every((address) => address.address.toLowerCase().endsWith('.invalid'))), 'The UI fixture may contain only reserved .invalid email addresses.');
assert.equal(new Set(projectFixtureMessages.map((message) => message.rfcId)).size, projectFixtureMessages.length - 1, 'The project fixture has exactly one Inbox/Archive RFC duplicate.');
assert.equal(new Set(deliveryFixtureMessages.map((message) => message.rfcId)).size, deliveryFixtureMessages.length - 1, 'The delivery fixture has exactly one Inbox/Archive RFC duplicate.');

let app;
let databaseCreated = false;
let stopping = false;
let pumpActive = false;
let ticker;
let resolveShutdown;
const shutdownRequested = new Promise((resolve) => { resolveShutdown = resolve; });
function requestShutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\nStopping disposable UI fixture after ${signal}.`);
  resolveShutdown();
}
process.once('SIGINT', () => requestShutdown('SIGINT'));
process.once('SIGTERM', () => requestShutdown('SIGTERM'));

function redacted(message) {
  return String(message).split(adminUrl).join('[local admin URL redacted]').split(userPassword).join('[fixture password redacted]');
}

async function seedDatabase() {
  const auth = new AuthService(prisma, config);
  await auth.onModuleInit();
  await prisma.dashboardUser.update({ where: { email: userEmail }, data: { mustChangePassword: false } });
  await prisma.systemMailSender.upsert({ where: { email: deliverySender }, create: { email: deliverySender }, update: {} });

  const account = await prisma.mailAccount.create({ data: {
    email: accountEmail, host: settings.IMAP_HOST, port: 993, tlsMode: 'implicit', username: settings.IMAP_USERNAME,
    passwordCiphertext: 'synthetic-fixture-marker-not-a-real-credential', mailbox: 'INBOX', status: 'disconnected',
  } });

  const messagesByMailbox = new Map();
  for (const fixture of fixtureMessages) {
    const uid = (messagesByMailbox.get(fixture.mailbox) ?? 0) + 1;
    messagesByMailbox.set(fixture.mailbox, uid);
    const raw = [
      `From: ${fixture.from.map((entry) => entry.address).join(', ')}`,
      `To: ${fixture.to.map((entry) => entry.address).join(', ')}`,
      ...(fixture.cc.length ? [`Cc: ${fixture.cc.map((entry) => entry.address).join(', ')}`] : []),
      `Subject: ${fixture.subject}`, `Message-ID: ${fixture.rfcId}`,
      ...(fixture.headers.inReplyTo ? [`In-Reply-To: ${fixture.headers.inReplyTo}`] : []),
      ...(fixture.headers.references?.length ? [`References: ${fixture.headers.references.join(' ')}`] : []),
      '', fixture.body,
    ].join('\r\n');
    await prisma.emailMessage.create({ data: {
      mailAccountId: account.id, mailbox: fixture.mailbox, uidValidity: 1n, uid,
      providerMessageId: `ui-fixture-${fixture.mailbox.toLowerCase()}-${uid}`,
      historicalImport: false, rfcMessageId: fixture.rfcId, threadId: fixture.threadId,
      direction: fixture.direction, fromJson: fixture.from, toJson: fixture.to, ccJson: fixture.cc, bccJson: fixture.bcc,
      subject: fixture.subject, bodyText: fixture.body, headersJson: fixture.headers, rawSource: Buffer.from(fixture.rawSource ?? raw),
      sentAt: fixture.direction === 'outbound' ? fixture.at : null,
      receivedAt: fixture.direction === 'outbound' ? null : fixture.at,
      classification: fixture.classification, classificationReason: fixture.classificationReason,
      classificationEvidence: ['Synthetic fixture; not a real customer message.'], reviewRequired: false,
      classifiedAt: now, contactResolutionStatus: 'unresolved', projectResolutionStatus: 'unresolved',
      projectAssignmentVersion: 1, projectManualOverride: false,
    } });
  }

  const fromDate = new Date('2026-09-01T00:00:00.000Z');
  for (const mailbox of ['INBOX', 'Archive', 'Sent']) {
    const count = messagesByMailbox.get(mailbox) ?? 0;
    await prisma.syncCheckpoint.create({ data: {
      mailAccountId: account.id, mailbox, uidValidity: 1n, targetUid: null,
      fromDate, throughDate: now, lastUid: count, status: 'completed', scannedCount: count, importedCount: count,
      lastPolledAt: now, lastSuccessfulSyncAt: now, completedAt: now,
    } });
  }
}

async function makeApplication() {
  const auth = new AuthService(prisma, config);
  const systemMailSenders = new SystemMailSendersService(prisma);
  const deliveryFailures = new DeliveryFailuresService(config, prisma, systemMailSenders);
  const analysis = new ProjectEmailAnalysisService(prisma, config, provider, systemMailSenders);
  const senderRules = new SenderRulesService(prisma, config);
  const contacts = new ContactResolverService(config, prisma, analysis);
  const projects = new ProjectReviewService(config, prisma, analysis);
  const initialSync = new InitialSyncService(config, prisma, imap, new EmailNormalizer(), senderRules, analysis, logger, systemMailSenders);
  const businessGate = new BusinessGateService(config, prisma, systemMailSenders);
  const summaries = new SummaryTimelineService(config, prisma, analysis);
  const records = new BusinessRecordsService(config, prisma, contacts, projects, summaries);
  const events = new AgentEventsService(prisma, config, analysis, systemMailSenders);
  const integrations = new AgentIntegrationService(prisma, config, analysis, logger, systemMailSenders);
  const brief = new BusinessBriefService(prisma, config);
  const analyzer = new EmailAnalyzerService(config, prisma, provider, systemMailSenders);
  const importanceTriage = new EmailImportanceTriageService(prisma, config, provider, analysis, systemMailSenders);
  const deletionCleanup = new MailDeletionCleanupService(prisma, analysis);
  const deletionSync = new MailDeletionSyncService(config, prisma, imap, deletionCleanup, logger);
  const reconciliation = new MailReconciliationService(config, prisma, imap, initialSync, businessGate, contacts, projects, logger);
  const realtimeSync = { status: async () => ({ configured: true, enabled: false, status: 'fixture_disabled' }) };

  class UiCrmAcceptanceModule {}
  Module({ controllers: [MailController, ProjectAnalysisController, AuthController], providers: [
    [ConfigService, config], [AuthService, auth], [ProjectEmailAnalysisService, analysis], [SystemMailSendersService, systemMailSenders], [DeliveryFailuresService, deliveryFailures], [ImapMailService, imap],
    [InitialSyncService, initialSync], [BusinessGateService, businessGate], [RealtimeSyncService, realtimeSync],
    [ContactResolverService, contacts], [ProjectReviewService, projects], [SummaryTimelineService, summaries],
    [BusinessRecordsService, records], [AgentEventsService, events], [AgentIntegrationService, integrations],
    [BusinessBriefService, brief], [EmailAnalyzerService, analyzer], [MailReconciliationService, reconciliation],
    [EmailImportanceTriageService, importanceTriage], [SenderRulesService, senderRules],
    [MailDeletionSyncService, deletionSync],
  ].map(([provide, useValue]) => ({ provide, useValue })) })(UiCrmAcceptanceModule);

  const httpApp = await NestFactory.create(UiCrmAcceptanceModule, { logger: false });
  httpApp.setGlobalPrefix('api/v1');
  httpApp.use((request, response, next) => {
    try {
      if (!request.path?.startsWith('/api/v1/') || request.headers.authorization) return next();
      const cookie = String(request.headers.cookie ?? '');
      const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('sc_mail_session='))?.slice('sc_mail_session='.length);
      if (!token) return next();
      void auth.validateSession(token).then((session) => {
        if (!session || session.user.mustChangePassword) return next();
        const origin = request.headers.origin;
        const host = request.headers.host;
        if (request.method && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin && host && new URL(origin).host !== host) {
          return response.status(403).json({ code: 'CROSS_ORIGIN_REQUEST_REJECTED', message: 'Cross-origin request rejected.' });
        }
        request.headers.authorization = `Bearer ${token}`;
        return next();
      }).catch(next);
    } catch (error) { next(error); }
  });
  httpApp.useStaticAssets(join(root, 'apps', 'dashboard'), {
    prefix: '/dashboard',
    setHeaders: (response, path) => {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      if (/\.(?:html|js|css)$/.test(path)) response.setHeader('Cache-Control', 'no-cache');
    },
  });
  httpApp.getHttpAdapter().get('/', (_request, response) => response.redirect('/dashboard/'));
  await httpApp.listen(Number(process.env.PORT || 3000), '0.0.0.0');
  return { httpApp, analysis };
}

function waitForShutdown() {
  return shutdownRequested;
}

async function main() {
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    databaseCreated = true;
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: testUrl.toString() }, stdio: 'inherit', cwd: root,
    });
    await seedDatabase();
    if (stopping) return;
    const running = await makeApplication();
    app = running.httpApp;
    const port = Number(process.env.PORT || 3000);

    const tick = async () => {
      if (stopping || pumpActive) return;
      pumpActive = true;
      try {
        const result = await running.analysis.processBatch(5);
        if (result.claimed) console.log(`analysis.processBatch ${JSON.stringify(result)}`);
      } catch (error) { console.error(`Analysis fixture tick failed: ${redacted(error.message)}`); }
      finally { pumpActive = false; }
    };
    ticker = setInterval(() => { void tick(); }, 1000);
    ticker.unref();
    void tick();

    if (process.env.UI_CRM_RUN_CLI_SUITE === '1') {
      await require('./verify-crm-cli-http.cjs').run({ baseUrl: `http://127.0.0.1:${port}/api/v1`, token: apiToken, prisma });
      requestShutdown('completed CLI/MCP acceptance');
      return;
    }

    console.log(JSON.stringify({
      fixture: 'synthetic-only-ui-crm-acceptance', database: dbName, databaseIsolated: true,
      listening: `0.0.0.0:${port}`, browserUrl: 'http://127.0.0.1:3001/dashboard/',
      login: { email: userEmail, password: userPassword, mustChangePassword: false },
      mailbox: accountEmail,
      contactsToCreateManually: [
        { name: 'Anna Fischer', email: 'anna@nordlicht.invalid', company: 'Nordlicht Energie', project: 'Berlin Retrofit 2026' },
        { name: 'Morgan Reed', email: 'morgan@cedar.invalid', company: 'Cedar Point Logistics', project: 'Austin Packaging Line 2026' },
      ],
      messageFixture: { physicalMessages: projectFixtureMessages.length, logicalMessages: new Set(projectFixtureMessages.map((item) => item.rfcId)).size, contains: ['German 2026 project', 'US 2026 project', '2027 opportunity', 'holiday greeting', 'sent mail', 'CC/BCC', 'Inbox/Archive duplicate', 'changed-subject bottom reply', 'cross-project manual review'] },
      deliveryFixture: { physicalReports: deliveryFixtureMessages.length, logicalReports: new Set(deliveryFixtureMessages.map((item) => item.rfcId)).size, configuredSyntheticSender: deliverySender, contains: ['multiple failed recipients', 'unknown target despite mailbox To header', 'delay status', 'delivered notification', 'Inbox/Archive duplicate', 'Europe/Rome DST day includes 00:30Z and 21:59Z but excludes 22:01Z'] },
      safety: { imap: 'disabled fake transport', notifications: 'disabled', model: 'fake AIProvider only', crmSeeded: false, cleanup: 'exact isolated database is dropped on SIGINT/SIGTERM' },
    }, null, 2));
    await waitForShutdown();
  } catch (error) {
    console.error(`UI CRM fixture failed: ${redacted(error.stack ?? error.message)}`);
    process.exitCode = 1;
  } finally {
    stopping = true;
    if (ticker) clearInterval(ticker);
    if (app) await app.close().catch((error) => { console.error(`Fixture server shutdown failed: ${redacted(error.message)}`); process.exitCode = 1; });
    await prisma.$disconnect().catch(() => {});
    if (databaseCreated) {
      try { await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
      catch (error) { console.error(`Could not drop isolated database ${dbName}: ${redacted(error.message)}`); process.exitCode = 1; }
    }
    await admin.$disconnect().catch(() => {});
    if (databaseCreated && !process.exitCode) console.log(JSON.stringify({ database: dbName, temporaryDatabaseRemoved: true }));
  }
}

void main();
