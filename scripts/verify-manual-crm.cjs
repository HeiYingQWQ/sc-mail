/* Isolated PostgreSQL regression coverage for user-managed CRM and project data. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { ContactResolverService } = require('../dist/modules/mail/contact-resolver.service.js');
const { ProjectReviewService } = require('../dist/modules/mail/project-review.service.js');
const { BusinessBriefService } = require('../dist/modules/mail/business-brief.service.js');

const adminUrl = process.env.DATABASE_URL;
assert.ok(adminUrl, 'Set DATABASE_URL to a disposable local/test PostgreSQL server');
const sourceUrl = new URL(adminUrl);
assert.ok(['localhost', '127.0.0.1', '::1', 'postgres'].includes(sourceUrl.hostname),
  'Manual CRM acceptance only permits a local PostgreSQL host; production and remote database hosts are refused');
assert.equal(process.env.MANUAL_CRM_ALLOW_LOCAL_DB_CREATE, '1',
  'Set MANUAL_CRM_ALLOW_LOCAL_DB_CREATE=1 to authorize creation and removal of a uniquely named isolated local database');
assert.doesNotMatch(sourceUrl.pathname.toLowerCase(), /prod(?:uction)?/, 'Production-named databases are refused');
const dbName = `aimail_manual_crm_${Date.now()}_${process.pid}`;
assert.match(dbName, /^aimail_manual_crm_\d+_\d+$/);
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
const admin = new PrismaClient({ datasourceUrl: adminUrl });
const settings = { IMAP_EMAIL: 'crm-owner@test.invalid', IMAP_HOST: 'imap.test.invalid', BUSINESS_TIMEZONE: 'Europe/Rome' };
const config = { get: (key, fallback) => settings[key] === undefined ? fallback : settings[key] };
let db;
let created = false;
let sequence = 0;

function responseCode(error) { return error?.response?.code ?? error?.code; }
async function rejects(promise, status, code) {
  await assert.rejects(promise, error => error.status === status && (!code || responseCode(error) === code),
    `expected status ${status}${code ? ` / ${code}` : ''}`);
}

function messageData(accountId, options = {}) {
  const n = ++sequence;
  const at = options.at ?? new Date('2026-06-01T10:00:00.000Z');
  return {
    mailAccountId: accountId, mailbox: options.mailbox ?? 'INBOX', uidValidity: 1n, uid: n,
    providerMessageId: `manual-crm-${n}`, rfcMessageId: options.rfcMessageId ?? `<manual-${n}@test.invalid>`,
    direction: options.direction ?? 'inbound',
    fromJson: options.from ?? [{ name: 'Sender', address: 'owner@test.invalid' }],
    toJson: options.to ?? [], ccJson: options.cc ?? [], bccJson: options.bcc ?? [],
    subject: options.subject ?? 'Synthetic CRM email', bodyText: options.body ?? 'Synthetic evidence for CRM history.',
    headersJson: {}, rawSource: Buffer.from('synthetic raw email'), receivedAt: options.direction === 'outbound' ? null : at,
    sentAt: options.direction === 'outbound' ? at : null,
    classification: 'BUSINESS_HUMAN', reviewRequired: false,
    contactId: options.contactId ?? null, companyId: options.companyId ?? null,
    contactResolutionStatus: options.contactId ? 'matched' : 'unresolved',
    projectId: options.projectId ?? null, projectResolutionStatus: options.projectId ? 'manual' : 'unresolved',
    projectManualOverride: Boolean(options.projectId), projectAssignmentVersion: options.projectAssignmentVersion ?? 1,
    ...(options.topicId ? { topicId: options.topicId, topicResolutionStatus: 'manual', topicManualOverride: true } : {}),
  };
}

async function seedPureAutomaticContact(displayName, emails) {
  const contact = await db.contact.create({ data: {
    displayName, status: 'provisional', confidence: 0.25,
    provisionalReason: `Unmapped inbound human sender: ${emails[0]}`,
    emails: { create: emails.map(email => ({ email, verified: false, isPrimary: email === emails[0] })) },
  } });
  await db.$executeRaw`UPDATE "Contact" SET "updatedAt"="createdAt" WHERE "id"=${contact.id}`;
  return contact;
}

async function addProvisionalReview(contact, suffix) {
  return db.reviewItem.create({ data: {
    entityType: 'contact', entityId: contact.id, reasonCode: 'CONTACT_PROVISIONAL', confidence: 0,
    dedupeKeyBase: `auto-email-${contact.id}-${suffix}`, dedupeKey: `auto-email-${contact.id}-${suffix}:1`,
  } });
}

async function main() {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  created = true;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl.toString() }, stdio: 'pipe',
  });
  db = new PrismaClient({ datasourceUrl: testUrl.toString() });
  const account = await db.mailAccount.create({ data: {
    email: settings.IMAP_EMAIL, host: settings.IMAP_HOST, port: 993, tlsMode: 'implicit',
    username: settings.IMAP_EMAIL, passwordCiphertext: 'synthetic-test-value',
  } });
  const invalidator = {
    async invalidateProjectSummaries(tx, projectIds, reason) {
      for (const projectId of [...new Set(projectIds.filter(Boolean))]) {
        const summary = await tx.summary.findUnique({ where: { entityType_entityId: { entityType: 'project', entityId: projectId } } });
        if (summary) {
          const coverage = summary.coverageJson && typeof summary.coverageJson === 'object' && !Array.isArray(summary.coverageJson)
            ? summary.coverageJson : {};
          await tx.summary.update({ where: { id: summary.id }, data: { inputHash: null, coverageJson: { ...coverage, stale: true, staleReason: reason } } });
        }
        await tx.timelineEvent.create({ data: { projectId, eventType: 'SUMMARY_STALE', title: 'Project summary needs refresh', metadataJson: { reason } } });
      }
    },
  };
  const contacts = new ContactResolverService(config, db, invalidator);
  const projects = new ProjectReviewService(config, db, invalidator);
  const brief = new BusinessBriefService(db, config);

  const companySeedA = await contacts.createContact({ email: 'company-seed-a@customer.test', displayName: 'Company Seed A', operationId: 'company-seed-a' });
  const companySeedB = await contacts.createContact({ email: 'company-seed-b@customer.test', displayName: 'Company Seed B', operationId: 'company-seed-b' });
  const companyA = await contacts.createCompany({ name: 'Manual CRM A', domain: 'customer.test', website: 'https://customer.test/', address: '1 Synthetic Way', notes: 'Manual company note', contactIds: [companySeedA.id], operationId: 'crm-company-a' });
  const companyB = await contacts.createCompany({ name: 'Manual CRM B', contactIds: [companySeedB.id], operationId: 'crm-company-b' });
  assert.equal(companyA.website, 'https://customer.test/');
  assert.equal(companyA.version, 1);
  assert.equal((await contacts.getCompany(companyA.id)).company.notes, 'Manual company note');
  await rejects(contacts.updateCompany(companyA.id, { expectedVersion: 1, operationId: 'bad-website', website: 'ftp://customer.test' }), 400);
  await rejects(contacts.createCompany({ name: 'Empty company', operationId: 'empty-company' }), 400);
  await rejects(contacts.updateCompany(companyA.id, { contactIds: [], expectedVersion: 1, operationId: 'empty-company-members' }), 400);

  const contact = await contacts.createContact({
    emails: ['client@customer.test', 'alt@customer.test'], primaryEmail: 'client@customer.test',
    displayName: 'Client Person', companyId: companyA.id, notes: 'Manual contact note', actorId: 'acceptance', operationId: 'crm-contact-a',
  });
  assert.equal(contact.status, 'confirmed');
  assert.equal(contact.emails.length, 2);
  assert.equal(contact.emails.filter(row => row.isPrimary).length, 1);
  assert.equal(contact.notes, 'Manual contact note');
  await rejects(contacts.createContact({ email: 'ALT@customer.test', displayName: 'Duplicate', operationId: 'crm-email-conflict' }), 409, 'EMAIL_CONTACT_CONFLICT');
  const details = await contacts.getContact(contact.id);
  assert.equal(details.version, contact.version);
  assert.equal(details.contact.emails.find(row => row.isPrimary).email, 'client@customer.test');
  assert.equal((await contacts.listContacts(100, 0, 'alt@customer.test', companyA.id)).total, 1);
  const companyBContacts = await contacts.listContacts(100, 0, undefined, companyB.id);
  assert.deepEqual(companyBContacts.contacts.map(row => row.id), [companySeedB.id], 'company filter returns its selected member and excludes contacts from other companies');
  assert.equal((await contacts.listContacts(100, 0, 'alt@customer.test', companyB.id)).total, 0, 'company and search filters compose without leaking another company contact');
  await rejects(contacts.listContacts(10, 0, undefined, 'missing-company'), 404);
  const chineseContact = await contacts.createContact({ email: 'chinese@test.invalid', displayName: '客户代表', companyId: companyB.id, operationId: 'crm-contact-chinese' });
  assert.equal((await contacts.listContacts(10, 0, '客', companyB.id)).total, 1, 'single-character Chinese picker searches are supported');

  const secondContact = await contacts.createContact({ email: 'second@customer.test', displayName: 'Second Person', companyId: companyA.id, operationId: 'crm-contact-second' });
  const project = await projects.createProject({
    name: 'Manual project', companyId: companyA.id, description: 'Preserved project details',
    contactIds: [contact.id], primaryContactId: contact.id, operationId: 'crm-project-a',
  });
  const secondProject = await projects.createProject({
    name: 'Parallel project', companyId: companyA.id, contactIds: [contact.id, secondContact.id],
    primaryContactId: secondContact.id, status: 'completed', stage: 'completed', operationId: 'crm-project-b',
  });
  assert.equal(project.projectContacts[0].contactId, contact.id);
  assert.equal(project.projectContacts[0].isPrimary, true);
  assert.equal((await projects.getProject(project.id)).description, 'Preserved project details');
  assert.equal((await projects.getProject(project.id)).projectContacts.length, 1);
  assert.equal((await projects.getProject(secondProject.id)).status, 'completed');
  assert.equal((await db.projectContact.count({ where: { contactId: contact.id } })), 2, 'one contact may belong to multiple projects');
  await rejects(contacts.updateContact(contact.id, { companyId: companyB.id, expectedVersion: contact.version, operationId: 'move-member-contact' }), 409, 'PROJECT_CONTACT_COMPANY_CONFLICT');
  const currentCompanyA = await db.company.findUniqueOrThrow({ where: { id: companyA.id } });
  await rejects(contacts.updateCompany(companyA.id, { contactIds: [secondContact.id], expectedVersion: currentCompanyA.version, operationId: 'remove-project-contact' }), 409, 'PROJECT_CONTACT_COMPANY_CONFLICT');

  await rejects(projects.updateProject(project.id, { status: 'completed', expectedVersion: project.version, operationId: 'inconsistent-project-status' }), 400, 'PROJECT_STATUS_STAGE_MISMATCH');
  const completed = await projects.updateProject(project.id, { status: 'completed', stage: 'completed', expectedVersion: project.version, operationId: 'complete-project' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.stage, 'completed');
  await rejects(projects.updateProject(project.id, { status: 'active', expectedVersion: completed.version, operationId: 'silent-reopen' }), 400, 'PROJECT_STATUS_STAGE_MISMATCH');
  const reopened = await projects.updateProject(project.id, { status: 'active', stage: 'planning', expectedVersion: completed.version, operationId: 'explicit-reopen' });
  assert.equal(reopened.status, 'active');
  assert.equal(reopened.stage, 'planning');
  await rejects(projects.updateProject(project.id, { description: 'stale', expectedVersion: 1, operationId: 'stale-project-version' }), 409, 'VERSION_CONFLICT');
  assert.equal((await projects.updateProject(project.id, { description: 'Patched notes', expectedVersion: reopened.version, operationId: 'update-project-notes' })).description, 'Patched notes');

  const mail1 = await db.emailMessage.create({ data: messageData(account.id, {
    rfcMessageId: '<Case-Sensitive@test.invalid>', contactId: contact.id, companyId: companyA.id, projectId: project.id,
    from: [{ address: 'client@customer.test' }], cc: [{ address: 'alt@customer.test' }], bcc: [{ address: 'alt@customer.test' }],
  }) });
  await db.emailMessage.create({ data: messageData(account.id, {
    mailbox: 'Archive', rfcMessageId: '<Case-Sensitive@test.invalid>', contactId: contact.id, companyId: companyA.id, projectId: project.id,
    from: [{ address: 'client@customer.test' }], cc: [{ address: 'alt@customer.test' }], bcc: [{ address: 'alt@customer.test' }],
  }) });
  const mail2 = await db.emailMessage.create({ data: messageData(account.id, {
    mailbox: 'Sent', direction: 'outbound', at: new Date('2026-06-02T10:00:00.000Z'), rfcMessageId: '<case-sensitive@test.invalid>',
    contactId: contact.id, companyId: companyA.id, projectId: project.id,
    from: [{ address: 'owner@test.invalid' }], to: [{ address: 'client@customer.test' }], cc: [{ address: 'alt@customer.test' }],
  }) });
  const contactHistory = await brief.contactMessages(contact.id, 20, 0, false);
  assert.equal(contactHistory.contact.id, contact.id);
  assert.equal(contactHistory.total, 2, 'same RFC Message-ID copies fold, but case-distinct IDs remain separate');
  assert.equal(contactHistory.messages.length, 2);
  const inboundHistory = contactHistory.messages.find(row => row.id === mail1.id);
  assert.deepEqual(new Set(inboundHistory.participantRoles), new Set(['from', 'cc', 'bcc']));
  assert.deepEqual(new Set(inboundHistory.matchedEmails), new Set(['client@customer.test', 'alt@customer.test']));
  assert.equal(inboundHistory.projectAssignmentVersion, 1);
  assert.equal(inboundHistory.projectManualOverride, true);
  assert.equal((await brief.contactMessages(contact.id, 20, 0, false, { direction: 'outbound' })).total, 1);
  assert.equal((await brief.contactMessages(contact.id, 20, 0, false, { projectId: secondProject.id })).total, 0);
  assert.equal((await brief.contactMessages(contact.id, 20, 0, false, { fromDate: '2026-06-02', throughDate: '2026-06-02' })).total, 1);
  assert.equal((await brief.contactMessages(contact.id, 1, 0, false)).hasMore, true);
  const projectHistory = await brief.projectMessages(project.id, 20, 0, { contactId: contact.id });
  assert.equal(projectHistory.project.status, 'active');
  assert.equal(projectHistory.total, 2);
  assert.equal(projectHistory.messages.some(row => row.id === mail2.id), true);
  await rejects(brief.projectMessages(project.id, 20, 0, { contactId: 'not-a-member' }), 400);

  const unknownBefore = await db.contact.count();
  const unknown = await db.emailMessage.create({ data: messageData(account.id, { from: [{ address: 'stranger@customer.test' }] }) });
  const resolverResult = await contacts.resolveImported([unknown.id]);
  assert.equal(resolverResult.createdContacts, 0);
  const unresolved = await db.emailMessage.findUniqueOrThrow({ where: { id: unknown.id } });
  assert.equal(unresolved.contactId, null);
  assert.equal(unresolved.companyId, null, 'known sender domain does not capture an unknown person');
  assert.equal(await db.contact.count(), unknownBefore);

  const unassigned = await db.emailMessage.create({ data: messageData(account.id, { subject: 'Manual project exact subject' }) });
  await projects.resolveImported([unassigned.id]);
  const stillUnassigned = await db.emailMessage.findUniqueOrThrow({ where: { id: unassigned.id } });
  assert.equal(stillUnassigned.projectId, null, 'subject and thread hints cannot assign a project during recovery');
  assert.equal(await db.reviewItem.count({ where: { sourceMessageId: unassigned.id, reasonCode: { startsWith: 'PROJECT_' } } }), 0);

  const seedMoveA = await contacts.createContact({ email: 'seed-a@race.test', displayName: 'Seed A', operationId: 'seed-move-a' });
  const seedMoveB = await contacts.createContact({ email: 'seed-b@race.test', displayName: 'Seed B', operationId: 'seed-move-b' });
  const moveA = await contacts.createCompany({ name: 'Concurrent company A', contactIds: [seedMoveA.id], operationId: 'concurrency-company-a' });
  const moveB = await contacts.createCompany({ name: 'Concurrent company B', contactIds: [seedMoveB.id], operationId: 'concurrency-company-b' });
  const unassignedContact = await contacts.createContact({ email: 'move-me@test.invalid', displayName: 'Move Me', operationId: 'concurrency-contact' });
  const competing = await Promise.allSettled([
    contacts.updateCompany(moveA.id, { contactIds: [unassignedContact.id], expectedVersion: moveA.version, operationId: 'competing-company-a' }),
    contacts.updateCompany(moveB.id, { contactIds: [unassignedContact.id], expectedVersion: moveB.version, operationId: 'competing-company-b' }),
  ]);
  assert.equal(competing.filter(item => item.status === 'fulfilled').length, 1, 'two company editors cannot silently take the same contact');
  const winnerCompany = await db.contact.findUniqueOrThrow({ where: { id: unassignedContact.id }, select: { companyId: true, version: true } });
  assert.ok([moveA.id, moveB.id].includes(winnerCompany.companyId));
  await rejects(contacts.updateContact(unassignedContact.id, { companyId: winnerCompany.companyId === moveA.id ? moveB.id : moveA.id, expectedVersion: unassignedContact.version, operationId: 'stale-contact-move' }), 409, 'VERSION_CONFLICT');

  const anchorSeed = await contacts.createContact({ email: 'anchor@race.test', displayName: 'Anchor', operationId: 'race-anchor' });
  const raceCompany = await contacts.createCompany({ name: 'Company vs project race', contactIds: [anchorSeed.id], operationId: 'race-company' });
  const anchor = anchorSeed;
  const movable = await contacts.createContact({ email: 'movable@race.test', displayName: 'Movable', companyId: raceCompany.id, operationId: 'race-movable' });
  const raceProject = await projects.createProject({ name: 'Company-project race', companyId: raceCompany.id, contactIds: [anchor.id], operationId: 'race-project' });
  const currentRaceCompany = await db.company.findUniqueOrThrow({ where: { id: raceCompany.id } });
  const race = await Promise.allSettled([
    contacts.updateCompany(raceCompany.id, { contactIds: [anchor.id], expectedVersion: currentRaceCompany.version, operationId: 'race-company-remove' }),
    projects.updateProject(raceProject.id, { contactIds: [anchor.id, movable.id], expectedVersion: raceProject.version, operationId: 'race-project-add' }),
  ]);
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1, 'contact removal and project-member insertion serialize on real database locks');
  const raceResult = await db.contact.findUniqueOrThrow({ where: { id: movable.id }, select: { companyId: true } });
  const raceMember = await db.projectContact.findUnique({ where: { projectId_contactId: { projectId: raceProject.id, contactId: movable.id } } });
  assert.equal(Boolean(raceMember), raceResult.companyId === raceCompany.id);

  const oldSummary = await db.summary.create({ data: { entityType: 'project', entityId: project.id, version: 1, currentVersionId: null, isDerived: false, manualOverride: true, inputHash: 'manual-summary-input', coverageJson: { source: 'manual' } } });
  const oldSummaryVersion = await db.summaryVersion.create({ data: { summaryId: oldSummary.id, version: 1, newSummary: 'Human-authored project summary', model: 'manual' } });
  await db.summary.update({ where: { id: oldSummary.id }, data: { currentVersionId: oldSummaryVersion.id } });
  const targetSummary = await db.summary.create({ data: { entityType: 'project', entityId: secondProject.id, version: 1, currentVersionId: null, isDerived: false, manualOverride: true, inputHash: 'target-input', coverageJson: { source: 'manual-target' } } });
  const currentContact = await db.contact.findUniqueOrThrow({ where: { id: contact.id } });
  await contacts.updateContact(contact.id, { notes: 'Updated contact context', expectedVersion: currentContact.version, operationId: 'stale-contact-context' });
  assert.equal((await db.summary.findUniqueOrThrow({ where: { id: oldSummary.id } })).coverageJson.stale, true, 'editing a project member invalidates its project summary');
  assert.equal((await db.summary.findUniqueOrThrow({ where: { id: targetSummary.id } })).coverageJson.stale, true, 'one contact may invalidate each project where it is a member');
  const currentCompanyForStale = await db.company.findUniqueOrThrow({ where: { id: companyA.id } });
  await contacts.updateCompany(companyA.id, { notes: 'Updated company context', expectedVersion: currentCompanyForStale.version, operationId: 'stale-company-context' });
  assert.equal((await db.summary.findUniqueOrThrow({ where: { id: oldSummary.id } })).coverageJson.stale, true, 'editing company context marks its project summaries stale');
  assert.equal((await db.summary.findUniqueOrThrow({ where: { id: targetSummary.id } })).coverageJson.stale, true);
  const assignmentData = messageData(account.id, { companyId: companyA.id, projectId: project.id, rfcMessageId: '<manual-copy-case@test.invalid>', subject: 'Manual reassignment source', projectAssignmentVersion: 4 });
  assignmentData.projectManualOverride = false;
  assignmentData.projectResolutionStatus = 'matched';
  const assignmentMessage = await db.emailMessage.create({ data: assignmentData });
  const assignmentCopyData = messageData(account.id, {
    mailbox: 'Archive', rfcMessageId: assignmentData.rfcMessageId, companyId: companyA.id, projectId: project.id,
    subject: 'Manual reassignment source copy', projectAssignmentVersion: 9,
  });
  assignmentCopyData.projectManualOverride = false;
  assignmentCopyData.projectResolutionStatus = 'matched';
  const assignmentCopy = await db.emailMessage.create({ data: assignmentCopyData });
  const siblingProjectReview = await db.reviewItem.create({ data: { entityType: 'email_message', entityId: assignmentCopy.id, sourceMessageId: assignmentCopy.id, reasonCode: 'PROJECT_ANALYSIS_UNCERTAIN', confidence: 0, dedupeKeyBase: `manual-copy-review-${assignmentCopy.id}`, dedupeKey: `manual-copy-review-${assignmentCopy.id}:1` } });
  const review = await db.reviewItem.create({ data: { entityType: 'email_message', entityId: assignmentMessage.id, sourceMessageId: assignmentMessage.id, reasonCode: 'PROJECT_UNRESOLVED', confidence: 0, dedupeKeyBase: `manual-review-${assignmentMessage.id}`, dedupeKey: `manual-review-${assignmentMessage.id}:1` } });
  const resolvedReview = await projects.resolveReview(review.id, { action: 'assign_project', projectId: secondProject.id, operationId: 'manual-review-assignment', actorId: 'operator' });
  const assigned = await db.emailMessage.findUniqueOrThrow({ where: { id: assignmentMessage.id } });
  const assignedCopy = await db.emailMessage.findUniqueOrThrow({ where: { id: assignmentCopy.id } });
  assert.equal(assigned.projectId, secondProject.id);
  assert.equal(assignedCopy.projectId, secondProject.id, 'review assignment synchronizes same-account exact-RFC copies');
  assert.equal(assigned.companyId, companyA.id);
  assert.equal(assigned.projectManualOverride, true);
  assert.equal(assigned.projectAssignmentVersion, 5);
  assert.equal(assignedCopy.projectAssignmentVersion, 10, 'each synchronized copy advances its own assignment version');
  assert.equal(assigned.projectResolutionEvidence.reviewId, review.id);
  assert.equal(assigned.projectResolutionEvidence.operationId, 'manual-review-assignment');
  assert.equal(resolvedReview.resolutionJson.copyAssignments.length, 2, 'review audit records every synchronized copy and version');
  assert.equal((await db.reviewItem.findUniqueOrThrow({ where: { id: siblingProjectReview.id } })).status, 'resolved', 'manual review closes sibling project analysis reviews');
  const invalidated = await db.summary.findUniqueOrThrow({ where: { id: oldSummary.id } });
  const invalidatedTarget = await db.summary.findUniqueOrThrow({ where: { id: targetSummary.id } });
  assert.equal(invalidated.currentVersionId, oldSummaryVersion.id);
  assert.equal(invalidated.manualOverride, true);
  assert.equal((await db.summaryVersion.findUniqueOrThrow({ where: { id: oldSummaryVersion.id } })).newSummary, 'Human-authored project summary');
  assert.equal(invalidated.coverageJson.stale, true);
  assert.equal(invalidatedTarget.coverageJson.stale, true);

  const conflictRfc = '<manual-copy-conflict@test.invalid>';
  const conflictSource = await db.emailMessage.create({ data: messageData(account.id, { rfcMessageId: conflictRfc, projectId: null, subject: 'Conflicting manual copy' }) });
  const manuallyLockedCopy = await db.emailMessage.create({ data: messageData(account.id, { mailbox: 'Archive', rfcMessageId: conflictRfc, companyId: companyA.id, projectId: project.id, projectAssignmentVersion: 6, subject: 'Conflicting manual copy archive' }) });
  const conflictingReview = await db.reviewItem.create({ data: { entityType: 'email_message', entityId: conflictSource.id, sourceMessageId: conflictSource.id, reasonCode: 'PROJECT_ANALYSIS_MULTI_PROJECT', confidence: 0, dedupeKeyBase: `manual-copy-conflict-${conflictSource.id}`, dedupeKey: `manual-copy-conflict-${conflictSource.id}:1` } });
  await rejects(projects.resolveReview(conflictingReview.id, { action: 'assign_project', projectId: secondProject.id, operationId: 'manual-copy-conflict-assignment' }), 409, 'RFC_COPY_MANUAL_ASSIGNMENT_CONFLICT');
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: conflictSource.id } })).projectId, null);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: manuallyLockedCopy.id } })).projectId, project.id);
  assert.equal((await db.reviewItem.findUniqueOrThrow({ where: { id: conflictingReview.id } })).status, 'pending', 'conflicting duplicate-group review remains open for explicit resolution');

  const createReview = await db.reviewItem.create({ data: { entityType: 'email_message', entityId: unassigned.id, sourceMessageId: unassigned.id, reasonCode: 'PROJECT_UNRESOLVED', confidence: 0, dedupeKeyBase: `new-project-review-${unassigned.id}`, dedupeKey: `new-project-review-${unassigned.id}:1` } });
  await rejects(projects.resolveReview(createReview.id, { action: 'create_project', projectName: 'Bypass attempt', operationId: 'review-create-without-company' }), 400);
  assert.equal(await db.project.count({ where: { name: 'Bypass attempt' } }), 0);
  await rejects(projects.resolveReview(createReview.id, { action: 'create_project', projectName: 'No members', companyId: companyA.id, contactIds: [], operationId: 'review-create-no-members' }), 400);
  await rejects(projects.resolveReview(createReview.id, { action: 'confirm_contact', operationId: 'obsolete-confirm-contact' }), 400);

  const sourceMember = await contacts.createContact({ email: 'source-member@customer.test', displayName: 'Source Member', companyId: companyA.id, operationId: 'merge-source-contact' });
  const mergeProject = await projects.createProject({ name: 'Merge membership protection', companyId: companyA.id, contactIds: [sourceMember.id], operationId: 'merge-membership-project' });
  const targetContact = await contacts.createContact({ email: 'merge-target@customer.test', displayName: 'Merge Target', companyId: companyA.id, operationId: 'merge-target-contact' });
  const mergeReview = await db.reviewItem.create({ data: { entityType: 'contact', entityId: sourceMember.id, reasonCode: 'CONTACT_PROVISIONAL', confidence: 0, dedupeKeyBase: `merge-member-${sourceMember.id}`, dedupeKey: `merge-member-${sourceMember.id}:1` } });
  await rejects(projects.resolveReview(mergeReview.id, { action: 'merge_contact', targetContactId: targetContact.id, operationId: 'merge-member-rejected' }), 409, 'CONTACT_HAS_PROJECT_MEMBERSHIPS');
  assert.equal((await db.projectContact.findUnique({ where: { projectId_contactId: { projectId: mergeProject.id, contactId: sourceMember.id } } })).contactId, sourceMember.id);

  const autoContact = await db.contact.create({ data: {
    displayName: 'Automatically discovered sender', status: 'provisional', confidence: 0.25,
    provisionalReason: 'Unmapped inbound human sender: generated@customer.test',
    emails: { create: { email: 'generated@customer.test' } },
  } });
  await db.$executeRaw`UPDATE "Contact" SET "updatedAt"="createdAt" WHERE "id"=${autoContact.id}`;
  const weakLinkMessage = await db.emailMessage.create({ data: messageData(account.id, { from: [{ address: 'generated@customer.test' }], contactId: autoContact.id }) });
  const legacyReview = await db.reviewItem.create({ data: { entityType: 'contact', entityId: autoContact.id, sourceMessageId: weakLinkMessage.id, reasonCode: 'CONTACT_PROVISIONAL', confidence: 0, dedupeKeyBase: `legacy-${autoContact.id}`, dedupeKey: `legacy-${autoContact.id}:1` } });
  const preview = await contacts.legacyContactCleanupPreview();
  assert.equal(preview.items.find(row => row.id === autoContact.id).eligible, true, 'weak email links are retained as evidence but do not prevent safe hiding');
  const retired = await contacts.retireLegacyContacts({ contacts: [{ id: autoContact.id, expectedVersion: autoContact.version }], actorId: 'operator', operationId: 'legacy-retirement' });
  assert.equal(retired.retiredCount, 1);
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: autoContact.id } })).status, 'retired');
  assert.equal((await db.contactEmail.findMany({ where: { contactId: autoContact.id } })).length, 1);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: weakLinkMessage.id } })).contactId, autoContact.id);
  assert.equal((await db.reviewItem.findUniqueOrThrow({ where: { id: legacyReview.id } })).status, 'resolved');
  const restored = await contacts.restoreLegacyContacts({ sourceOperationId: 'legacy-retirement', operationId: 'legacy-restoration', actorId: 'operator' });
  assert.equal(restored.restoredCount, 1);
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: autoContact.id } })).status, 'provisional');
  assert.equal((await db.contactEmail.findMany({ where: { contactId: autoContact.id } })).length, 1);

  const restoredAutomatic = await seedPureAutomaticContact('Restored old sender', ['restored-old@old.test']);
  await addProvisionalReview(restoredAutomatic, 'restored');
  await contacts.retireLegacyContacts({ contacts: [{ id: restoredAutomatic.id, expectedVersion: restoredAutomatic.version }], actorId: 'operator', operationId: 'legacy-retirement-then-restore' });
  await contacts.restoreLegacyContacts({ sourceOperationId: 'legacy-retirement-then-restore', operationId: 'legacy-restoration-for-registration', actorId: 'operator' });
  await db.businessOperation.update({ where: { operationId: 'legacy-restoration-for-registration' }, data: { createdAt: new Date('2000-01-01T00:00:00.000Z') } });
  const manuallyRegisteredRestored = await contacts.createContact({ email: 'restored-old@old.test', displayName: 'Restored sender confirmed by user', actorId: 'operator', operationId: 'register-restored-automatic-address' });
  assert.equal(manuallyRegisteredRestored.id, restoredAutomatic.id, 'an audited untouched retirement/restore cycle can still be explicitly confirmed');
  assert.equal(manuallyRegisteredRestored.status, 'confirmed');

  const editedAutomatic = await db.contact.create({ data: {
    displayName: 'Edited legacy sender', status: 'provisional', confidence: 0.25,
    provisionalReason: 'Unmapped inbound human sender: edited@customer.test', notes: 'operator note',
    emails: { create: { email: 'edited@customer.test' } },
  } });
  await db.$executeRaw`UPDATE "Contact" SET "updatedAt"="createdAt" WHERE "id"=${editedAutomatic.id}`;
  const editedPreview = await contacts.legacyContactCleanupPreview();
  assert.equal(editedPreview.items.find(row => row.id === editedAutomatic.id).eligible, false, 'manual notes protect an automatic-looking legacy row');
  const editedContactBefore = await db.contact.findUniqueOrThrow({ where: { id: editedAutomatic.id }, include: { emails: true } });
  await rejects(contacts.createContact({ email: 'edited@customer.test', displayName: 'Overwrite attempt', operationId: 'edited-provisional-restore-rejected' }), 409, 'EMAIL_CONTACT_CONFLICT');
  const editedContactAfter = await db.contact.findUniqueOrThrow({ where: { id: editedAutomatic.id }, include: { emails: true } });
  assert.equal(editedContactAfter.status, editedContactBefore.status);
  assert.equal(editedContactAfter.version, editedContactBefore.version);
  assert.equal(editedContactAfter.displayName, editedContactBefore.displayName);
  assert.equal(editedContactAfter.notes, editedContactBefore.notes, 'manual notes on a legacy provisional contact are never overwritten by POST create/restore');

  const oldSourceA = await seedPureAutomaticContact('Old automatic A', ['selected-a@old.test', 'kept-a@old.test']);
  const oldSourceB = await seedPureAutomaticContact('Old automatic B', ['selected-b@old.test', 'kept-b@old.test']);
  const oldSourceMailA = await db.emailMessage.create({ data: messageData(account.id, { contactId: oldSourceA.id, from: [{ address: 'selected-a@old.test' }] }) });
  const oldSourceMailB = await db.emailMessage.create({ data: messageData(account.id, { contactId: oldSourceB.id, from: [{ address: 'selected-b@old.test' }] }) });
  await addProvisionalReview(oldSourceA, 'a'); await addProvisionalReview(oldSourceB, 'b');
  const oldSourcesBeforeCreate = [oldSourceA, oldSourceB].map(({ id, version }) => ({ id, version }));
  const multiRetire = await contacts.retireLegacyContacts({
    contacts: oldSourcesBeforeCreate.map(({ id, version }) => ({ id, expectedVersion: version })),
    actorId: 'operator', operationId: 'legacy-multi-retirement-create',
  });
  assert.equal(multiRetire.retiredCount, 2);
  const createdFromRetiredAddresses = await contacts.createContact({
    emails: ['selected-a@old.test', 'selected-b@old.test'], primaryEmail: 'selected-a@old.test',
    displayName: 'Explicitly registered person', actorId: 'operator', operationId: 'create-from-retired-emails',
  });
  assert.equal(createdFromRetiredAddresses.status, 'confirmed');
  assert.deepEqual(createdFromRetiredAddresses.emails.map(item => item.email).sort(), ['selected-a@old.test', 'selected-b@old.test']);
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: oldSourceA.id } })).status, 'retired');
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: oldSourceB.id } })).status, 'retired');
  assert.deepEqual((await db.contactEmail.findMany({ where: { contactId: oldSourceA.id }, select: { email: true } })).map(item => item.email), ['kept-a@old.test']);
  assert.deepEqual((await db.contactEmail.findMany({ where: { contactId: oldSourceB.id }, select: { email: true } })).map(item => item.email), ['kept-b@old.test']);
  assert.equal((await db.contactEmail.findUniqueOrThrow({ where: { email: 'selected-a@old.test' } })).contactId, createdFromRetiredAddresses.id);
  assert.equal((await db.contactEmail.findUniqueOrThrow({ where: { email: 'selected-b@old.test' } })).contactId, createdFromRetiredAddresses.id);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: oldSourceMailA.id } })).contactId, oldSourceA.id);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: oldSourceMailB.id } })).contactId, oldSourceB.id);
  assert.deepEqual((await db.emailMessage.findUniqueOrThrow({ where: { id: oldSourceMailA.id } })).rawSource, oldSourceMailA.rawSource);
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: oldSourceA.id } })).version, oldSourceA.version + 2);
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: oldSourceB.id } })).version, oldSourceB.version + 2);
  const createTakeoverAudit = await db.businessOperation.findUniqueOrThrow({ where: { operationId: 'create-from-retired-emails' } });
  assert.equal(createTakeoverAudit.afterJson.emailTakeovers.length, 2, 'create audit records both retired source mappings in the same user operation');
  assert.deepEqual(createTakeoverAudit.afterJson.emailTakeovers.map(item => item.selectedEmails).flat().sort(), ['selected-a@old.test', 'selected-b@old.test']);
  assert.deepEqual(createTakeoverAudit.afterJson.emailTakeovers.map(item => item.sourceVersionAfter - item.sourceVersionBefore), [1, 1]);
  assert.deepEqual(createTakeoverAudit.afterJson.emailTakeovers.find(item => item.sourceContactId === oldSourceA.id).sourceMappingsBefore.map(item => item.email).sort(), ['kept-a@old.test', 'selected-a@old.test']);
  const createReplay = await contacts.createContact({
    emails: ['selected-a@old.test', 'selected-b@old.test'], primaryEmail: 'selected-a@old.test',
    displayName: 'Explicitly registered person', actorId: 'operator', operationId: 'create-from-retired-emails',
  });
  assert.equal(createReplay.id, createdFromRetiredAddresses.id);
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: oldSourceA.id } })).version, oldSourceA.version + 2, 'idempotent replay does not increment a source twice');
  await db.businessOperation.update({ where: { operationId: 'create-from-retired-emails' }, data: { createdAt: new Date('2000-01-02T00:00:00.000Z') } });
  const explicitlyRegisteredLeftover = await contacts.createContact({ email: 'kept-a@old.test', displayName: 'Second explicit address takeover', operationId: 'register-remaining-retired-address' });
  assert.equal((await db.contactEmail.findUniqueOrThrow({ where: { email: 'kept-a@old.test' } })).contactId, explicitlyRegisteredLeftover.id);
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: oldSourceA.id } })).version, oldSourceA.version + 3, 'a later explicit transfer follows the source version chain when the earlier takeover audit timestamp sorts before retirement');
  await rejects(contacts.restoreLegacyContacts({ sourceOperationId: 'legacy-multi-retirement-create', operationId: 'legacy-multi-restoration-rejected', actorId: 'operator' }), 409, 'CONTACT_RESTORE_CONFLICT');

  const updateTarget = await contacts.createContact({ email: 'confirmed-target@manual.test', displayName: 'Existing manual target', operationId: 'retired-email-update-target' });
  const oldSourceC = await seedPureAutomaticContact('Old automatic C', ['selected-c@old.test', 'kept-c@old.test']);
  const oldSourceD = await seedPureAutomaticContact('Old automatic D', ['selected-d@old.test', 'kept-d@old.test']);
  const oldSourceMailC = await db.emailMessage.create({ data: messageData(account.id, { contactId: oldSourceC.id, from: [{ address: 'selected-c@old.test' }] }) });
  await addProvisionalReview(oldSourceC, 'c'); await addProvisionalReview(oldSourceD, 'd');
  await contacts.retireLegacyContacts({
    contacts: [{ id: oldSourceC.id, expectedVersion: oldSourceC.version }, { id: oldSourceD.id, expectedVersion: oldSourceD.version }],
    actorId: 'operator', operationId: 'legacy-multi-retirement-update',
  });
  await rejects(contacts.createContact({
    emails: ['confirmed-target@manual.test', 'selected-c@old.test'], displayName: 'Must not merge identities', operationId: 'create-mixed-confirmed-and-retired',
  }), 409, 'EMAIL_CONTACT_CONFLICT');
  assert.equal((await db.contactEmail.findUniqueOrThrow({ where: { email: 'selected-c@old.test' } })).contactId, oldSourceC.id, 'a retired address is not taken when POST also names a confirmed contact');
  const updatedTarget = await contacts.updateContact(updateTarget.id, {
    emails: ['confirmed-target@manual.test', 'selected-c@old.test', 'selected-d@old.test'], primaryEmail: 'selected-d@old.test',
    expectedVersion: updateTarget.version, actorId: 'operator', operationId: 'add-selected-retired-emails',
  });
  assert.deepEqual(updatedTarget.emails.map(item => item.email).sort(), ['confirmed-target@manual.test', 'selected-c@old.test', 'selected-d@old.test']);
  assert.equal(updatedTarget.emails.find(item => item.isPrimary).email, 'selected-d@old.test');
  assert.deepEqual((await db.contactEmail.findMany({ where: { contactId: oldSourceC.id }, select: { email: true } })).map(item => item.email), ['kept-c@old.test']);
  assert.deepEqual((await db.contactEmail.findMany({ where: { contactId: oldSourceD.id }, select: { email: true } })).map(item => item.email), ['kept-d@old.test']);
  assert.equal((await db.emailMessage.findUniqueOrThrow({ where: { id: oldSourceMailC.id } })).contactId, oldSourceC.id);
  assert.deepEqual((await db.emailMessage.findUniqueOrThrow({ where: { id: oldSourceMailC.id } })).rawSource, oldSourceMailC.rawSource);
  const updateTakeoverAudit = await db.businessOperation.findUniqueOrThrow({ where: { operationId: 'add-selected-retired-emails' } });
  assert.equal(updateTakeoverAudit.afterJson.emailTakeovers.length, 2, 'PATCH audit records only the explicitly selected old mappings');
  await rejects(contacts.restoreLegacyContacts({ sourceOperationId: 'legacy-multi-retirement-update', operationId: 'legacy-multi-restoration-after-update', actorId: 'operator' }), 409, 'CONTACT_RESTORE_CONFLICT');

  const protectedRetired = await seedPureAutomaticContact('Modified after retirement', ['protected-old@old.test']);
  await addProvisionalReview(protectedRetired, 'protected');
  await contacts.retireLegacyContacts({ contacts: [{ id: protectedRetired.id, expectedVersion: protectedRetired.version }], actorId: 'operator', operationId: 'legacy-retirement-protected-source' });
  const retiredSnapshot = await db.contact.findUniqueOrThrow({ where: { id: protectedRetired.id } });
  await db.contact.update({ where: { id: protectedRetired.id }, data: { notes: 'edited after retirement', version: { increment: 1 } } });
  await rejects(contacts.createContact({ email: 'protected-old@old.test', displayName: 'Should not take', operationId: 'takeover-edited-retired-source' }), 409, 'EMAIL_CONTACT_CONFLICT');
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: protectedRetired.id } })).notes, 'edited after retirement');
  assert.equal((await db.contactEmail.findUniqueOrThrow({ where: { email: 'protected-old@old.test' } })).contactId, retiredSnapshot.id);

  console.log('PASS manual CRM/project PostgreSQL regressions');
}

main().catch(error => {
  const diagnostic = String(error?.stack ?? error?.message ?? error)
    .split(adminUrl).join('[redacted-admin-database-url]')
    .split(testUrl.toString()).join('[isolated-test-database-url]')
    .slice(0, 5000);
  console.error(`FAIL manual CRM/project PostgreSQL regressions:\n${diagnostic}`);
  process.exitCode = 1;
}).finally(async () => {
  if (db) await db.$disconnect();
  if (created) {
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } catch (error) {
      console.error(`Failed to drop isolated database ${dbName}: ${String(error.message).split(adminUrl).join('[redacted-admin-database-url]').split(testUrl.toString()).join('[isolated-test-database-url]')}`);
      process.exitCode = 1;
    }
  }
  await admin.$disconnect();
});
