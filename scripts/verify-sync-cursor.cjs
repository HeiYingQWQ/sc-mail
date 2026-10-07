const assert = require('node:assert/strict');
const {
  buildUidSearchRange,
  nextCheckpointUid,
  uidValidityChanged,
} = require('../dist/modules/mail/sync-cursor.policy.js');

assert.equal(buildUidSearchRange(0, 25), '1:25');
assert.equal(buildUidSearchRange(25, 25), null);
assert.equal(nextCheckpointUid(true, 20, 25), 20);
assert.equal(nextCheckpointUid(false, 24, 25), 25);
assert.equal(uidValidityChanged(42n, 43n), true);
assert.equal(uidValidityChanged(42n, 42n), false);
assert.equal(uidValidityChanged(null, 42n), false);
process.stdout.write('M5 UID cursor fixture checks passed\n');
