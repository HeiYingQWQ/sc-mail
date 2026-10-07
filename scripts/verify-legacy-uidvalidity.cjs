require('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ImapMailService } = require('../dist/modules/mail/imap-mail.service');
const { MailDeletionSyncService } = require('../dist/modules/mail/mail-deletion-sync.service');

function clientFor(options = {}) {
  let searches = 0;
  let released = false;
  const client = {
    mailbox: { uidValidity: 2n, uidNext: 3, exists: 2 },
    getMailboxLock: async () => ({ release() { released = true; } }),
    search: async () => {
      searches++;
      return options.changed && searches === 2 ? [1] : [1, 2];
    },
    fetchAll: async () => options.missing
      ? [{ uid: 1, source: Buffer.from('first') }]
      : [{ uid: 1, source: Buffer.from('first') }, { uid: 2, source: Buffer.from('second') }],
  };
  return { client, released: () => released };
}

async function scan(options) {
  const state = clientFor(options);
  const service = new ImapMailService({}, {}, {});
  service.withStoredAccountClient = async (_accountId, callback) => callback(state.client);
  try { return await service.listMailboxSourceHashes('account', 'INBOX'); }
  finally { assert.equal(state.released(), true); }
}

async function main() {
  const oldRows = [
    { id: 'old-1', rawSource: Buffer.from('first') },
    { id: 'old-2', rawSource: Buffer.from('not-present') },
    { id: 'old-3', rawSource: Buffer.from('first') },
  ];
  const db = {
    mailAccount: { findUnique: async () => ({ id: 'account' }) },
    mailDeletionSyncCheckpoint: { findUnique: async () => null },
    syncCheckpoint: { findMany: async () => [{ mailbox: 'INBOX', uidValidity: 2n, status: 'completed', lastErrorCode: null, reconciliationRequired: false }] },
    emailMessage: {
      groupBy: async () => [{ mailbox: 'INBOX', uidValidity: 1n, _count: { _all: 3 } }],
      findMany: async ({ cursor }) => cursor ? [] : oldRows,
    },
  };
  const settings = { IMAP_EMAIL: 'owner@test', IMAP_HOST: 'imap.test', IMAP_SYNC_FOLDERS: 'INBOX' };
  const config = { get: (key, fallback) => settings[key] ?? fallback };
  const firstHash = createHash('sha256').update('first').digest('hex');
  const remote = { listMailboxSourceHashes: async () => ({ uidValidity: 2n, hashes: new Map([[firstHash, 1]]) }) };
  const audit = new MailDeletionSyncService(config, db, remote, {}, {});
  const result = await scan();
  assert.equal(result.uidValidity, 2n);
  assert.equal(result.scannedCount, 2);
  assert.equal(result.hashes.get(createHash('sha256').update('first').digest('hex')), 1);
  const status = await audit.status();
  assert.equal(status.legacyNamespace.unverifiedCount, 3);
  const compared = await audit.auditLegacyNamespace();
  assert.equal(compared.legacyCount, 3);
  assert.equal(compared.exactRawMatchCount, 1);
  assert.equal(compared.noExactMatchCount, 2);
  remote.listMailboxSourceHashes = async () => ({ uidValidity: 3n, hashes: new Map() });
  await assert.rejects(audit.auditLegacyNamespace(), (error) => error.getStatus() === 503);
  await assert.rejects(scan({ missing: true }), /INCOMPLETE_IMAP_SNAPSHOT/);
  await assert.rejects(scan({ changed: true }), /MAILBOX_CHANGED_DURING_AUDIT/);
  console.log('PASS legacy UIDVALIDITY source fingerprint safety');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
