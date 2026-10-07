/* Isolated real-PostgreSQL regressions for project email analysis and notification gating. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { ProjectEmailAnalysisService } = require('../dist/modules/mail/project-email-analysis.service.js');
const { AgentEventsService } = require('../dist/modules/mail/agent-events.service.js');
const { AgentIntegrationService } = require('../dist/modules/mail/agent-integration.service.js');
const { SummaryTimelineService } = require('../dist/modules/mail/summary-timeline.service.js');
const { MailDeletionCleanupService } = require('../dist/modules/mail/mail-deletion-cleanup.service.js');
const { SystemMailSendersService } = require('../dist/modules/mail/system-mail-senders.service.js');
const { validateProjectAssignmentEvidence } = require('../dist/modules/ai/project-assignment.schema.js');

const adminUrl = process.env.DATABASE_URL;
assert.ok(adminUrl, 'Set DATABASE_URL to a disposable local PostgreSQL server');
const parsedAdminUrl = new URL(adminUrl);
assert.ok(['localhost', '127.0.0.1', '::1', 'postgres'].includes(parsedAdminUrl.hostname), 'Project-analysis acceptance refuses remote/production database hosts');
assert.equal(process.env.PROJECT_ANALYSIS_ALLOW_LOCAL_DB_CREATE, '1', 'Set PROJECT_ANALYSIS_ALLOW_LOCAL_DB_CREATE=1 to authorize a uniquely named isolated local database');
assert.doesNotMatch(parsedAdminUrl.pathname.toLowerCase(), /prod(?:uction)?/, 'Production-named databases are refused');
const dbName = `aimail_project_analysis_${Date.now()}_${process.pid}`;
assert.match(dbName, /^aimail_project_analysis_\d+_\d+$/);
const testUrl = new URL(adminUrl); testUrl.pathname = `/${dbName}`;
const admin = new PrismaClient({ datasourceUrl: adminUrl });
const settings = {
  IMAP_EMAIL: 'project-analysis-owner@test.invalid', IMAP_HOST: 'imap.test.invalid', BUSINESS_TIMEZONE: 'Europe/Rome',
  DATABASE_URL: testUrl.toString(), NOTIFICATION_ALLOWED_CHANNELS: 'telegram', NOTIFICATION_ALLOWED_RECIPIENTS: '123456',
};
const config = { get: (key, fallback) => settings[key] === undefined ? fallback : settings[key] };
let db; let created = false; let sequence = 0;
function redact(value) {
  return String(value ?? '')
    .replaceAll(adminUrl, '[redacted-admin-database-url]')
    .replaceAll(testUrl.toString(), '[redacted-isolated-database-url]')
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://[redacted]@')
    .replace(/([?&](?:password|token)=)[^&\s]+/gi, '$1[redacted]');
}
function safeError(error) { return redact(error?.message ?? error ?? 'unknown error'); }
function safeStack(error) {
  const lines = redact(String(error?.stack ?? '')).split('\n');
  const sourceLines = lines.filter((line) => /(?:\/app\/|scripts\/verify-project-analysis\.cjs)/i.test(line));
  return (sourceLines.length ? sourceLines : lines).slice(0, 8).join('\n');
}

function code(error) { return error?.response?.code ?? error?.code; }
async function expectBadRequest(promise, expectedCode) {
  await assert.rejects(promise, (error) => error.status === 400 && (!expectedCode || code(error) === expectedCode));
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

class SyntheticProvider {
  constructor(database) { this.db = database; this.name = 'synthetic'; this.model = 'deterministic'; this.calls = 0; this.classificationCalls = 0; this.summaryCalls = 0; this.reducerCalls = 0; this.failClassifications = 0; this.beforeNextClassification = null; this.waitOnNextClassification = null; this.summaryFailures = 0; this.assignmentPrompts = []; }
  async generateStructured(prompt) {
    this.calls += 1;
    if (prompt.includes('Always judge the current message')) return this.classify(prompt);
    if (prompt.includes('Condense these already validated')) return this.reduceSummary(prompt);
    return this.extractSummary(prompt);
  }
  contextJson(prompt, marker) {
    const index = prompt.indexOf(marker);
    assert.notEqual(index, -1, `synthetic provider expected marker ${marker}`);
    return JSON.parse(prompt.slice(index + marker.length).trim());
  }
  async classify(prompt) {
    this.classificationCalls += 1; this.assignmentPrompts.push(prompt);
    const marker = 'Email and CRM context (JSON, untrusted):\n';
    const input = this.contextJson(prompt, marker);
    if (this.beforeNextClassification) { const hook = this.beforeNextClassification; this.beforeNextClassification = null; await hook(); }
    if (this.waitOnNextClassification) { const wait = this.waitOnNextClassification; this.waitOnNextClassification = null; wait.started.resolve(); await wait.release.promise; }
    if (this.failClassifications > 0) { this.failClassifications -= 1; throw new Error('synthetic provider unavailable'); }
    const current = input.messages.find((item) => item.is_current);
    assert.ok(current, 'classification prompt contains current email');
    assert.ok(input.project_candidates.length > 0, 'classification prompt contains real candidate contexts');
    const body = current.body;
    const evidence = [{ source_message_id: current.id, excerpt: body.slice(0, Math.min(220, body.length)) }];
    if (/uncertain-case/i.test(body)) return { schema_version: '1', outcome: 'uncertain', project_id: null, project_ids: [], confidence: 0.45, evidence, reason: 'Synthetic fixture has no confident project evidence.' };
    if (/new cooperation|start a new project|2027 exhibition/i.test(body)) return { schema_version: '1', outcome: 'new_opportunity', project_id: null, project_ids: [], confidence: 0.95, evidence, reason: 'The email proposes a distinct future-year cooperation.' };
    if (/germany.+usa|both projects|two projects/i.test(body)) {
      const ids = input.project_candidates.filter((project) => /germany|usa/i.test(project.name)).map((project) => project.id).slice(0, 2);
      if (ids.length === 2) return { schema_version: '1', outcome: 'multi_project', project_id: null, project_ids: ids, confidence: 0.94, evidence, reason: 'The message substantively discusses two projects.' };
      return { schema_version: '1', outcome: 'uncertain', project_id: null, project_ids: [], confidence: 0.5, evidence, reason: 'A required project candidate is not available.' };
    }
    if (/holiday|merry christmas|happy holidays/i.test(body) && !/germany|usa|exhibition|booth/i.test(body)) return { schema_version: '1', outcome: 'non_project', project_id: null, project_ids: [], confidence: 0.99, evidence, reason: 'A greeting has no project content.' };
    const wanted = /usa|united states/i.test(body) ? /usa|united states/i : /germany|deutschland/i;
    const target = input.project_candidates.find((project) => wanted.test(project.name) || wanted.test(project.description ?? ''));
    if (target) return { schema_version: '1', outcome: 'assigned', project_id: target.id, project_ids: [target.id], confidence: 0.97, evidence, reason: 'Current email explicitly identifies the exhibition project.' };
    return { schema_version: '1', outcome: 'non_project', project_id: null, project_ids: [], confidence: 0.95, evidence, reason: 'No project content is present.' };
  }
  async extractSummary(prompt) {
    this.summaryCalls += 1;
    if (this.summaryFailures > 0) { this.summaryFailures -= 1; throw new Error('synthetic summary provider failure'); }
    const input = this.contextJson(prompt, 'Return JSON.\n');
    const messages = input.included_messages ?? [];
    const claims = messages.slice(0, 12).map((message) => {
      const initial = /EARLY-CONTRACT/.test(message.body);
      return {
        text: initial ? 'Initial scope and quoted price were confirmed.' : `Project email recorded: ${message.body.slice(0, 250)}`,
        evidence: [{ source_message_id: message.id, excerpt: initial ? 'EARLY-CONTRACT: initial scope and quoted price confirmed.' : message.body.slice(0, Math.min(180, message.body.length)) }],
      };
    });
    return { summary: 'Untrusted free summary deliberately ignored.', claims };
  }
  async reduceSummary(prompt) {
    this.reducerCalls += 1;
    const input = this.contextJson(prompt, '\n');
    const claims = input.claims ?? [];
    const earlyContract = claims.find((claim) => /Initial scope and quoted price/.test(claim.text));
    const latest = [...claims].sort((left, right) => String(right.sourceDate ?? '').localeCompare(String(left.sourceDate ?? '')))[0];
    const tail = claims.at(-1);
    return { summary: 'Untrusted reducer free summary ignored.', claims: [...new Map([earlyContract, latest, tail].filter(Boolean).map((claim) => [claim.text, { text: claim.text, evidence: claim.evidence }])).values()] };
  }
}

async function createContact(accountLabel='main') {
  const company = await db.company.create({ data: { name: `Synthetic ${accountLabel} Customer`, website: 'https://customer.example.invalid', address: 'Synthetic customer address', notes: 'Shared company for all synthetic projects.' } });
  const contact = await db.contact.create({ data: { displayName: `Synthetic ${accountLabel} Contact`, companyId: company.id, notes: 'Synthetic contact project context.', status: 'confirmed', confidence: 1 } });
  const email = accountLabel === 'main' ? 'member@customer.test' : `${accountLabel}@customer.test`;
  await db.contactEmail.create({ data: { contactId: contact.id, email, isPrimary: true, verified: true } });
  if (accountLabel === 'main') await db.contactEmail.create({ data: { contactId: contact.id, email: 'alternate@customer.test', isPrimary: false, verified: true } });
  return { ...contact, email, companyId: company.id };
}
async function createProject(contact, options) {
  return db.project.create({ data: {
    companyId: contact.companyId,
    name: options.name, description: options.description ?? `Synthetic ${options.name} project description.`,
    status: options.status ?? 'active', stage: options.status === 'completed' ? 'completed' : 'design',
    projectContacts: { create: [{ contactId: contact.id, isPrimary: true }] },
  } });
}
async function createMessage(accountId, contact, options={}) {
  const n = ++sequence; const when = options.at ?? new Date('2026-07-01T10:00:00.000Z');
  const inbound = options.direction !== 'outbound';
  return db.emailMessage.create({ data: {
    mailAccountId: accountId, mailbox: options.mailbox ?? (inbound ? 'INBOX' : 'Sent'), uidValidity: 1n, uid: n,
    providerMessageId: `project-analysis-${n}`, rfcMessageId: options.rfcMessageId ?? `<project-analysis-${n}@test.invalid>`,
    historicalImport: options.historicalImport ?? false, direction: options.direction ?? 'inbound',
    fromJson: options.from ?? [{ address: inbound ? contact.email : settings.IMAP_EMAIL }],
    toJson: options.to ?? [{ address: inbound ? settings.IMAP_EMAIL : contact.email }], ccJson: options.cc ?? [], bccJson: options.bcc ?? [],
    subject: options.subject ?? `Synthetic mail ${n}`, bodyText: options.body ?? 'Germany exhibition booth update: drawing approved.', bodyHtml: null,
    headersJson: options.headersJson ?? {}, rawSource: Buffer.from('synthetic raw email only'),
    receivedAt: inbound ? when : null, sentAt: inbound ? null : when,
    classification: options.classification ?? 'BUSINESS_HUMAN', reviewRequired: options.reviewRequired ?? false,
    ...(options.senderRuleSnapshot ? { senderRuleSnapshot: options.senderRuleSnapshot } : {}),
    ...(options.projectId ? { projectId: options.projectId, projectResolutionStatus: 'matched' } : {}),
    projectManualOverride: Boolean(options.projectManualOverride), projectAssignmentVersion: options.projectAssignmentVersion ?? 1,
    classificationManualOverride: Boolean(options.classificationManualOverride),
    contactId: contact.id, contactResolutionStatus: 'matched',
  } });
}
async function runJob(service, jobId, maxPasses=80) {
  for (let index=0; index<maxPasses; index += 1) {
    const job = await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: jobId } });
    if (['completed', 'partial', 'failed', 'cancelled'].includes(job.status)) return job;
    await service.processBatch(20);
    const now = new Date(0);
    await db.projectAnalysisJob.updateMany({ where: { id: jobId, status: 'pending' }, data: { nextAttemptAt: now } });
    await db.projectAnalysisItem.updateMany({ where: { jobId, status: 'pending' }, data: { nextAttemptAt: now } });
  }
  throw new Error(`Synthetic project analysis job ${jobId} did not finish`);
}

async function main() {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`); created = true;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: testUrl.toString() }, stdio: 'pipe' });
  db = new PrismaClient({ datasourceUrl: testUrl.toString() });
  const account = await db.mailAccount.create({ data: { email: settings.IMAP_EMAIL, host: settings.IMAP_HOST, port: 993, tlsMode: 'implicit', username: settings.IMAP_EMAIL, passwordCiphertext: 'synthetic-only' } });
  const systemMailSenders = new SystemMailSendersService(db);
  const member = await createContact();
  const germany = await createProject(member, { name: 'Germany Exhibition 2026', description: 'Germany exhibition booth design, lighting plan, and delivery in October 2026.' });
  const usa = await createProject(member, { name: 'USA Exhibition 2026', description: 'United States exhibition booth design and delivery in November 2026.' });
  const provider = new SyntheticProvider(db);
  const service = new ProjectEmailAnalysisService(db, config, provider, systemMailSenders);

  const firstBatchIds = [];
  for (let day=1; day<=31; day += 1) {
    const body = day === 1 ? 'EARLY-CONTRACT: initial scope and quoted price confirmed.' : `Routine update ${day}: Germany booth drawing revision ${day} received.`;
    const when = new Date(`2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`);
    const message = await createMessage(account.id, member, { at: when, body, subject: day === 1 ? 'Early contract confirmation' : `Germany progress ${day}` });
    if (day === 1) firstBatchIds.push(message.id);
    if (day === 14) {
      const duplicate = await createMessage(account.id, member, { at: when, mailbox: 'Archive', rfcMessageId: message.rfcMessageId, body, subject: message.subject });
      firstBatchIds.push(duplicate.id);
    }
  }
  const firstJob = await service.createJob(germany.id, { operationId: 'history-31', from: '2026-07-01', to: '2026-07-31', limit: 100 });
  assert.equal(firstJob.candidateCount, 31, 'same-account Inbox/Archive RFC copies are one logical candidate');
  assert.equal(firstJob.totalCandidateCount, 31);
  const replay = await service.createJob(germany.id, { operationId: 'history-31', from: '2026-07-01', to: '2026-07-31', limit: 100 });
  assert.equal(replay.replayed, true); assert.equal(replay.jobId, firstJob.jobId);
  const finishedHistory = await runJob(service, firstJob.jobId);
  assert.equal(finishedHistory.status, 'completed');
  assert.equal(finishedHistory.processedCount, 31); assert.equal(finishedHistory.assignedCount, 31);
  assert.ok(provider.reducerCalls > 0, 'more than 30 emails create a real claim reduction pass');
  const summary = await db.summary.findUniqueOrThrow({ where: { entityType_entityId: { entityType: 'project', entityId: germany.id } }, include: { versions: true } });
  const visibleSummary = summary.versions.find((version) => version.id === summary.currentVersionId).newSummary;
  assert.match(visibleSummary, /Initial scope and quoted price were confirmed/, 'the early contract confirmation survives multi-batch reduction');
  const coverage = summary.coverageJson;
  assert.equal(coverage.includedCount, 31, 'summary coverage counts logical mail identities, not folder copies');
  assert.equal(coverage.totalProjectMessageCount, 31);
  assert.equal(coverage.sourceMessageIds.length, 31);
  assert.equal(coverage.totalValidatedClaims, 23);
  assert.ok(coverage.claims.some((claim) => claim.evidence.some((evidence) => evidence.excerpt.includes('EARLY-CONTRACT'))), 'coverage retains exact source evidence for extracted claims');
  const copies = await db.emailMessage.findMany({ where: { id: { in: firstBatchIds } } });
  assert.equal(copies.length, 2); assert.ok(copies.every((copy) => copy.projectId === germany.id), 'validated automatic assignment propagates across duplicate folder copies');

  const classificationCalls = provider.classificationCalls; const summaryCalls = provider.summaryCalls;
  const cachedJob = await service.createJob(germany.id, { operationId: 'history-cache-replay', from: '2026-07-01', to: '2026-07-31', limit: 100 });
  await runJob(service, cachedJob.jobId);
  assert.equal(provider.classificationCalls, classificationCalls, 'new operation with unchanged input reuses stable item classification cache');
  assert.equal(provider.summaryCalls, summaryCalls, 'same project summary input does not call provider again');
  await db.project.update({ where: { id: germany.id }, data: { description: 'Updated after the request completed.', version: { increment: 1 } } });
  const replayAfterContextChange = await service.createJob(germany.id, { operationId: 'history-31', from: '2026-07-01', to: '2026-07-31', limit: 100 });
  assert.equal(replayAfterContextChange.replayed, true); assert.equal(replayAfterContextChange.jobId, firstJob.jobId, 'same operation payload replays the original job even after context changes');

  const greeting = await createMessage(account.id, member, { at: new Date('2026-08-01T10:00:00Z'), body: 'Merry Christmas. Wishing your team a peaceful holiday season.' });
  const mixedGreeting = await createMessage(account.id, member, { at: new Date('2026-08-02T10:00:00Z'), body: 'Merry Christmas! Germany exhibition booth lighting drawing is confirmed.' });
  const usMail = await createMessage(account.id, member, { at: new Date('2026-08-03T10:00:00Z'), body: 'USA exhibition booth lighting plan approved; update the November display.' });
  const newOpportunity = await createMessage(account.id, member, { at: new Date('2026-08-04T10:00:00Z'), body: 'For the 2027 exhibition we would like to start a new cooperation.' });
  const multiProject = await createMessage(account.id, member, { at: new Date('2026-08-05T10:00:00Z'), body: 'Germany and USA booths both need final lighting plans.' });
  const mixedJob = await service.createJob(germany.id, { operationId: 'mixed-holiday-content', from: '2026-08-01', to: '2026-08-02', limit: 10 });
  await runJob(service, mixedJob.jobId);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: greeting.id } })).projectId, null, 'pure holiday greeting stays out of a single matching project');
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: mixedGreeting.id } })).projectId, germany.id, 'greeting plus substantive project content is assigned');
  const usJob = await service.createJob(germany.id, { operationId: 'cross-project-us', from: '2026-08-03', to: '2026-08-03', limit: 10 });
  const usResult = await runJob(service, usJob.jobId);
  assert.equal(usResult.projectId, germany.id, 'manual job remains anchored to the project the user opened');
  assert.equal(usResult.assignedCount, 1);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: usMail.id } })).projectId, usa.id, 'comparison sends US exhibition content to the other supplied project');
  assert.equal(await db.projectAnalysisJob.count({ where: { operationId: { startsWith: `summary-refresh:${usResult.id}:` }, projectId: usa.id } }), 1, 'cross-project assignment queues a separate summary refresh without retargeting the manual job');
  const opportunityJob = await service.createJob(germany.id, { operationId: 'new-2027-opportunity', from: '2026-08-04', to: '2026-08-04', limit: 10 });
  await runJob(service, opportunityJob.jobId);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: newOpportunity.id } })).projectId, null);
  const opportunityReview = await db.reviewItem.findFirst({ where: { sourceMessageId: newOpportunity.id, reasonCode: 'PROJECT_ANALYSIS_NEW_OPPORTUNITY', status: 'pending' } });
  assert.ok(opportunityReview, 'new cooperation is visible as a durable review, not auto-created CRM data');
  assert.equal(opportunityReview.proposedChangeJson.candidates[0].name, 'Germany Exhibition 2026');
  const mixedJob2 = await service.createJob(germany.id, { operationId: 'multi-project-message', from: '2026-08-05', to: '2026-08-05', limit: 10 });
  await runJob(service, mixedJob2.jobId);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: multiProject.id } })).projectId, null, 'multi-project mail remains unassigned');
  assert.ok(await db.reviewItem.findFirst({ where: { sourceMessageId: multiProject.id, reasonCode: 'PROJECT_ANALYSIS_MULTI_PROJECT', status: 'pending' } }));
  const uncertain = await createMessage(account.id, member, { at: new Date('2026-08-06T10:00:00Z'), body: 'uncertain-case: the message has no reliable project detail.' });
  const uncertainJob = await service.createJob(germany.id, { operationId: 'uncertain-review-visible', from: '2026-08-06', to: '2026-08-06', limit: 10 });
  await runJob(service, uncertainJob.jobId);
  const uncertainRow = await db.emailMessage.findUniqueOrThrow({ where: { id: uncertain.id } });
  const uncertainReview = await db.reviewItem.findFirst({ where: { sourceMessageId: uncertain.id, reasonCode: 'PROJECT_ANALYSIS_UNCERTAIN', status: 'pending' } });
  assert.ok(uncertainReview, 'uncertain inbound classification persists for global review even with a nullable incoming scope');
  const manual = await service.manuallyAssign(uncertain.id, { operationId: 'resolve-analysis-review', expectedVersion: uncertainRow.projectAssignmentVersion, projectId: germany.id });
  assert.equal(manual.projectId, germany.id);
  assert.equal(await db.reviewItem.count({ where: { sourceMessageId: uncertain.id, reasonCode: { startsWith: 'PROJECT_ANALYSIS_' }, status: 'pending' } }), 0, 'manual PATCH closes the matching generated project review');

  const correctableRfc = '<manual-project-correction@test.invalid>';
  const manuallyUnassigned = await createMessage(account.id, member, { at: new Date('2026-08-06T11:00:00Z'), rfcMessageId: correctableRfc, body: 'A user can correct this manual project decision.' });
  const manuallyUnassignedCopy = await createMessage(account.id, member, { at: new Date('2026-08-06T11:01:00Z'), mailbox: 'Archive', rfcMessageId: correctableRfc, body: 'A user can correct this manual project decision.' });
  const initiallyUnassignedVersion = manuallyUnassigned.projectAssignmentVersion;
  const lockedAsNonProject = await service.manuallyAssign(manuallyUnassigned.id, { operationId: 'manual-correction-lock-null', expectedVersion: initiallyUnassignedVersion, projectId: null });
  assert.ok(lockedAsNonProject.copies.every((copy) => copy.projectId === null && copy.projectAssignmentVersion > initiallyUnassignedVersion));
  const correctedManualDecision = await service.manuallyAssign(manuallyUnassigned.id, { operationId: 'manual-correction-to-germany', expectedVersion: lockedAsNonProject.projectAssignmentVersion, projectId: germany.id });
  assert.equal(correctedManualDecision.projectId, germany.id, 'a current CAS can correct a prior manual null decision');
  const correctedManualCopies = await db.emailMessage.findMany({ where: { id: { in: [manuallyUnassigned.id, manuallyUnassignedCopy.id] } } });
  assert.ok(correctedManualCopies.every((copy) => copy.projectId === germany.id && copy.projectManualOverride), 'manual correction synchronizes and locks all same-RFC copies');
  await assert.rejects(
    service.manuallyAssign(manuallyUnassigned.id, { operationId: 'manual-correction-stale-cas', expectedVersion: lockedAsNonProject.projectAssignmentVersion, projectId: null }),
    (error) => error.status === 409 && code(error) === 'VERSION_CONFLICT',
    'a stale assignment version still cannot roll back the corrected manual decision',
  );
  const conflictingManualRfc = '<manual-project-copy-conflict@test.invalid>';
  const conflictedCopyA = await createMessage(account.id, member, { at: new Date('2026-08-06T12:00:00Z'), rfcMessageId: conflictingManualRfc, projectId: germany.id, projectManualOverride: true, projectAssignmentVersion: 7 });
  await createMessage(account.id, member, { at: new Date('2026-08-06T12:01:00Z'), mailbox: 'Archive', rfcMessageId: conflictingManualRfc, projectId: usa.id, projectManualOverride: true, projectAssignmentVersion: 7 });
  await assert.rejects(
    service.manuallyAssign(conflictedCopyA.id, { operationId: 'manual-conflicting-copies', expectedVersion: 7, projectId: germany.id }),
    (error) => error.status === 409 && code(error) === 'RFC_COPY_MANUAL_ASSIGNMENT_CONFLICT',
    'conflicting manual decisions already stored on duplicate copies still require resolution',
  );

  const machine = await createMessage(account.id, member, { at: new Date('2026-08-07T10:00:00Z'), body: 'Germany exhibition booth lighting approved.', classification: 'NEWSLETTER' });
  const blacklisted = await createMessage(account.id, member, { at: new Date('2026-08-08T10:00:00Z'), body: 'Germany exhibition booth lighting approved.', classification: 'BLACKLISTED', senderRuleSnapshot: { action: 'blacklist' } });
  const beforeMachineCalls = provider.classificationCalls;
  const machineJob = await service.createJob(germany.id, { operationId: 'machine-blacklist-skip', from: '2026-08-07', to: '2026-08-08', limit: 10 });
  await runJob(service, machineJob.jobId);
  assert.equal(provider.classificationCalls, beforeMachineCalls, 'machine/blacklisted exact project body never reaches the model');
  assert.equal((await db.projectAnalysisItem.findFirstOrThrow({ where: { jobId: machineJob.jobId, sourceMessageId: machine.id } })).outcome, 'skipped_machine');
  assert.equal((await db.projectAnalysisItem.findFirstOrThrow({ where: { jobId: machineJob.jobId, sourceMessageId: blacklisted.id } })).outcome, 'skipped_blacklist');
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: machine.id } })).projectId, null);
  await expectBadRequest(service.createJob(germany.id, { operationId: 'bad-calendar-date', from: '2026-02-31', to: '2026-03-02' }), '');

  const participantMessages = [
    await createMessage(account.id, member, { at: new Date('2026-08-24T08:00:00Z'), from: [{ address: 'vendor@example.test' }], to: [{ address: member.email }], body: 'Germany exhibition: the booth layout is approved.' }),
    await createMessage(account.id, member, { at: new Date('2026-08-24T09:00:00Z'), from: [{ address: 'vendor@example.test' }], to: [{ address: 'sales@customer.test' }], cc: [{ address: 'alternate@customer.test' }], body: 'Germany exhibition: lighting plan is approved.' }),
    await createMessage(account.id, member, { at: new Date('2026-08-24T10:00:00Z'), from: [{ address: member.email }], to: [{ address: settings.IMAP_EMAIL }], body: 'Germany exhibition: installation schedule is approved.' }),
    await createMessage(account.id, member, { at: new Date('2026-08-24T11:00:00Z'), from: [{ address: 'vendor@example.test' }], to: [{ address: settings.IMAP_EMAIL }], bcc: [{ address: 'alternate@customer.test' }], body: 'Germany exhibition: final delivery check is approved.' }),
  ];
  const participantJob = await service.createJob(germany.id, { operationId: 'all-participant-address-fields', from: '2026-08-24', to: '2026-08-24', limit: 10 });
  assert.equal(participantJob.candidateCount, 4, 'candidate discovery includes member emails in From, To, CC, and BCC');
  await runJob(service, participantJob.jobId);
  const participantRows = await db.emailMessage.findMany({ where: { id: { in: participantMessages.map((message) => message.id) } } });
  assert.ok(participantRows.every((message) => message.projectId === germany.id));

  const foreignContact = await createContact('foreign-company');
  await db.projectContact.create({ data: { projectId: germany.id, contactId: foreignContact.id, isPrimary: false } });
  const mismatchedMemberMail = await createMessage(account.id, foreignContact, { at: new Date('2026-08-25T10:00:00Z'), body: 'Germany exhibition booth progress is confirmed.' });
  const mismatchedIncoming = await db.$transaction((tx) => service.enqueueIncoming(tx, mismatchedMemberMail.id));
  assert.equal(mismatchedIncoming, null, 'a stale ProjectContact whose contact belongs to another company cannot trigger project analysis');
  assert.equal((await service.contextSnapshot(db, mismatchedMemberMail, germany.id)).candidates.some((candidate) => candidate.id === germany.id), false, 'inconsistent company ownership is absent from the current candidate snapshot');
  assert.equal((await service.validateProjectNotification(mismatchedMemberMail.id, { projectNotification: true, projectId: germany.id, projectAssignmentVersion: mismatchedMemberMail.projectAssignmentVersion, projectContextHash: 'stale' })).allowed, false, 'company-mismatched membership cannot validate a queued project route');

  // A summary-only failure is retried without re-running or reclassifying its mail items.
  const summaryRetryMail = await createMessage(account.id, member, { at: new Date('2026-08-06T12:00:00Z'), body: 'USA exhibition booth layout is approved for the November event.' });
  provider.summaryFailures = 1;
  const summaryRetryJob = await service.createJob(usa.id, { operationId: 'summary-only-failure-retry', from: '2026-08-06', to: '2026-08-06', limit: 10 });
  await runJob(service, summaryRetryJob.jobId);
  const summaryFailedState = await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: summaryRetryJob.jobId } });
  assert.equal(summaryFailedState.summaryStatus, 'failed');
  assert.equal(summaryFailedState.failedCount, 0);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: summaryRetryMail.id } })).projectId, usa.id);
  const callsBeforeSummaryRetry = provider.classificationCalls;
  await service.retry(summaryRetryJob.jobId, 'summary-only-retry');
  await runJob(service, summaryRetryJob.jobId);
  const summaryRetriedState = await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: summaryRetryJob.jobId } });
  assert.equal(summaryRetriedState.summaryStatus, 'completed');
  assert.equal(provider.classificationCalls, callsBeforeSummaryRetry, 'summary-only retry never reclassifies completed mail items');

  // A protected human summary remains current while a new derived suggestion is created and explicitly adopted.
  const germanySummary = await db.summary.findUniqueOrThrow({ where: { entityType_entityId: { entityType: 'project', entityId: germany.id } } });
  const currentGermanyVersion = await db.summaryVersion.findUniqueOrThrow({ where: { id: germanySummary.currentVersionId } });
  const maxGermanyVersion = await db.summaryVersion.aggregate({ where: { summaryId: germanySummary.id }, _max: { version: true } });
  const humanVersionNumber = (maxGermanyVersion._max.version ?? 0) + 1;
  const humanVersion = await db.summaryVersion.create({ data: { summaryId: germanySummary.id, version: humanVersionNumber, previousSummary: currentGermanyVersion.newSummary, newSummary: 'Human-protected summary: preserve this exact wording.', model: 'synthetic-manual-edit' } });
  await db.summary.update({ where: { id: germanySummary.id }, data: { version: humanVersionNumber, currentVersionId: humanVersion.id, manualOverride: true, isDerived: false, inputHash: null, coverageJson: { stale: true, source: 'synthetic-manual-edit' } } });
  const suggestionMail = await createMessage(account.id, member, { at: new Date('2026-08-26T10:00:00Z'), body: 'Germany exhibition booth lighting confirmation: final mockup approved after client review.' });
  const suggestionJob = await service.createJob(germany.id, { operationId: 'human-summary-derived-suggestion', from: '2026-08-26', to: '2026-08-26', limit: 10 });
  await runJob(service, suggestionJob.jobId);
  const suggestionState = await db.summary.findUniqueOrThrow({ where: { id: germanySummary.id }, include: { versions: true } });
  assert.equal(suggestionState.currentVersionId, humanVersion.id, 'automatic derivation never replaces a protected human summary');
  assert.equal(suggestionState.versions.find((version) => version.id === humanVersion.id).newSummary, 'Human-protected summary: preserve this exact wording.');
  const suggestionVersion = suggestionState.versions.find((version) => version.isSuggestion);
  assert.ok(suggestionVersion); assert.match(suggestionVersion.newSummary, /final mockup approved/, 'new derived text is saved as a readable suggestion');
  assert.ok(suggestionState.coverageJson.suggestionCoverage.sourceMessageIds.includes(suggestionMail.id));
  const adopted = await new SummaryTimelineService(config, db, service).rollback({ operationId: 'adopt-human-summary-suggestion', summaryId: suggestionState.id, expectedVersion: suggestionState.version, targetVersion: suggestionVersion.version });
  assert.equal(adopted.summary, suggestionVersion.newSummary, 'version-CAS suggestion adoption sets the selected derived text as current');
  const adoptedState = await db.summary.findUniqueOrThrow({ where: { id: germanySummary.id } });
  assert.equal(adoptedState.currentVersionId !== humanVersion.id, true); assert.equal(adoptedState.manualOverride, true);

  const staleMessage = await createMessage(account.id, member, { at: new Date('2026-08-09T10:00:00Z'), body: 'Germany exhibition booth lighting plan is confirmed.' });
  provider.beforeNextClassification = async () => { await db.project.update({ where: { id: germany.id }, data: { description: 'Changed during provider call.', version: { increment: 1 } } }); };
  const staleJob = await service.createJob(germany.id, { operationId: 'stale-project-context', from: '2026-08-09', to: '2026-08-09', limit: 10 });
  await runJob(service, staleJob.jobId);
  const staleItem = await db.projectAnalysisItem.findFirstOrThrow({ where: { jobId: staleJob.jobId } });
  assert.equal(staleItem.status, 'needs_review'); assert.equal(staleItem.lastErrorCode, 'PROJECT_CONTEXT_STALE');
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: staleMessage.id } })).projectId, null, 'stale provider output cannot update assignment');

  const retryMail = await createMessage(account.id, member, { at: new Date('2026-08-10T10:00:00Z'), body: 'Germany exhibition booth drawing needs provider retry.' });
  provider.failClassifications = 3;
  const retryJob = await service.createJob(germany.id, { operationId: 'retry-without-double-count', from: '2026-08-10', to: '2026-08-10', limit: 10 });
  for (let attempt=0; attempt<3; attempt += 1) {
    await service.processBatch(1);
    await db.projectAnalysisJob.update({ where: { id: retryJob.jobId }, data: { nextAttemptAt: new Date(0) } });
    await db.projectAnalysisItem.updateMany({ where: { jobId: retryJob.jobId, status: 'pending' }, data: { nextAttemptAt: new Date(0) } });
  }
  await runJob(service, retryJob.jobId);
  const failedRetryState = await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: retryJob.jobId } });
  assert.equal(failedRetryState.status, 'failed'); assert.equal(failedRetryState.failedCount, 1);
  provider.failClassifications = 0;
  await service.retry(retryJob.jobId, 'retry-operation');
  await runJob(service, retryJob.jobId);
  const retriedState = await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: retryJob.jobId } });
  assert.equal(retriedState.status, 'completed'); assert.equal(retriedState.processedCount, 1, 'counters reflect item state and do not double count retry attempts');
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: retryMail.id } })).projectId, germany.id);

  const cancelA = await createMessage(account.id, member, { at: new Date('2026-08-11T10:00:00Z'), body: 'Germany exhibition booth design confirmed.' });
  const cancelB = await createMessage(account.id, member, { at: new Date('2026-08-11T11:00:00Z'), body: 'Germany exhibition lighting confirmation.' });
  const cancelJob = await service.createJob(germany.id, { operationId: 'cancel-inflight-operation', from: '2026-08-11', to: '2026-08-11', limit: 10 });
  const entered = deferred(), release = deferred(); provider.waitOnNextClassification = { started: entered, release };
  const running = service.processBatch(1);
  await entered.promise;
  await service.cancel(cancelJob.jobId, 'cancel-inflight-request');
  release.resolve(); await running;
  const cancelled = await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: cancelJob.jobId } });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.summaryStatus, 'not_requested', 'cancelling before any work gives summary a terminal status');
  assert.equal(await db.projectAnalysisItem.count({ where: { jobId: cancelJob.jobId, status: 'cancelled' } }), 2, 'in-flight cancellation stops the leased item and unexecuted remainder');
  assert.equal(cancelled.processedCount, 2);

  const crashedCancelMail = await createMessage(account.id, member, { at: new Date('2026-08-12T08:00:00Z'), body: 'Germany exhibition booth layout is awaiting recovery.' });
  const crashedCancelJob = await service.createJob(germany.id, { operationId: 'cancel-expired-lease-recovery', from: '2026-08-12', to: '2026-08-12', limit: 10 });
  const crashedItem = await db.projectAnalysisItem.findFirstOrThrow({ where: { jobId: crashedCancelJob.jobId } });
  await db.projectAnalysisJob.update({ where: { id: crashedCancelJob.jobId }, data: { status: 'processing', cancelRequested: true, leaseToken: 'synthetic-crashed-cancel', leaseExpiresAt: new Date(0) } });
  await db.projectAnalysisItem.update({ where: { id: crashedItem.id }, data: { status: 'processing', leaseToken: 'synthetic-crashed-item', leaseExpiresAt: new Date(0) } });
  await service.processBatch(1);
  const recoveredCancel = await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: crashedCancelJob.jobId } });
  assert.equal(recoveredCancel.status, 'cancelled', 'an expired cancel-requested lease reaches terminal state after worker crash');
  assert.equal(recoveredCancel.summaryStatus, 'not_requested');
  assert.equal(await db.projectAnalysisItem.count({ where: { jobId: crashedCancelJob.jobId, status: 'cancelled' } }), 1);

  const retryMember = await createContact('backoff');
  const retryProject = await createProject(retryMember, { name: 'Germany Backoff 2026', description: 'Synthetic isolated project for testing item retry backoff.' });
  const futureRetryMail = await createMessage(account.id, retryMember, { at: new Date('2026-08-23T09:00:00Z'), body: 'Germany exhibition booth requires a temporary provider retry.' });
  provider.failClassifications = 1;
  const futureRetryJob = await service.createJob(retryProject.id, { operationId: 'summary-waits-for-item-retry', from: '2026-08-23', to: '2026-08-23', limit: 10 });
  await service.processBatch(1);
  const futureRetryItem = await db.projectAnalysisItem.findFirstOrThrow({ where: { jobId: futureRetryJob.jobId } });
  const waitingJob = await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: futureRetryJob.jobId } });
  assert.equal(futureRetryItem.status, 'pending'); assert.ok(futureRetryItem.nextAttemptAt > new Date());
  assert.equal(waitingJob.status, 'pending'); assert.equal(waitingJob.summaryStatus, 'pending', 'a future item retry prevents a premature partial summary');
  await db.projectAnalysisJob.update({ where: { id: futureRetryJob.jobId }, data: { nextAttemptAt: new Date(0) } });
  await db.projectAnalysisItem.updateMany({ where: { jobId: futureRetryJob.jobId, status: 'pending' }, data: { nextAttemptAt: new Date(0) } });
  await runJob(service, futureRetryJob.jobId);
  assert.equal((await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: futureRetryJob.jobId } })).status, 'completed');

  const events = new AgentEventsService(db, config, service, systemMailSenders);
  async function makeRealtimeEvent(message, { status = 'pending', importance = 'normal', projectNotification = false, exhausted = false } = {}) {
    const id = await service.canonicalMailId(db, message.id);
    const event = await db.agentEvent.create({ data: {
      eventKey: `mail-importance:${id}`, eventType: 'INBOUND_EMAIL_RECEIVED', entityType: 'email_message', entityId: id,
      priority: 8, notificationPolicy: 'REALTIME', status, attempts: exhausted ? 8 : 0, maxAttempts: 8, nextAttemptAt: exhausted ? new Date(Date.now() + 24 * 60 * 60_000) : new Date(), lastError: exhausted ? 'synthetic prior event exhausted' : null,
      ...(status === 'completed' ? { processedAt: new Date(), resultJson: { actionable: false } } : {}),
      payloadJson: { classification: 'BUSINESS_HUMAN', importance, notificationReasons: [], ...(projectNotification ? { projectNotification: true, projectId: germany.id, projectAssignmentVersion: message.projectAssignmentVersion, projectContextHash: 'stale-until-merged' } : {}) },
    } });
    await db.agentWakeupDelivery.create({ data: { eventId: event.id, ...(status === 'completed' ? { status: 'delivered', deliveredAt: new Date() } : {}), ...(exhausted ? { status: 'failed', attempts: 6, nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000), lastError: 'synthetic wakeup exhausted' } : {}) } });
    return event;
  }
  async function completeWith(eventsService, eventId, result, notifications=[]) {
    const claim = (await eventsService.claim('synthetic-agent', 1, 60, eventId))[0];
    assert.ok(claim, `synthetic event ${eventId} is claimable`);
    return eventsService.complete(eventId, { agentId: 'synthetic-agent', leaseToken: claim.leaseToken, result, notifications });
  }
  const send = (key, content='Synthetic project update notification') => ({ requestKey: key, channel: 'telegram', recipientRef: '123456', content });

  const incoming = await createMessage(account.id, member, { at: new Date('2026-08-14T10:00:00Z'), body: 'Germany exhibition booth progress update: lighting plan is approved.', historicalImport: false });
  const incomingCopy = await createMessage(account.id, member, { at: new Date('2026-08-12T10:00:00Z'), mailbox: 'Archive', rfcMessageId: incoming.rfcMessageId, body: incoming.bodyText, historicalImport: false });
  const canonicalId = await service.canonicalMailId(db, incoming.id);
  const highEvent = await makeRealtimeEvent(incoming, { importance: 'normal' });
  const incomingJobId = await db.$transaction((tx) => service.enqueueIncoming(tx, incoming.id));
  assert.ok(incomingJobId);
  assert.equal(await db.$transaction((tx) => service.enqueueIncoming(tx, incomingCopy.id)), incomingJobId, 'same RFC Inbox/Archive copies enqueue one durable incoming analysis');
  await runJob(service, incomingJobId);
  const eventCount = await db.agentEvent.count({ where: { eventKey: `mail-importance:${canonicalId}` } });
  assert.equal(eventCount, 1, 'project analysis merges into the sender-rule event by canonical identity');
  const mergedEvent = await db.agentEvent.findUniqueOrThrow({ where: { eventKey: `mail-importance:${canonicalId}` } });
  assert.ok(mergedEvent.payloadJson.notificationReasons.includes('active_project_update'));
  assert.equal(mergedEvent.payloadJson.projectNotification, true);
  assert.equal(await service.validateProjectNotification(canonicalId, mergedEvent.payloadJson).then((result) => result.allowed), true, 'active project member sender passes send-time route validation');

  // Even a routine project update (actionable=false) must produce exactly one allowed notification.
  const routineDelivery = await completeWith(events, highEvent.id, { actionable: false }, [send('routine-project-notice')]);
  assert.equal(routineDelivery.notifications.length, 1);
  assert.equal(await db.notificationDelivery.count({ where: { eventId: highEvent.id } }), 1);

  // If the ordinary event completed quietly first, analysis reopens that same event; it never duplicates it.
  const reopenedMail = await createMessage(account.id, member, { at: new Date('2026-08-15T10:00:00Z'), body: 'Germany exhibition floor plan progress update is confirmed.' });
  const reopenedEvent = await makeRealtimeEvent(reopenedMail, { importance: 'normal' });
  await completeWith(events, reopenedEvent.id, { actionable: false });
  assert.equal((await db.agentEvent.findUniqueOrThrow({ where: { id: reopenedEvent.id } })).status, 'completed');
  const reopenedJobId = await db.$transaction((tx) => service.enqueueIncoming(tx, reopenedMail.id));
  await runJob(service, reopenedJobId);
  const reopenedState = await db.agentEvent.findUniqueOrThrow({ where: { id: reopenedEvent.id }, include: { wakeupDelivery: true } });
  assert.equal(reopenedState.status, 'pending', 'a silent completed event reopens when a qualifying active-project route arrives');
  assert.equal(reopenedState.wakeupDelivery.status, 'pending');
  await completeWith(events, reopenedEvent.id, { actionable: false }, [send('reopened-project-notice')]);
  assert.equal(await db.notificationDelivery.count({ where: { eventId: reopenedEvent.id } }), 1);

  const exhaustedMail = await createMessage(account.id, member, { at: new Date('2026-08-15T12:00:00Z'), body: 'Germany exhibition booth preparation is confirmed.' });
  const exhaustedEvent = await makeRealtimeEvent(exhaustedMail, { status: 'failed', importance: 'normal', exhausted: true });
  const exhaustedJobId = await db.$transaction((tx) => service.enqueueIncoming(tx, exhaustedMail.id)); await runJob(service, exhaustedJobId);
  const exhaustedReset = await db.agentEvent.findUniqueOrThrow({ where: { id: exhaustedEvent.id }, include: { wakeupDelivery: true } });
  assert.equal(exhaustedReset.status, 'pending'); assert.equal(exhaustedReset.attempts, 0); assert.equal(exhaustedReset.lastError, null);
  assert.ok(exhaustedReset.nextAttemptAt <= new Date()); assert.equal(exhaustedReset.wakeupDelivery.status, 'pending');
  assert.equal(exhaustedReset.wakeupDelivery.attempts, 0); assert.ok(exhaustedReset.wakeupDelivery.nextAttemptAt <= new Date());
  await completeWith(events, exhaustedEvent.id, { actionable: false }, [send('exhausted-project-route-reopened')]);
  assert.equal(await db.notificationDelivery.count({ where: { eventId: exhaustedEvent.id } }), 1, 'an exhausted but never-delivered event is fully retryable after a qualifying project match');

  // Delivered/uncertain external sends are never woken again when classification later finds a project.
  const deliveredMail = await createMessage(account.id, member, { at: new Date('2026-08-16T10:00:00Z'), body: 'Germany exhibition booth materials update is confirmed.' });
  const deliveredEvent = await makeRealtimeEvent(deliveredMail, { status: 'completed' });
  await db.notificationDelivery.create({ data: { requestKey: 'already-delivered-project-event', requestHash: 'synthetic-hash', eventId: deliveredEvent.id, channel: 'telegram', recipientRef: '123456', content: 'Synthetic prior delivery', status: 'delivered', deliveredAt: new Date() } });
  await db.agentWakeupDelivery.update({ where: { eventId: deliveredEvent.id }, data: { status: 'delivered', deliveredAt: new Date() } });
  const deliveredJobId = await db.$transaction((tx) => service.enqueueIncoming(tx, deliveredMail.id));
  await runJob(service, deliveredJobId);
  const deliveredState = await db.agentEvent.findUniqueOrThrow({ where: { id: deliveredEvent.id }, include: { wakeupDelivery: true, notifications: true } });
  assert.equal(deliveredState.status, 'completed'); assert.equal(deliveredState.wakeupDelivery.status, 'delivered'); assert.equal(deliveredState.notifications.length, 1, 'a previous external delivery is never duplicated');

  // A project that closes before event completion suppresses the project-only route.
  const staleMail = await createMessage(account.id, member, { at: new Date('2026-08-17T10:00:00Z'), body: 'Germany exhibition lighting revision is ready.' });
  const staleEvent = await makeRealtimeEvent(staleMail, { importance: 'normal' });
  const staleJobId = await db.$transaction((tx) => service.enqueueIncoming(tx, staleMail.id));
  await runJob(service, staleJobId);
  const stalePayload = (await db.agentEvent.findUniqueOrThrow({ where: { id: staleEvent.id } })).payloadJson;
  assert.equal(stalePayload.projectNotification, true);
  await db.project.update({ where: { id: germany.id }, data: { status: 'completed', stage: 'completed', version: { increment: 1 } } });
  const staleRoute = await service.validateProjectNotification(canonicalId, mergedEvent.payloadJson);
  assert.equal(staleRoute.allowed, false); assert.equal(staleRoute.hasIndependentReason, false, 'closing the project suppresses only the project notification reason');
  const staleCompletion = await completeWith(events, staleEvent.id, { actionable: false });
  assert.equal(staleCompletion.notifications.length, 0); assert.equal((await db.notificationDelivery.count({ where: { eventId: staleEvent.id } })), 0);
  assert.equal((await db.agentEvent.findUniqueOrThrow({ where: { id: staleEvent.id } })).payloadJson.projectNotification, false);
  await db.emailMessage.update({ where: { id: staleMail.id }, data: { classification: 'NEWSLETTER' } });
  const changedToMachine = await service.validateProjectNotification(staleMail.id, { ...stalePayload, agentActionable: true, notificationReasons: ['actionable_intent'] });
  assert.equal(changedToMachine.allowed, false); assert.equal(changedToMachine.hasIndependentReason, false, 'stale actionable flags cannot bypass a changed deterministic machine classification');
  await db.emailMessage.update({ where: { id: staleMail.id }, data: { classification: 'BLACKLISTED', senderRuleSnapshot: { action: 'blacklist' } } });
  const newlyBlacklisted = await service.validateProjectNotification(staleMail.id, { ...stalePayload, agentActionable: true, notificationReasons: ['actionable_intent'] });
  assert.equal(newlyBlacklisted.allowed, false); assert.equal(newlyBlacklisted.hasIndependentReason, false, 'stale actionable flags cannot bypass a newly applied blacklist');

  // Whitelist and an actionable decision remain independent when the project route goes stale.
  const whitelistProject = await createProject(member, { name: 'Germany Whitelist 2026', description: 'Germany exhibition materials and installation plan.' });
  const whitelistMail = await createMessage(account.id, member, { at: new Date('2026-08-18T10:00:00Z'), body: 'Germany exhibition installation status is updated.', senderRuleSnapshot: { action: 'whitelist' } });
  const whitelistEvent = await makeRealtimeEvent(whitelistMail, { importance: 'normal', projectNotification: false });
  const whitelistJobId = await db.$transaction((tx) => service.enqueueIncoming(tx, whitelistMail.id)); await runJob(service, whitelistJobId);
  await db.project.update({ where: { id: whitelistProject.id }, data: { status: 'completed', stage: 'completed', version: { increment: 1 } } });
  const whitelistCompletion = await completeWith(events, whitelistEvent.id, { actionable: false }, [send('stale-project-whitelist')]);
  assert.equal(whitelistCompletion.notifications.length, 1, 'the independent sender whitelist reason survives a closed project');

  const actionableProject = await createProject(member, { name: 'Germany Actionable 2026', description: 'Germany exhibition quote and delivery plan.' });
  const actionableMail = await createMessage(account.id, member, { at: new Date('2026-08-19T10:00:00Z'), body: 'Germany exhibition delivery timeline needs attention today.', classification: 'BUSINESS_HUMAN' });
  const actionableEvent = await makeRealtimeEvent(actionableMail, { importance: 'high' });
  const actionableJobId = await db.$transaction((tx) => service.enqueueIncoming(tx, actionableMail.id)); await runJob(service, actionableJobId);
  await db.project.update({ where: { id: actionableProject.id }, data: { status: 'completed', stage: 'completed', version: { increment: 1 } } });
  const actionableCompletion = await completeWith(events, actionableEvent.id, { actionable: true }, [send('closed-project-actionable')]);
  assert.equal(actionableCompletion.notifications.length, 1, 'a currently actionable message remains independently notifiable after the project closes');

  await db.systemMailSender.create({ data: { email: 'ops@example.test' } });
  const systemMember = await createContact('systemsender');
  const systemProject = await createProject(systemMember, { name: 'Germany System Notice 2026', description: 'Synthetic project used to verify configured sender suppression.' });
  const systemMail = await createMessage(account.id, systemMember, {
    at: new Date('2026-08-24T10:00:00Z'), from: [{ address: ' OPS@Example.Test ' }],
    cc: [{ address: systemMember.email }], body: 'Germany exhibition booth lighting plan has been approved.',
    classification: 'BUSINESS_HUMAN', classificationManualOverride: true, senderRuleSnapshot: { action: 'whitelist' },
  });
  const systemClassificationsBefore = provider.classificationCalls;
  const systemSummariesBefore = provider.summaryCalls;
  const systemJob = await service.createJob(systemProject.id, { operationId: 'configured-system-project-job', from: '2026-08-24', to: '2026-08-24', limit: 10 });
  assert.equal(systemJob.candidateCount, 1, 'a CC participant can occur in the analysis candidate set');
  await runJob(service, systemJob.jobId);
  const systemItem = await db.projectAnalysisItem.findFirstOrThrow({ where: { jobId: systemJob.jobId, sourceMessageId: systemMail.id } });
  assert.equal(systemItem.outcome, 'skipped_system_sender');
  assert.equal(systemItem.lastErrorCode, 'PROJECT_SYSTEM_SENDER_SUPPRESSED');
  assert.equal(provider.classificationCalls, systemClassificationsBefore, 'configured system mail never reaches project classification');
  assert.equal(provider.summaryCalls, systemSummariesBefore, 'configured system mail is excluded from derived summary input');
  const preservedSystemMail = await db.emailMessage.findUniqueOrThrow({ where: { id: systemMail.id } });
  assert.equal(preservedSystemMail.classification, 'BUSINESS_HUMAN');
  assert.equal(preservedSystemMail.classificationManualOverride, true, 'system gate preserves explicit manual classification facts');

  const lateSystemAddress = 'late-ops@example.test';
  const lateSystemMail = await createMessage(account.id, systemMember, {
    at: new Date('2026-08-25T10:00:00Z'), from: [{ address: lateSystemAddress }], cc: [{ address: systemMember.email }],
    body: 'Germany exhibition floor plan and lighting progress confirmed.',
  });
  const lateSystemJob = await service.createJob(systemProject.id, { operationId: 'system-sender-added-during-model', from: '2026-08-25', to: '2026-08-25', limit: 10 });
  const classificationWait = { started: deferred(), release: deferred() };
  provider.waitOnNextClassification = classificationWait;
  const inFlight = service.processBatch(1);
  await classificationWait.started.promise;
  await db.systemMailSender.create({ data: { email: lateSystemAddress } });
  classificationWait.release.resolve();
  await inFlight;
  const lateSystemItem = await db.projectAnalysisItem.findFirstOrThrow({ where: { jobId: lateSystemJob.jobId, sourceMessageId: lateSystemMail.id } });
  assert.equal(lateSystemItem.outcome, 'skipped_system_sender', 'a system sender added during inference prevents late classification writes');
  assert.equal(lateSystemItem.lastErrorCode, 'PROJECT_SYSTEM_SENDER_SUPPRESSED');
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: lateSystemMail.id } })).projectId, null);

  const afterClaimAddress = 'after-claim-ops@example.test';
  const afterClaimMail = await createMessage(account.id, systemMember, { at: new Date('2026-08-26T10:00:00Z'), from: [{ address: afterClaimAddress }], body: 'Synthetic inbound notice.' });
  const afterClaimEvent = await db.agentEvent.create({ data: {
    eventKey: `mail-importance:${afterClaimMail.id}`, eventType: 'INBOUND_EMAIL_RECEIVED', entityType: 'email_message', entityId: afterClaimMail.id,
    priority: 10, notificationPolicy: 'REALTIME', payloadJson: { classification: 'BUSINESS_HUMAN', importance: 'urgent', notificationRequired: true },
  } });
  const afterClaimDelivery = await db.agentWakeupDelivery.create({ data: { eventId: afterClaimEvent.id } });
  const [afterClaim] = await events.claim('synthetic-agent', 1, 60, afterClaimEvent.id);
  assert.ok(afterClaim, 'an unconfigured sender can be claimed before configuration changes');
  await db.systemMailSender.create({ data: { email: afterClaimAddress } });
  const afterClaimResult = await events.complete(afterClaimEvent.id, {
    agentId: 'synthetic-agent', leaseToken: afterClaim.leaseToken, result: { actionable: true }, notifications: [send('system-added-after-claim')],
  });
  assert.equal(afterClaimResult.suppressed, true, 'the completion transaction rechecks configured senders after the Agent lease');
  assert.equal(afterClaimResult.notifications.length, 0);
  assert.equal((await db.agentEvent.findUniqueOrThrow({ where: { id: afterClaimEvent.id } })).status, 'ignored');
  assert.equal((await db.agentWakeupDelivery.findUniqueOrThrow({ where: { id: afterClaimDelivery.id } })).status, 'failed');
  assert.equal(await db.notificationDelivery.count({ where: { requestKey: 'system-added-after-claim' } }), 0);

  const claimedSystemEvent = await db.agentEvent.create({ data: {
    eventKey: `mail-importance:${systemMail.id}`, eventType: 'INBOUND_EMAIL_RECEIVED', entityType: 'email_message', entityId: systemMail.id,
    priority: 10, notificationPolicy: 'REALTIME', payloadJson: { classification: 'BUSINESS_HUMAN', importance: 'urgent', notificationRequired: true },
  } });
  await db.agentWakeupDelivery.create({ data: { eventId: claimedSystemEvent.id } });
  await db.notificationDelivery.create({ data: { requestKey: 'system-sender-claim-notification', requestHash: 'synthetic-system-sender', eventId: claimedSystemEvent.id, channel: 'telegram', recipientRef: '123456', content: 'Synthetic must stay silent.' } });
  assert.deepEqual(await events.claim('synthetic-agent', 1, 60, claimedSystemEvent.id), [], 'a configured From cannot be claimed even with urgent/whitelist-like payload');
  const ignoredSystemEvent = await db.agentEvent.findUniqueOrThrow({ where: { id: claimedSystemEvent.id }, include: { wakeupDelivery: true, notifications: true } });
  assert.equal(ignoredSystemEvent.status, 'ignored');
  assert.equal(ignoredSystemEvent.wakeupDelivery.status, 'failed');
  assert.equal(ignoredSystemEvent.notifications[0].status, 'failed');

  const systemOutboxEvent = await db.agentEvent.create({ data: {
    eventKey: `system-outbox:${systemMail.id}`, eventType: 'INBOUND_EMAIL_RECEIVED', entityType: 'email_message', entityId: systemMail.id,
    priority: 8, notificationPolicy: 'REALTIME', payloadJson: { classification: 'BUSINESS_HUMAN', notificationRequired: true },
  } });
  await db.agentWakeupDelivery.updateMany({ where: { status: 'pending' }, data: { status: 'failed', lastError: 'synthetic outbox isolation' } });
  await db.agentWakeupDelivery.create({ data: { eventId: systemOutboxEvent.id } });
  await db.notificationDelivery.updateMany({ where: { status: 'pending' }, data: { status: 'failed', lastError: 'synthetic outbox isolation' } });
  const outboxNotification = await db.notificationDelivery.create({ data: { requestKey: 'system-sender-sendtime-notification', requestHash: 'synthetic-system-sender-sendtime', eventId: systemOutboxEvent.id, channel: 'telegram', recipientRef: '123456', content: 'Synthetic outbox must stay silent.' } });
  let externalCalls = 0; const originalFetch = global.fetch;
  global.fetch = async () => { externalCalls++; throw new Error('External delivery is disabled in this isolated test'); };
  try {
    const integrationConfig = { get: (key, fallback) => ({ AGENT_EVENT_WEBHOOK_URL: 'https://synthetic.invalid/webhook', TELEGRAM_BOT_TOKEN: 'synthetic-only', NOTIFICATION_ALLOWED_CHANNELS: 'telegram', NOTIFICATION_ALLOWED_RECIPIENTS: '123456' }[key] ?? fallback) };
    const integrations = new AgentIntegrationService(db, integrationConfig, service, { warn() {}, info() {}, error() {} }, systemMailSenders);
    await integrations.deliverAgentWakeup();
    await integrations.deliverNotificationForChannel('telegram');
  } finally { global.fetch = originalFetch; }
  assert.equal(externalCalls, 0, 'wakeup and notification outboxes never contact an Agent/provider for configured senders');
  const blockedWakeup = await db.agentWakeupDelivery.findUniqueOrThrow({ where: { eventId: systemOutboxEvent.id } });
  assert.equal(blockedWakeup.status, 'failed'); assert.equal(blockedWakeup.lastError, 'SYSTEM_SENDER_SUPPRESSED');
  const blockedNotification = await db.notificationDelivery.findUniqueOrThrow({ where: { id: outboxNotification.id } });
  assert.equal(blockedNotification.status, 'failed'); assert.equal(blockedNotification.lastError, 'SYSTEM_SENDER_SUPPRESSED');

  const deletionMail = await createMessage(account.id, member, { at: new Date('2026-08-27T10:00:00Z'), body: 'USA exhibition booth schedule: final delivery inspection is confirmed.' });
  const deletionJob = await service.createJob(usa.id, { operationId: 'source-deletion-summary-coverage', from: '2026-08-27', to: '2026-08-27', limit: 10 });
  await runJob(service, deletionJob.jobId);
  const manualOnlyMail = await createMessage(account.id, member, { at: new Date('2026-08-28T10:00:00Z'), body: 'USA exhibition equipment was manually linked and retained for the project summary.', historicalImport: true });
  const manualOnlyRow = await db.emailMessage.findUniqueOrThrow({ where: { id: manualOnlyMail.id } });
  await service.manuallyAssign(manualOnlyMail.id, { operationId: 'manual-only-source-assignment', expectedVersion: manualOnlyRow.projectAssignmentVersion, projectId: usa.id });
  const refreshMail = await createMessage(account.id, member, { at: new Date('2026-08-29T10:00:00Z'), body: 'USA exhibition final shipping inspection is confirmed.', historicalImport: true });
  const refreshJob = await service.createJob(usa.id, { operationId: 'summary-includes-manual-only-source', from: '2026-08-29', to: '2026-08-29', limit: 10 });
  await runJob(service, refreshJob.jobId);
  assert.equal(await db.projectAnalysisItem.count({ where: { sourceMessageId: manualOnlyMail.id } }), 0, 'the manually assigned source never entered an analysis item');
  const summaryBeforeDeletion = await db.summary.findUniqueOrThrow({ where: { entityType_entityId: { entityType: 'project', entityId: usa.id } }, include: { versions: true } });
  assert.ok(summaryBeforeDeletion.coverageJson.sourceMessageIds.includes(deletionMail.id));
  assert.ok(summaryBeforeDeletion.coverageJson.sourceMessageIds.includes(manualOnlyMail.id), 'summary input includes manual assignment sources without per-message AI jobs');
  assert.ok(summaryBeforeDeletion.coverageJson.claims.some((claim) => claim.evidence.some((evidence) => evidence.sourceMessageId === deletionMail.id)));
  assert.ok(summaryBeforeDeletion.coverageJson.claims.some((claim) => claim.evidence.some((evidence) => evidence.sourceMessageId === manualOnlyMail.id)));
  const deletionAnalysisItem = await db.projectAnalysisItem.findFirstOrThrow({ where: { jobId: deletionJob.jobId, sourceMessageId: deletionMail.id } });
  const deletionReview = await db.reviewItem.findUniqueOrThrow({ where: { id: opportunityReview.id } });
  const cleanup = new MailDeletionCleanupService(db, service);
  const firstRemoteUids = new Set((await db.emailMessage.findMany({ where: { mailAccountId: account.id, mailbox: 'INBOX', uidValidity: 1n, id: { not: manualOnlyMail.id } }, select: { uid: true } })).map((message) => message.uid));
  assert.equal(await cleanup.deleteMissing(account.id, 'INBOX', 1n, firstRemoteUids, sequence), 1, 'first deletion snapshot removes only the manually assigned summary source');
  const afterManualSourceDeletion = await db.summary.findUniqueOrThrow({ where: { id: summaryBeforeDeletion.id } });
  assert.equal(afterManualSourceDeletion.coverageJson.stale, true, 'a manually assigned source with no analysis item still invalidates its project summary');
  assert.ok(!afterManualSourceDeletion.coverageJson.sourceMessageIds.includes(manualOnlyMail.id));
  assert.ok(afterManualSourceDeletion.coverageJson.claims.every((claim) => claim.evidence.every((evidence) => evidence.sourceMessageId !== manualOnlyMail.id)), 'manual-only source evidence is scrubbed before any analyzed source is deleted');
  const secondRemoteUids = new Set((await db.emailMessage.findMany({ where: { mailAccountId: account.id, mailbox: 'INBOX', uidValidity: 1n, id: { notIn: [deletionMail.id, newOpportunity.id] } }, select: { uid: true } })).map((message) => message.uid));
  assert.equal(await cleanup.deleteMissing(account.id, 'INBOX', 1n, secondRemoteUids, sequence), 2, 'second deletion snapshot removes the AI source and analysis review source');
  const deletedAnalysisItem = await db.projectAnalysisItem.findUniqueOrThrow({ where: { id: deletionAnalysisItem.id } });
  assert.equal(deletedAnalysisItem.sourceMessageId, null); assert.ok(deletedAnalysisItem.sourceDeletedAt); assert.deepEqual(deletedAnalysisItem.evidenceJson, []);
  const deletedReview = await db.reviewItem.findUniqueOrThrow({ where: { id: deletionReview.id } });
  assert.equal(deletedReview.sourceMessageId, null); assert.ok(deletedReview.sourceDeletedAt); assert.deepEqual(deletedReview.proposedChangeJson.evidence, []);
  assert.equal(deletedReview.status, 'ignored'); assert.equal(deletedReview.resolutionJson.reasonCode, 'SOURCE_EMAIL_DELETED', 'deleted-source review closes while preserving its audit record');
  assert.equal(await db.emailMessage.count({ where: { id: manualOnlyMail.id } }), 0);
  const scrubbedSummary = await db.summary.findUniqueOrThrow({ where: { id: summaryBeforeDeletion.id }, include: { versions: true } });
  assert.equal(scrubbedSummary.coverageJson.stale, true);
  assert.ok(!scrubbedSummary.coverageJson.sourceMessageIds.includes(deletionMail.id));
  assert.ok(!scrubbedSummary.coverageJson.sourceMessageIds.includes(manualOnlyMail.id));
  assert.ok(scrubbedSummary.coverageJson.claims.every((claim) => claim.evidence.every((evidence) => evidence.sourceMessageId !== deletionMail.id)), 'summary coverage removes claims that cite deleted source content');
  assert.ok(scrubbedSummary.coverageJson.claims.every((claim) => claim.evidence.every((evidence) => evidence.sourceMessageId !== manualOnlyMail.id)), 'summary coverage scrubs a manually assigned source that had no analysis item');
  assert.ok(scrubbedSummary.versions.some((version) => version.sourceDeletedAt && version.triggerMessageId === null));

  const summariesBeforeDelete = await db.summary.findUnique({ where: { entityType_entityId: { entityType: 'project', entityId: germany.id } } });
  assert.ok(summariesBeforeDelete, 'project derived summary exists before source deletion check');
  const syntheticEvidence = validateProjectAssignmentEvidence({ schema_version: '1', outcome: 'assigned', project_id: germany.id, project_ids: [germany.id], confidence: 0.95, evidence: [{ source_message_id: incoming.id, excerpt: 'Germany exhibition booth progress update' }], reason: 'synthetic' }, { currentMessageId: incoming.id, candidateProjectIds: [germany.id], messageTextById: new Map([[incoming.id, incoming.bodyText]]) });
  assert.deepEqual(syntheticEvidence, []);

  const jobCount = await db.projectAnalysisJob.count();
  console.log(JSON.stringify({
    isolatedDatabase: dbName, syntheticOnly: true, jobs: jobCount, cases: ['logical-copy-dedupe', 'history-over-30-claim-reduction', 'summary-evidence-coverage', 'stable-idempotency-cache', 'mixed-holiday-content', 'year-and-project-comparison', 'multi-project-review', 'manual-review-resolution', 'machine-blacklist-gates', 'invalid-calendar-date', 'all-participant-address-fields', 'company-membership-consistency', 'stale-context-rejection', 'retry-no-double-count', 'summary-only-retry', 'human-summary-protection-and-adoption', 'cancel-inflight', 'cancel-expired-lease-recovery', 'no-summary-before-item-retry', 'incoming-event-copy-dedupe', 'routine-project-notification-actionable-false', 'quiet-event-reopens-on-project-match', 'exhausted-event-reopens-and-is-claimable', 'delivered-event-never-reopens', 'closed-project-only-notification-suppressed', 'closed-project-whitelist-preserved', 'closed-project-actionable-notification-preserved', 'system-sender-sync-gate', 'system-sender-project-classification-summary-gate', 'system-sender-classification-postcheck', 'system-sender-agent-claim-gate', 'system-sender-agent-complete-postcheck', 'system-sender-wakeup-sendtime-gate', 'system-sender-notification-sendtime-gate', 'deleted-source-analysis-review-and-summary-scrub'],
    providerCalls: provider.calls, classificationCalls: provider.classificationCalls, summaryCalls: provider.summaryCalls, reducerCalls: provider.reducerCalls,
  }));
}

main().catch((error) => { console.error(JSON.stringify({ testFailure: safeError(error), stack: safeStack(error), code: error?.code ?? null, status: error?.status ?? null })); process.exitCode = 1; }).finally(async () => {
  if (db) await db.$disconnect().catch(() => {});
  if (created) {
    try {
      await admin.$queryRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`);
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    } catch (error) { console.error(JSON.stringify({ cleanupFailure: safeError(error), code: error?.code ?? null })); process.exitCode = 1; }
  }
  await admin.$disconnect().catch(() => {});
});
