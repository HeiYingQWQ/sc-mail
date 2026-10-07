const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EmailNormalizer } = require('../dist/modules/mail/email-normalizer.js');

async function main() {
  const fixturePath = path.resolve(
    'apps/backend/src/modules/mail/fixtures/self-addressed.eml',
  );
  const rawSource = fs.readFileSync(fixturePath);
  const normalized = await new EmailNormalizer().normalize({
    mailbox: 'INBOX',
    uidValidity: 12n,
    uid: 8,
    rawSource,
    receivedAt: new Date('2026-09-24T10:15:02.000Z'),
    accountEmail: 'mailbox@example.test',
  });

  assert.equal(normalized.subject, 'M3 normalizer fixture');
  assert.equal(normalized.direction, 'internal');
  assert.equal(normalized.threadId, '<fixture-root@example.test>');
  assert.equal(normalized.bodyText, 'Fixture message body.');
  assert.equal(Buffer.from(normalized.rawSource).equals(rawSource), true);
  const htmlOnly = Buffer.from('From: client@example.test\r\nTo: mailbox@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n\r\n--fixture\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello &amp; welcome</p><script>unsafe()</script><img src="https://example.test/tracker">\r\n--fixture--');
  const fallback = await new EmailNormalizer().normalize({ mailbox: 'INBOX', uidValidity: 12n, uid: 9, rawSource: htmlOnly, receivedAt: null, accountEmail: 'mailbox@example.test' });
  assert.equal(fallback.bodyText, 'Hello & welcome');
  assert.ok(fallback.bodyHtml.includes('<p>'));
  assert.equal(Buffer.from(fallback.rawSource).equals(htmlOnly), true);
  const { readableEmailBody } = require('../dist/modules/mail/email-body.js');
  assert.equal(readableEmailBody('Original text', '<p>Other text</p>'), 'Original text');
  assert.equal(readableEmailBody(null, null), null);
  process.stdout.write('M3 fixture normalization passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
