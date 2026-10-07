const assert = require('node:assert/strict');
const {
  emailDomain,
  isPublicEmailDomain,
  knownCompanyForEmail,
  normalizeEmail,
  resolveContactMapping,
} = require('../dist/modules/mail/contact-resolver.policy.js');

assert.equal(normalizeEmail('  Elena@Example.COM  '), 'elena@example.com');
assert.equal(emailDomain('elena@example.com'), 'example.com');
assert.equal(isPublicEmailDomain('gmail.com'), true);

// A domain match is never a company relationship; only the selected contact link is.
assert.equal(knownCompanyForEmail('lee@acme.example', null, 'domain-company'), null);
assert.equal(knownCompanyForEmail('lee@gmail.com', 'selected-company', null), 'selected-company');

const confirmed = resolveContactMapping({
  id: 'known-contact', status: 'confirmed', companyId: 'selected-company', confidence: 0.25, verified: true,
}, 'domain-company');
assert.equal(confirmed.status, 'matched');
assert.equal(confirmed.confidence, 1);
assert.equal(confirmed.companyId, 'selected-company');

for (const mapping of [null, {
  id: 'legacy-auto-contact', status: 'provisional', companyId: 'domain-company', confidence: 0.25, verified: false,
}]) {
  const result = resolveContactMapping(mapping, 'domain-company');
  assert.equal(result.status, 'unresolved');
  assert.equal(result.confidence, 0);
  assert.equal(result.companyId, null);
  assert.match(result.reason, /no contact is created/i);
}

process.stdout.write('Manual CRM contact resolver policy checks passed\n');
