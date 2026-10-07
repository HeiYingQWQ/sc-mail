const { execFileSync } = require('node:child_process');

execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'generate', '--schema', 'prisma/schema.prisma'], { stdio: 'inherit' });
require('./acceptance.cjs');
