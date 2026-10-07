const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const policy = require('../dist/modules/mail/project-review.policy.js');
const { GATE_CLASSES } = require('../dist/modules/mail/business-gate.rules.js');

assert.equal(policy.normalizeResolverText('  Atlas—Rebuild '), 'atlas rebuild');
assert.equal(policy.matchUniqueNamedEntity, undefined, 'subject/name heuristics must not choose a project');
assert.equal(policy.canResolveAutomatically, undefined, 'only explicit human review or content analysis may assign projects');
assert.equal(policy.reviewDedupeKey('email_message', 'm1', 'PROJECT_UNRESOLVED', 'm1'),
  policy.reviewDedupeKey('email_message', 'm1', 'PROJECT_UNRESOLVED', 'm1'));
assert.equal(policy.stableReviewProposal({ b: 2, a: 1 }), policy.stableReviewProposal({ a: 1, b: 2 }));
assert.deepEqual(policy.nextReviewCycle({ cycle: 2, status: 'dismissed', proposedChangeJson: { projectId: 'p1' }, confidence: 0.5 }, { projectId: 'p1' }, 0.5), { action: 'reuse', cycle: 2 });
assert.deepEqual(policy.nextReviewCycle({ cycle: 2, status: 'dismissed', proposedChangeJson: { projectId: 'p1' }, confidence: 0.5 }, { projectId: 'p2' }, 0.6), { action: 'create', cycle: 3 });
assert.deepEqual(policy.nextReviewCycle({ cycle: 2, status: 'pending', proposedChangeJson: { projectId: 'p1' }, confidence: 0.5 }, { projectId: 'p2' }, 0.6), { action: 'update', cycle: 2 });
assert.deepEqual(policy.chooseMergeCompany('company-a', 'company-b'), { ok: false, companyId: null });
assert.deepEqual(policy.chooseMergeCompany('company-a', null), { ok: true, companyId: 'company-a' });
assert.deepEqual(policy.planContactEmailMerge([{ id: 'a', email: 'A@example.com' }, { id: 'b', email: 'b@example.com' }], ['a@example.com']), { deleteIds: ['a'], moveIds: ['b'] });
assert(GATE_CLASSES.includes('BUSINESS_HUMAN'));
assert(GATE_CLASSES.includes('UNKNOWN'));
assert(!GATE_CLASSES.includes('EXECUTE_TOOL'));

const source = readFileSync(resolve(__dirname, '../apps/backend/src/modules/mail/project-review.service.ts'), 'utf8');
assert.doesNotMatch(source, /matchUniqueNamedEntity|canResolveAutomatically|resolveMessage\(/,
  'recovery must not infer project or topic from names, subjects, or threads');
assert.doesNotMatch(source, /action\s*===\s*['"]confirm_contact['"]/, 'legacy provisional contacts are not promoted from confirmation reviews');

process.stdout.write('Manual project review policy checks passed\n');
