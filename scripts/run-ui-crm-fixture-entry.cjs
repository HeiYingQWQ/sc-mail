/* Refresh generated Prisma Client from the mounted schema before loading the fixture server. */
const { execFileSync } = require('node:child_process');

execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'generate'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

require('./ui-crm-acceptance.cjs');
