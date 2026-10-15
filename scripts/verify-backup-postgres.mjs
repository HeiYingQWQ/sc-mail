import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { backup } from './backup.mjs';
import { verifyBackup } from './verify-backup-restore.mjs';
import { postgresRunner } from './backup-runtime.mjs';

assert.equal(process.env.BACKUP_RESTORE_ALLOW_LOCAL_DB_CREATE, '1');
const adminUrl = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname));
assert.equal(adminUrl.pathname, '/sc_mail_ci', 'Use the disposable sc_mail_ci administration database');
const database = `aimail_backup_fixture_${randomUUID().replaceAll('-', '')}`;
const sourceUrl = new URL(adminUrl); sourceUrl.pathname = `/${database}`;
const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
const db = new PrismaClient({ datasourceUrl: sourceUrl.toString() });
const dir = await mkdtemp(join(tmpdir(), 'sc-mail-backup-pg-'));
const raw = Buffer.from('From: customer@test.invalid\r\nSubject: Synthetic recovery\r\nContent-Transfer-Encoding: base64\r\n\r\n' + randomBytes(4 * 1024 * 1024).toString('base64'));
let created = false;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`); created = true;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: sourceUrl.toString() }, stdio: 'pipe', timeout: 120000 });
  const account = await db.mailAccount.create({ data: { email: 'owner@test.invalid', host: 'imap.test.invalid', port: 993, tlsMode: 'tls', username: 'owner@test.invalid', passwordCiphertext: 'synthetic-not-a-credential' } });
  const contact = await db.contact.create({ data: { displayName: 'Synthetic customer', emails: { create: { email: 'customer@test.invalid' } } } });
  const project = await db.project.create({ data: { name: 'Synthetic recovery project' } });
  const mail = await db.emailMessage.create({ data: { mailAccountId: account.id, mailbox: 'INBOX', uidValidity: 1n, uid: 1, providerMessageId: 'fixture-1', direction: 'inbound', fromJson: [{ address: 'customer@test.invalid' }], toJson: [], ccJson: [], bccJson: [], headersJson: {}, rawSource: raw, bodyText: 'Evidence preserved.', contactId: contact.id, projectId: project.id } });
  const task = await db.task.create({ data: { title: 'Synthetic task', createdFromMessageId: mail.id, projectId: project.id, manualOverride: true } });
  const event = await db.agentEvent.create({ data: { eventKey: 'backup-fixture-event', eventType: 'INBOUND_EMAIL_RECEIVED', entityType: 'email', entityId: mail.id, payloadJson: {}, notificationPolicy: 'REALTIME' } });
  await db.notificationDelivery.create({ data: { requestKey: 'backup-fixture-notice', requestHash: 'synthetic', eventId: event.id, channel: 'whatsapp', recipientRef: '+15555550123', content: 'Synthetic; never sent', status: 'unknown' } });
  const runner = postgresRunner();
  const file = join(dir, 'saved.dump'), copied = join(dir, 'copied.dump');
  await backup(file, { run: (tool, args, options) => runner(tool, args, { ...options, database }) });
  await copyFile(file, copied);
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  // Change the live fixture after saving: the restore must come from the file, never a fresh dump.
  await db.task.update({ where: { id: task.id }, data: { title: 'Changed after backup' } });
  await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`); created = false;
  const report = await verifyBackup(copied, { validate: async ({ database: restoredName, counts }) => {
    assert.equal(counts.mail, 1); assert.equal(counts.contacts, 1); assert.equal(counts.tasks, 1); assert.equal(counts.migrations, 27);
    const restoredUrl = new URL(adminUrl); restoredUrl.pathname = `/${restoredName}`;
    const restored = new PrismaClient({ datasourceUrl: restoredUrl.toString() });
    try {
      const recovered = await restored.task.findUniqueOrThrow({ where: { id: task.id }, include: { createdFromMessage: true, project: true } });
      assert.equal(recovered.title, 'Synthetic task'); assert.equal(recovered.manualOverride, true);
      assert.equal(recovered.project.name, project.name); assert.equal(recovered.createdFromMessage.contactId, contact.id);
      assert.deepEqual(Buffer.from(recovered.createdFromMessage.rawSource), raw);
      assert.equal((await restored.notificationDelivery.findUniqueOrThrow({ where: { requestKey: 'backup-fixture-notice' } })).status, 'unknown');
    } finally { await restored.$disconnect(); }
  } });
  assert.equal(report.sha256, digest);
  const corrupt = join(dir, 'corrupt.dump'); const saved = await readFile(file);
  await writeFile(corrupt, saved.subarray(0, saved.length - 100));
  await assert.rejects(verifyBackup(corrupt));
  // Exercise a real process deadline after CREATE DATABASE, then bounded cleanup.
  let reachedSlowQuery = false;
  await assert.rejects(verifyBackup(copied, { timeoutMs: 10000, progressMs: 1000, validate: async ({ database: restored, run, op }) => {
    reachedSlowQuery = true;
    await run('psql', ['-X', '-At', '-c', 'SELECT pg_sleep(30)'], { database: restored, op });
  } }));
  assert.equal(reachedSlowQuery, true, 'Deadline test must reach a real PostgreSQL query');
  const leftovers = await admin.$queryRawUnsafe("SELECT datname FROM pg_database WHERE datname LIKE 'aimail_restore_check_%'");
  assert.deepEqual(leftovers, []);
  console.log('Saved-file PostgreSQL restore passed: copied archive, removed source, exact MIME/CRM/task relations, unknown notification preserved, corrupt archive rejected, temporary databases removed.');
} finally {
  await db.$disconnect();
  if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.$disconnect(); await rm(dir, { recursive: true, force: true });
}
