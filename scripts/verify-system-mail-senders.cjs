/* Isolated PostgreSQL regression coverage for system sender management and delivery reports. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { SystemMailSendersService } = require('../dist/modules/mail/system-mail-senders.service.js');
const { DeliveryFailuresService } = require('../dist/modules/mail/delivery-failures.service.js');
const { MailController } = require('../dist/modules/mail/mail.controller.js');

const adminUrl = process.env.DATABASE_URL;
assert.ok(adminUrl, 'Set DATABASE_URL to a disposable local/test PostgreSQL server');
const sourceUrl = new URL(adminUrl);
assert.ok(['localhost', '127.0.0.1', '::1', 'postgres'].includes(sourceUrl.hostname),
  'System sender acceptance only permits a local PostgreSQL host; remote database hosts are refused');
assert.equal(process.env.MANUAL_CRM_ALLOW_LOCAL_DB_CREATE, '1',
  'Set MANUAL_CRM_ALLOW_LOCAL_DB_CREATE=1 to authorize creation and removal of a uniquely named isolated local database');
assert.doesNotMatch(sourceUrl.pathname.toLowerCase(), /prod(?:uction)?/, 'Production-named databases are refused');
const dbName = `aimail_system_mail_senders_${Date.now()}_${process.pid}`;
assert.match(dbName, /^aimail_system_mail_senders_\d+_\d+$/);
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
const admin = new PrismaClient({ datasourceUrl: adminUrl });
const settings = { IMAP_EMAIL: 'sender-owner@test.invalid', IMAP_HOST: 'imap.test.invalid', IMAP_API_TOKEN: 'synthetic-api-token', BUSINESS_TIMEZONE: 'Europe/Rome' };
const config = { get: (key, fallback) => settings[key] === undefined ? fallback : settings[key] };
let db;
let created = false;
let sequence = 0;

function responseCode(error) {
  const response = typeof error?.getResponse === 'function' ? error.getResponse() : error?.response;
  return response && typeof response === 'object' ? response.code : error?.code;
}

async function rejects(promise, status, code) {
  await assert.rejects(promise, error => {
    const actualStatus = typeof error?.getStatus === 'function' ? error.getStatus() : error?.status;
    return actualStatus === status && (!code || responseCode(error) === code);
  }, `expected HTTP status ${status}${code ? ` / ${code}` : ''}`);
}

function emailMessage(accountId, options = {}) {
  const index = ++sequence;
  const receivedAt = options.receivedAt ?? new Date('2026-03-29T10:00:00.000Z');
  const sender = options.sender ?? 'mailer-daemon@googlemail.com';
  return {
    mailAccountId: accountId,
    mailbox: options.mailbox ?? 'INBOX',
    uidValidity: 1n,
    uid: index,
    providerMessageId: `system-sender-${index}`,
    rfcMessageId: options.rfcMessageId ?? `<system-sender-${index}@test.invalid>`,
    direction: options.direction ?? 'inbound',
    fromJson: [{ name: options.senderName ?? 'Mail delivery subsystem', address: sender }],
    toJson: options.to ?? [{ name: 'Mailbox owner', address: settings.IMAP_EMAIL }],
    ccJson: [], bccJson: [],
    subject: options.subject ?? `Synthetic report ${index} BODY-SECRET-${index}`,
    bodyText: options.body ?? 'Synthetic system notification without delivery evidence.',
    bodyHtml: null,
    headersJson: {},
    rawSource: Buffer.from(options.raw ?? `From: ${sender}\r\nTo: ${settings.IMAP_EMAIL}\r\nSubject: RAW-SECRET-${index}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic raw content.`),
    receivedAt,
    sentAt: null,
    classification: options.classification ?? 'UNKNOWN',
    classificationReason: options.classificationReason ?? null,
    reviewRequired: false,
  };
}

function multipartReport({ firstRecipient = 'bad@example.invalid', originalRecipient = 'original@example.invalid', includeRealDsn = true } = {}) {
  const dsnPart = includeRealDsn ? `--mixed-boundary\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; mx.test.invalid\r\nArrival-Date: Sun, 29 Mar 2026 12:00:00 +0200\r\n\r\nFinal-Recipient: rfc822; ${firstRecipient}\r\nOriginal-Recipient: rfc822; ${originalRecipient}\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 mailbox does not exist\r\n\r\nFinal-Recipient: rfc822; delivered@example.invalid\r\nAction: delivered\r\nStatus: 2.0.0\r\nDiagnostic-Code: smtp; 550 contradictory delivery text\r\n` : '';
  const attached = `--mixed-boundary\r\nContent-Type: message/rfc822\r\n\r\nFrom: former-sender@example.invalid\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; quoted-spoof@example.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\n`;
  return `From: mailer-daemon@googlemail.com\r\nTo: ${settings.IMAP_EMAIL}\r\nSubject: multipart report\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="mixed-boundary"\r\n\r\n--mixed-boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic report text.\r\n${dsnPart}${attached}--mixed-boundary--\r\n`;
}

async function seedMessage(accountId, options) {
  return db.emailMessage.create({ data: emailMessage(accountId, options) });
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
  const senders = new SystemMailSendersService(db);
  const failures = new DeliveryFailuresService(config, db, senders);

  const initial = await senders.list();
  assert.equal(initial.total, 3);
  assert.deepEqual(initial.senders.map(row => row.email).sort(), [
    'mailer-daemon@googlemail.com', 'mailer-daemon@mail.ni8.com', 'mailer-daemon@zmail.tsnet.it',
  ]);
  assert.deepEqual(await senders.matchSystemSenderAddresses([' Mailer-Daemon@GoogleMail.com ', 'x@googlemail.com']), ['mailer-daemon@googlemail.com']);
  await rejects(senders.upsert({ email: 'bad@:foo.com', operationId: 'invalid-sender-email' }), 400, 'SYSTEM_MAIL_SENDER_INVALID_EMAIL');

  const controller = Object.create(MailController.prototype);
  controller.config = config;
  controller.auth = { isActiveSessionToken: async () => false };
  controller.systemMailSenders = senders;
  controller.deliveryFailures = failures;
  await rejects(controller.listSystemMailSenders(), 401);
  await rejects(controller.listDeliveryFailures(undefined, undefined, undefined), 401);
  assert.equal((await controller.listSystemMailSenders(`Bearer ${settings.IMAP_API_TOKEN}`)).total, 3);

  const createdSender = await controller.upsertSystemMailSender({ email: '  Alerts@Notify.Example.test ', operationId: 'sender-add-one' }, `Bearer ${settings.IMAP_API_TOKEN}`);
  assert.equal(createdSender.email, 'alerts@notify.example.test');
  const replaySender = await controller.upsertSystemMailSender({ email: 'alerts@notify.example.test', operationId: 'sender-add-one' }, `Bearer ${settings.IMAP_API_TOKEN}`);
  assert.equal(JSON.stringify(replaySender), JSON.stringify(createdSender));
  await rejects(senders.upsert({ email: 'different@notify.example.test', operationId: 'sender-add-one' }), 409, 'IDEMPOTENCY_KEY_REUSED');
  const senderAudit = await db.businessOperation.findUnique({ where: { operationId: 'sender-add-one' } });
  assert.equal(senderAudit.entityType, 'system_mail_sender');
  assert.equal(senderAudit.action, 'upsert');

  const concurrentEmail = 'concurrent@notify.example.test';
  const concurrent = await Promise.allSettled([
    senders.upsert({ email: concurrentEmail, operationId: 'sender-race-one' }),
    senders.upsert({ email: concurrentEmail.toUpperCase(), operationId: 'sender-race-two' }),
  ]);
  for (const result of concurrent) {
    if (result.status === 'rejected') {
      const status = typeof result.reason?.getStatus === 'function' ? result.reason.getStatus() : result.reason?.status;
      assert.equal(status, 409, 'concurrent unique-email writes may return a typed retry conflict, never an unhandled server error');
    }
  }
  assert.equal(await db.systemMailSender.count({ where: { email: concurrentEmail } }), 1);

  const deleteDefault = initial.senders.find(row => row.email === 'mailer-daemon@mail.ni8.com');
  const deleted = await controller.deleteSystemMailSender(deleteDefault.id, { operationId: 'sender-delete-default' }, `Bearer ${settings.IMAP_API_TOKEN}`);
  assert.equal(deleted.deleted, true);
  assert.equal((await controller.deleteSystemMailSender(deleteDefault.id, { operationId: 'sender-delete-default' }, `Bearer ${settings.IMAP_API_TOKEN}`)).email, deleteDefault.email);
  await rejects(controller.deleteSystemMailSender(deleteDefault.id, { operationId: 'sender-delete-reused', actorId: 'test' }, `Bearer ${settings.IMAP_API_TOKEN}`), 404, 'SYSTEM_MAIL_SENDER_NOT_FOUND');
  assert.equal((await new SystemMailSendersService(db).list()).senders.some(row => row.email === deleteDefault.email), false,
    'constructing a fresh service must not reseed a deleted migration default');
  const idnSender = await controller.upsertSystemMailSender({ email: 'Bounce@Bücher.Example', operationId: 'sender-add-idn' }, `Bearer ${settings.IMAP_API_TOKEN}`);
  assert.equal(idnSender.email, 'bounce@xn--bcher-kva.example');
  assert.deepEqual(await senders.matchSystemSenderAddresses(['BOUNCE@BÜCHER.EXAMPLE']), ['bounce@xn--bcher-kva.example']);

  const mixedDsn = multipartReport();
  await seedMessage(account.id, { raw: mixedDsn, body: 'The structured report includes both recipients.', classification: 'DELIVERY_FAILURE', classificationReason: 'Structured DSN failure', subject: 'BODY-SECRET mixed report' });
  await seedMessage(account.id, { classification: 'BUSINESS_HUMAN', body: "Your message wasn't delivered to\n wrapped@example.invalid because the address could not be found.", raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nYour message was not delivered.' });
  await seedMessage(account.id, { classification: 'DELIVERY_FAILURE', body: 'postfix@example.invalid: host mx.example.invalid said:550 5.1.1 user unknown', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nDelivery status report.' });
  await seedMessage(account.id, { classification: 'BUSINESS_HUMAN', body: 'This is a delivery status notification from the local MTA.\n\n<qmail@example.invalid>:\nSorry, no mailbox here by that name. (#5.1.1)\n\nsecond-qmail@example.invalid:\n550 Unknown user (#5.1.1)\n\n--- Below this line is a copy of the message. -----\nquoted-qmail@example.invalid:\nSorry, no mailbox here by that name.', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nSorry no mailbox.' });
  await seedMessage(account.id, { classification: 'DELIVERY_FAILURE', body: 'Delivery failed.\r\n--- Below this line is a copy of the message. -----\r\nYour message was not delivered to quoted-spoof@example.invalid because it is invalid.', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nQuoted spoof.' });
  await seedMessage(account.id, { classification: 'DELIVERY_FAILURE', body: 'Failure report has no identifiable recipient.', to: [{ name: 'Owner', address: settings.IMAP_EMAIL }], raw: 'From: mailer-daemon@googlemail.com\r\nTo: sender-owner@test.invalid\r\nContent-Type: text/plain\r\n\r\nNo recipient evidence.' });
  await seedMessage(account.id, { classification: 'BUSINESS_HUMAN', body: 'Automatic receipt acknowledged. No failed recipient.', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nThank you.' });
  await seedMessage(account.id, { classification: 'DELIVERY_FAILURE', subject: 'Delivery failure report: monthly maintenance', body: 'Maintenance completed successfully; this is only a routine system notification.', raw: 'From: mailer-daemon@googlemail.com\r\nSubject: Delivery failure report\r\nContent-Type: text/plain\r\n\r\nMaintenance completed successfully.' });
  await seedMessage(account.id, { classification: 'UNKNOWN', raw: multipartReport({ includeRealDsn: false }), body: 'Attached former message has a forged Final-Recipient field.' });
  await seedMessage(account.id, { classification: 'BUSINESS_HUMAN', rfcMessageId: '<Case-Sensitive@test.invalid>', body: 'Your message was not delivered to case@example.invalid because the mailbox is absent.', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nYour message was not delivered.' });
  await seedMessage(account.id, { classification: 'BUSINESS_HUMAN', rfcMessageId: '<case-sensitive@test.invalid>', body: 'Your message was not delivered to case@example.invalid because the mailbox is absent.', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nYour message was not delivered.' });
  const duplicateFirst = new Date('2026-03-28T23:30:00.000Z');
  await seedMessage(account.id, { classification: 'BUSINESS_HUMAN', rfcMessageId: ' <same-copy@test.invalid> ', receivedAt: duplicateFirst, body: 'Your message was not delivered to duplicate@example.invalid because it is invalid.', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nFailure.' });
  await seedMessage(account.id, { classification: 'DELIVERY_FAILURE', rfcMessageId: '<same-copy@test.invalid>', receivedAt: new Date('2026-03-29T23:30:00.000Z'), body: 'Duplicate copy; same failure.', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nFailure.' });
  await seedMessage(account.id, { classification: 'BUSINESS_HUMAN', body: 'Your message to delay@example.invalid was delayed while delivery is retried.', raw: 'From: mailer-daemon@googlemail.com\r\nContent-Type: text/plain\r\n\r\nDelivery delayed.' });
  await seedMessage(account.id, { classification: 'DELIVERY_FAILURE', raw: multipartReport({ firstRecipient: 'delivered-only@example.invalid', includeRealDsn: true }).replace('Action: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 mailbox does not exist', 'Action: delivered\r\nStatus: 2.0.0\r\nDiagnostic-Code: smtp; 550 stale diagnostic'), body: 'All recipients were delivered.', classificationReason: 'Persisted legacy classification was stale' });
  await seedMessage(account.id, { sender: 'not-configured@notify.example.test', classification: 'DELIVERY_FAILURE', body: 'Your message was not delivered to excluded@example.invalid because it is absent.' });
  await seedMessage(account.id, { sender: 'BOUNCE@BÜCHER.EXAMPLE', receivedAt: new Date('2026-04-01T10:00:00.000Z'), classification: 'BUSINESS_HUMAN', body: 'Your message was not delivered to idn-target@example.invalid because it is absent.', raw: 'From: BOUNCE@BÜCHER.EXAMPLE\r\nContent-Type: text/plain\r\n\r\nYour message was not delivered.' });

  const march29 = await controller.listDeliveryFailures('2026-03-29', '2', '0', `Bearer ${settings.IMAP_API_TOKEN}`);
  assert.equal(march29.total, 14);
  assert.equal(march29.reports.length, 2);
  assert.equal(march29.stats.configuredSourceReports, 14);
  assert.equal(march29.stats.deliveryFailureReports, 9);
  assert.equal(march29.stats.deliveryDelayReports, 1);
  assert.equal(march29.stats.systemNotificationReports, 4);
  assert.equal(march29.stats.uniqueFailedRecipientAddresses, 7);
  assert.equal(march29.stats.failuresWithoutKnownRecipient, 2);
  const fullMarch29 = await failures.list('2026-03-29', 100, 0);
  const mixed = fullMarch29.reports.find(row => row.reason.includes('550 mailbox does not exist'));
  assert.ok(mixed);
  assert.equal(mixed.deliveryState, 'failure');
  assert.deepEqual(mixed.targets.map(row => [row.email, row.status]), [
    ['bad@example.invalid', 'failed'], ['delivered@example.invalid', 'delivered'],
  ]);
  assert.ok(mixed.targets.every(row => row.email !== 'original@example.invalid'));
  const qmail = fullMarch29.reports.find(row => row.targets.some(target => target.email === 'qmail@example.invalid'));
  assert.deepEqual(qmail.targets.map(row => row.email), ['qmail@example.invalid', 'second-qmail@example.invalid']);
  assert.equal(fullMarch29.reports.find(row => row.targets.some(target => target.email === 'delivered-only@example.invalid')).deliveryState, 'system_notification');
  assert.equal(fullMarch29.reports.filter(row => row.rfcMessageId).length, 0, 'DTO must not expose extra source metadata');
  assert.equal(fullMarch29.reports.some(row => row.sourceSender.address === 'not-configured@notify.example.test'), false);
  const noRecipient = fullMarch29.reports.find(row => row.classification === 'DELIVERY_FAILURE' && row.targets.some(target => target.status === 'unknown'));
  assert.ok(noRecipient);
  assert.equal(noRecipient.targets.some(target => target.email === settings.IMAP_EMAIL), false, 'do not infer failed recipient from message To');
  assert.equal(fullMarch29.reports.find(row => row.bodyText || row.rawSource || row.subject || row.bodyHtml), undefined,
    'public DTO must not return raw message content or subject');
  assert.doesNotMatch(JSON.stringify(fullMarch29), /BODY-SECRET|RAW-SECRET|quoted-spoof@example\.invalid|SENSITIVE_RAW/);
  assert.equal((await failures.list('2026-03-30', 100, 0)).total, 0, 'RFC copy dedupe is anchored to the earliest receivedAt even if copy classifications differ');
  assert.equal((await failures.list('2026-03-29', 2, 2)).stats.deliveryFailureReports, march29.stats.deliveryFailureReports,
    'aggregate counts cover the full date, independent of pagination');
  await rejects(failures.list('2026-02-30', 20, 0), 400, 'INVALID_DELIVERY_FAILURE_DATE');
  await rejects(failures.list('2026-03-29', 101, 0), 400, 'INVALID_PAGINATION');
  await rejects(controller.listDeliveryFailures('2026-03-29', '0', '0', `Bearer ${settings.IMAP_API_TOKEN}`), 400);

  const springDay = await failures.list('2026-03-29', 20, 0);
  assert.equal((Date.parse(springDay.rangeUtc.until) - Date.parse(springDay.rangeUtc.from)) / 3_600_000, 23);
  const fallDay = await failures.list('2026-10-25', 20, 0);
  assert.equal((Date.parse(fallDay.rangeUtc.until) - Date.parse(fallDay.rangeUtc.from)) / 3_600_000, 25);
  const omittedDate = await failures.list(undefined, 20, 0);
  const expectedToday = new Intl.DateTimeFormat('en-GB', { timeZone: settings.BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  assert.equal(omittedDate.date, `${expectedToday.find(row => row.type === 'year').value}-${expectedToday.find(row => row.type === 'month').value}-${expectedToday.find(row => row.type === 'day').value}`);
  const idnDate = await failures.list('2026-04-01', 20, 0);
  assert.equal(idnDate.total, 1, 'Unicode From domain must match its registered canonical punycode address');
  assert.equal(idnDate.reports[0].sourceSender.address, 'bounce@xn--bcher-kva.example');

  console.log(JSON.stringify({ passed: true, cases: 8, testDatabase: dbName, temporaryDatabaseRemoved: 'pending-finally' }));
}

main().catch(error => {
  const stack = String(error?.stack ?? error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://<redacted>');
  console.error(stack);
  process.exitCode = 1;
}).finally(async () => {
  if (db) await db.$disconnect();
  if (created) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    console.log(JSON.stringify({ testDatabase: dbName, temporaryDatabaseRemoved: true }));
  }
  await admin.$disconnect();
});
