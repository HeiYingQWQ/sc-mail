/* Real PostgreSQL regression coverage for audited CRM soft deletion. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { ContactResolverService } = require('../dist/modules/mail/contact-resolver.service.js');
const { ProjectReviewService } = require('../dist/modules/mail/project-review.service.js');

const adminUrl = process.env.DATABASE_URL;
assert.ok(adminUrl, 'Set DATABASE_URL to a disposable local/test PostgreSQL server');
const sourceUrl = new URL(adminUrl);
assert.ok(['localhost', '127.0.0.1', '::1', 'postgres'].includes(sourceUrl.hostname),
  'CRM delete acceptance only permits a local PostgreSQL host; production and remote hosts are refused');
assert.equal(process.env.CRM_DELETE_ALLOW_LOCAL_DB_CREATE, '1',
  'Set CRM_DELETE_ALLOW_LOCAL_DB_CREATE=1 to authorize a uniquely named isolated database');
assert.doesNotMatch(sourceUrl.pathname.toLowerCase(), /prod(?:uction)?/, 'Production-named databases are refused');
const dbName = `aimail_crm_delete_${Date.now()}_${process.pid}`;
assert.match(dbName, /^aimail_crm_delete_\d+_\d+$/);
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
const admin = new PrismaClient({ datasourceUrl: adminUrl });
const settings = { IMAP_EMAIL: 'crm-delete-owner@test.invalid', IMAP_HOST: 'imap.test.invalid', BUSINESS_TIMEZONE: 'Europe/Rome' };
const config = { get: (key, fallback) => settings[key] === undefined ? fallback : settings[key] };
let db;
let created = false;

function responseCode(error) { return error?.response?.code ?? error?.code; }
async function rejects(promise, status, code) {
  await assert.rejects(promise, error => error.status === status && (!code || responseCode(error) === code),
    `expected HTTP ${status}${code ? ` / ${code}` : ''}`);
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
  const invalidator = { async invalidateProjectSummaries() {} };
  const contacts = new ContactResolverService(config, db, invalidator);
  const projects = new ProjectReviewService(config, db, invalidator);

  const contactA = await contacts.createContact({ displayName: 'Delete Test A', email: 'delete-a@test.invalid', operationId: 'crm-delete-create-a' });
  const contactB = await contacts.createContact({ displayName: 'Delete Test B', email: 'delete-b@test.invalid', operationId: 'crm-delete-create-b' });
  const company = await contacts.createCompany({
    name: 'Delete Test Company', domain: 'delete-test.invalid', contactIds: [contactA.id, contactB.id], operationId: 'crm-delete-create-company',
  });
  const companyContactA = await db.contact.findUniqueOrThrow({ where: { id: contactA.id } });
  const companyContactB = await db.contact.findUniqueOrThrow({ where: { id: contactB.id } });
  assert.equal(companyContactA.companyId, company.id);
  assert.equal(companyContactB.companyId, company.id);

  const project = await projects.createProject({
    name: 'Delete Test Project', companyId: company.id, contactIds: [contactA.id], stage: 'planning', status: 'active', operationId: 'crm-delete-create-project',
  });
  await rejects(projects.deleteProject(project.id, { operationId: 'crm-delete-project-missing-version' }), 400);
  assert.equal(await db.businessOperation.findUnique({ where: { operationId: 'crm-delete-project-missing-version' } }), null,
    'project deletion without expectedVersion must not write an audit operation');
  const projectOnlyContact = await contacts.createContact({ displayName: 'Project-only historical contact', email: 'project-only@test.invalid', operationId: 'crm-delete-create-project-only-contact' });
  await db.projectContact.create({ data: { projectId: project.id, contactId: projectOnlyContact.id } });
  const task = await db.task.create({ data: { projectId: project.id, title: 'Synthetic active blocker', status: 'open', origin: 'user' } });
  const job = await db.projectAnalysisJob.create({ data: {
    projectId: project.id, mailAccountId: account.id, operationId: 'crm-delete-analysis-job', inputHash: 'synthetic-input',
    projectContextHash: 'synthetic-context', status: 'pending', trigger: 'manual',
  } });
  const raw = Buffer.from('synthetic original email bytes: crm delete evidence');
  const message = await db.emailMessage.create({ data: {
    mailAccountId: account.id, mailbox: 'INBOX', uidValidity: 1n, uid: 1, providerMessageId: 'crm-delete-message-1',
    rfcMessageId: '<crm-delete-1@test.invalid>', direction: 'inbound', fromJson: [{ address: 'delete-a@test.invalid' }],
    toJson: [], ccJson: [], bccJson: [], subject: 'Synthetic retained evidence', bodyText: 'Retained test body',
    headersJson: {}, rawSource: raw, receivedAt: new Date('2026-07-01T10:00:00.000Z'), classification: 'BUSINESS_HUMAN',
    reviewRequired: false, contactId: contactA.id, companyId: company.id, projectId: project.id,
    contactResolutionStatus: 'matched', projectResolutionStatus: 'manual', projectManualOverride: true,
  } });

  await rejects(contacts.deleteCompany(company.id, { expectedVersion: company.version + 1, operationId: 'crm-delete-company-stale' }), 409, 'VERSION_CONFLICT');
  await rejects(contacts.deleteContact(contactA.id, { expectedVersion: companyContactA.version - 1, operationId: 'crm-delete-contact-stale' }), 409, 'VERSION_CONFLICT');
  await rejects(contacts.deleteContact(contactA.id, { expectedVersion: companyContactA.version, operationId: 'crm-delete-contact-company-member' }), 409, 'CONTACT_HAS_COMPANY_MEMBERSHIP');
  await rejects(contacts.deleteCompany(company.id, { expectedVersion: company.version, operationId: 'crm-delete-company-active-project' }), 409, 'COMPANY_HAS_PROJECTS');
  await rejects(contacts.deleteContact(projectOnlyContact.id, { expectedVersion: projectOnlyContact.version, operationId: 'crm-delete-contact-active-project-member' }), 409, 'CONTACT_HAS_PROJECT_MEMBERSHIPS');
  assert.equal(await db.businessOperation.findUnique({ where: { operationId: 'crm-delete-company-active-project' } }), null,
    'failed company deletion must roll back its audit operation');
  assert.equal((await db.company.findUniqueOrThrow({ where: { id: company.id } })).status, 'confirmed');
  const afterBlockedCompanyDelete = await db.contact.findUniqueOrThrow({ where: { id: contactA.id } });
  assert.equal(afterBlockedCompanyDelete.companyId, company.id);
  assert.equal(afterBlockedCompanyDelete.version, companyContactA.version, 'blocked company deletion must not bump member versions');

  await rejects(projects.deleteProject(project.id, { expectedVersion: project.version, operationId: 'crm-delete-project-active-job' }), 409, 'PROJECT_HAS_ACTIVE_ANALYSIS');
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: project.id } })).status, 'active');
  await db.projectAnalysisJob.update({ where: { id: job.id }, data: { status: 'failed' } });
  await rejects(projects.deleteProject(project.id, { expectedVersion: project.version, operationId: 'crm-delete-project-active-task' }), 409, 'PROJECT_HAS_ACTIVE_TASKS');
  await db.task.update({ where: { id: task.id }, data: { status: 'done', completedAt: new Date() } });
  const deletedProject = await projects.deleteProject(project.id, { expectedVersion: project.version, actorId: 'crm-delete-test-user', operationId: 'crm-delete-project-soft' });
  assert.equal(deletedProject.status, 'deleted');
  assert.equal(deletedProject.version, project.version + 1);
  await rejects(projects.getProject(project.id), 404);
  await rejects(projects.updateProject(project.id, { expectedVersion: deletedProject.version, name: 'Cannot restore through PATCH', operationId: 'crm-delete-patch-deleted-project' }), 404);
  assert.ok(!(await projects.listProjects(100, 0, company.id)).projects.some(item => item.id === project.id));
  assert.ok(await db.projectContact.findUnique({ where: { projectId_contactId: { projectId: project.id, contactId: contactA.id } } }),
    'soft deletion must preserve historical project membership rows');
  assert.equal((await contacts.getCompany(company.id)).projects.length, 0, 'company detail must hide deleted projects');
  const staleProjectReview = await db.reviewItem.create({ data: {
    entityType: 'email_message', entityId: message.id, sourceMessageId: message.id, reasonCode: 'PROJECT_ANALYSIS_NEEDS_REVIEW',
    confidence: 0, dedupeKeyBase: 'crm-delete-stale-project-review', dedupeKey: 'crm-delete-stale-project-review:1',
  } });
  await rejects(projects.resolveReview(staleProjectReview.id, {
    action: 'assign_project', projectId: project.id, operationId: 'crm-delete-assign-to-deleted-project',
  }), 404);
  assert.equal(await db.businessOperation.findUnique({ where: { operationId: 'crm-delete-assign-to-deleted-project' } }), null,
    'manual assignment to a deleted project must not commit an audit or alter facts');
  const emailAfterRejectedAssignment = await db.emailMessage.findUniqueOrThrow({ where: { id: message.id }, select: { projectId: true, projectAssignmentVersion: true } });
  assert.equal(emailAfterRejectedAssignment.projectId, project.id);
  assert.equal(emailAfterRejectedAssignment.projectAssignmentVersion, message.projectAssignmentVersion);
  assert.deepEqual(await projects.deleteProject(project.id, {
    expectedVersion: project.version, actorId: 'crm-delete-test-user', operationId: 'crm-delete-project-soft',
  }), deletedProject, 'same project delete operation must replay its original receipt');
  await rejects(projects.deleteProject(project.id, {
    expectedVersion: project.version + 1, actorId: 'crm-delete-test-user', operationId: 'crm-delete-project-soft',
  }), 409, 'IDEMPOTENCY_KEY_REUSED');

  const deleteReceipt = await contacts.deleteCompany(company.id, {
    expectedVersion: company.version, actorId: 'crm-delete-test-user', operationId: 'crm-delete-company-soft',
  });
  assert.equal(deleteReceipt.status, 'deleted');
  assert.equal(deleteReceipt.version, company.version + 1);
  assert.deepEqual([...deleteReceipt.detachedContactIds].sort(), [contactA.id, contactB.id].sort());
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: contactA.id } })).version, companyContactA.version + 1);
  assert.equal((await db.contact.findUniqueOrThrow({ where: { id: contactB.id } })).version, companyContactB.version + 1);
  assert.deepEqual(await contacts.deleteCompany(company.id, {
    expectedVersion: company.version, actorId: 'crm-delete-test-user', operationId: 'crm-delete-company-soft',
  }), deleteReceipt, 'same operation id must replay the original deletion receipt');
  await rejects(contacts.deleteCompany(company.id, {
    expectedVersion: company.version + 1, actorId: 'crm-delete-test-user', operationId: 'crm-delete-company-soft',
  }), 409, 'IDEMPOTENCY_KEY_REUSED');
  await rejects(contacts.deleteCompany(company.id, { expectedVersion: company.version, operationId: 'crm-delete-company-again' }), 404);
  await rejects(contacts.getCompany(company.id), 404);
  const listedCompanies = await contacts.listCompanies(100, 0);
  assert.ok(!listedCompanies.companies.some(item => item.id === company.id));
  assert.equal(listedCompanies.total, await db.company.count({ where: { status: { not: 'deleted' } } }));

  for (const id of [contactA.id, contactB.id]) {
    const contact = await db.contact.findUniqueOrThrow({ where: { id } });
    assert.equal(contact.companyId, null, 'company soft deletion must detach each CRM contact');
    const receipt = await contacts.deleteContact(id, {
      expectedVersion: contact.version, actorId: 'crm-delete-test-user', operationId: `crm-delete-contact-soft-${id}`,
    });
    assert.equal(receipt.status, 'deleted');
    assert.equal(receipt.version, contact.version + 1);
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id } })).status, 'deleted');
    await rejects(contacts.getContact(id), 404);
  }
  const listedContacts = await contacts.listContacts(100, 0);
  assert.ok(!listedContacts.contacts.some(item => [contactA.id, contactB.id].includes(item.id)));
  const projectOnlyState = await db.contact.findUniqueOrThrow({ where: { id: projectOnlyContact.id } });
  const projectOnlyReceipt = await contacts.deleteContact(projectOnlyContact.id, { expectedVersion: projectOnlyState.version, operationId: 'crm-delete-contact-after-project' });
  assert.equal(projectOnlyReceipt.status, 'deleted', 'historical membership in a deleted project must not block contact deletion');

  await rejects(contacts.createContact({ displayName: 'No resurrection', email: 'delete-a@test.invalid', operationId: 'crm-delete-no-contact-resurrection' }), 409, 'EMAIL_CONTACT_CONFLICT');
  const unassigned = await contacts.createContact({ displayName: 'Unassigned Contact', email: 'unassigned@test.invalid', operationId: 'crm-delete-create-unassigned' });
  await rejects(contacts.createContact({ displayName: 'Deleted company assignment', email: 'deleted-company-new@test.invalid', companyId: company.id, operationId: 'crm-delete-create-with-deleted-company' }), 404);
  await rejects(contacts.updateContact(unassigned.id, { expectedVersion: unassigned.version, companyId: company.id, operationId: 'crm-delete-update-with-deleted-company' }), 404);
  await rejects(projects.createProject({
    name: 'Deleted Company Project', companyId: company.id, contactIds: [unassigned.id], stage: 'planning', status: 'active', operationId: 'crm-delete-project-with-deleted-company',
  }), 404);

  const [emailAfter, senderAfter] = await Promise.all([
    db.emailMessage.findUniqueOrThrow({ where: { id: message.id } }),
    db.contactEmail.findUniqueOrThrow({ where: { email: 'delete-a@test.invalid' } }),
  ]);
  assert.deepEqual(Buffer.from(emailAfter.rawSource), raw, 'original raw email bytes must remain unchanged');
  assert.equal(emailAfter.contactId, contactA.id);
  assert.equal(emailAfter.companyId, company.id, 'historical email company association must remain intact');
  assert.equal(emailAfter.projectId, project.id);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, 'done', 'soft deletion must preserve related task facts');
  assert.equal((await db.projectAnalysisJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'failed', 'soft deletion must preserve analysis-job audit rows');
  assert.equal(senderAfter.contactId, contactA.id, 'soft deletion must preserve registered email ownership');
  const [contactAudit, companyAudit, projectAudit] = await Promise.all([
    db.businessOperation.findUniqueOrThrow({ where: { operationId: `crm-delete-contact-soft-${contactA.id}` } }),
    db.businessOperation.findUniqueOrThrow({ where: { operationId: 'crm-delete-company-soft' } }),
    db.businessOperation.findUniqueOrThrow({ where: { operationId: 'crm-delete-project-soft' } }),
  ]);
  assert.equal(contactAudit.actorId, 'crm-delete-test-user');
  assert.equal(contactAudit.action, 'delete');
  assert.equal(companyAudit.actorId, 'crm-delete-test-user');
  assert.equal(companyAudit.action, 'delete');
  assert.equal(projectAudit.actorId, 'crm-delete-test-user');
  assert.equal(projectAudit.action, 'delete');
  assert.equal((await db.businessOperation.findUniqueOrThrow({ where: { operationId: 'crm-delete-company-soft' } })).afterJson.id, company.id);

  console.log(JSON.stringify({ ok: true, isolatedDatabase: dbName, sequence: 'project -> company -> contacts', rawEvidencePreserved: true }, null, 2));
}

main().catch(error => {
  const redacted = String(error?.stack ?? error)
    .replaceAll(adminUrl, '[redacted database url]')
    .replaceAll(testUrl.toString(), '[redacted test database url]')
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@[^\s/]+/gi, '[redacted database url]');
  console.error(redacted);
  process.exitCode = 1;
}).finally(async () => {
  await db?.$disconnect();
  await admin.$disconnect();
  if (created) {
    const cleanup = new PrismaClient({ datasourceUrl: adminUrl });
    try { await cleanup.$executeRawUnsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`); }
    finally { await cleanup.$disconnect(); }
  }
});
