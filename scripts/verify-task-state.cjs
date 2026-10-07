const assert = require('node:assert/strict');
const { deriveProjectState } = require('../dist/modules/mail/project-state.policy.js');
const { nextWaitingSince } = require('../dist/modules/mail/task-waiting.policy.js');

const mixed = deriveProjectState([
  { status: 'open', kind: 'action', ownerType: 'us', waitingOn: 'none', deadlineAt: new Date('2026-10-03T00:00:00Z') },
  { status: 'open', kind: 'action', ownerType: 'customer', waitingOn: 'none', deadlineAt: new Date('2026-10-02T00:00:00Z') },
  { status: 'open', kind: 'reply', ownerType: 'us', waitingOn: 'none', deadlineAt: null },
]);
assert.equal(mixed.waitingOn, 'mixed');
assert.deepEqual(mixed.waitingParties, ['customer', 'us']);
assert.equal(mixed.replyRequired, true);
assert.equal(mixed.followUpAt.toISOString(), '2026-10-02T00:00:00.000Z');

const blocked = deriveProjectState([
  { status: 'waiting', kind: 'reply', ownerType: 'us', waitingOn: 'customer', deadlineAt: null },
]);
assert.equal(blocked.waitingOn, 'customer');
assert.deepEqual(blocked.waitingParties, ['customer']);
assert.equal(blocked.replyRequired, false);

const firstWait = new Date('2026-09-29T10:00:00Z');
const nextWait = new Date('2026-09-30T10:00:00Z');
assert.equal(nextWaitingSince({ status: 'open', waitingOn: 'none', waitingSince: null }, { status: 'waiting', waitingOn: 'customer' }, firstWait).toISOString(), firstWait.toISOString());
assert.equal(nextWaitingSince({ status: 'waiting', waitingOn: 'customer', waitingSince: firstWait }, { status: 'waiting' }, nextWait).toISOString(), firstWait.toISOString());
assert.equal(nextWaitingSince({ status: 'waiting', waitingOn: 'customer', waitingSince: firstWait }, { waitingOn: 'third_party' }, nextWait).toISOString(), nextWait.toISOString());
assert.equal(nextWaitingSince({ status: 'waiting', waitingOn: 'customer', waitingSince: firstWait }, { status: 'in_progress' }, nextWait), null);
assert.equal(nextWaitingSince({ status: 'waiting', waitingOn: 'customer', waitingSince: null }, {}, nextWait).toISOString(), nextWait.toISOString());

console.log('M11 task-state and M17 task-waiting fixtures passed');
