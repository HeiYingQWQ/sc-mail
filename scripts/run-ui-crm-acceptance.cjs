/* Build the current backend fixture and run it as a disposable Compose container. */
const { spawnSync } = require('node:child_process');
const { createServer } = require('node:net');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const docker = process.env.DOCKER_BIN || (process.platform === 'win32' && process.env.LOCALAPPDATA
  ? resolve(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe')
  : 'docker');

function run(label, command, args, options = {}) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 1}`);
}

async function assertFixturePortAvailable() {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', (error) => reject(new Error(`127.0.0.1:3001 is unavailable: ${error.message}`)));
    server.listen(3001, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolvePromise()));
  });
}

async function main() {
  if (process.env.UI_CRM_ALLOW_LOCAL_DB_CREATE !== '1') {
    throw new Error('Set UI_CRM_ALLOW_LOCAL_DB_CREATE=1 after reviewing the isolated local database lifecycle.');
  }
  await assertFixturePortAvailable();

  if (process.env.UI_CRM_SKIP_BUILD === '1') {
    for (const required of [
      'dist/modules/mail/mail.controller.js',
      'dist/modules/mail/project-analysis.controller.js',
      'dist/modules/auth/auth.controller.js',
    ]) {
      if (!require('node:fs').existsSync(resolve(root, required))) throw new Error(`UI_CRM_SKIP_BUILD=1 requires current compiled file ${required}.`);
    }
    console.log('Using the current compiled worktree and existing backend image; container entry generates Prisma client from the mounted schema.');
  } else {
    run('Generate Prisma client', process.execPath, ['node_modules/prisma/build/index.js', 'generate']);
    run('Compile Nest backend', process.execPath, ['node_modules/@nestjs/cli/bin/nest.js', 'build']);
    console.log('Reusing the existing backend image; its runtime dependencies are mounted separately from current source and schema.');
  }

  const volumes = [
    ['dist', '/app/dist'],
    ['scripts', '/app/scripts'],
    ['prisma', '/app/prisma'],
    ['apps/dashboard', '/app/apps/dashboard'],
  ];
  const args = ['compose', 'run', '--rm', '--no-deps', '-T', '-p', '127.0.0.1:3001:3000'];
  for (const [source, target] of volumes) args.push('--volume', `${resolve(root, source)}:${target}:ro`);
  for (const [key, value] of Object.entries({
    UI_CRM_ALLOW_LOCAL_DB_CREATE: '1',
    UI_CRM_RUN_CLI_SUITE: process.env.UI_CRM_RUN_CLI_SUITE === '1' ? '1' : '0',
    APP_ROLE: 'ui_fixture',
    PORT: '3000',
    AI_PROVIDER: 'fixture',
    OPENAI_API_KEY: '',
    TELEGRAM_BOT_TOKEN: '',
    AGENT_WEBHOOK_TOKEN: '',
    AGENT_EVENT_WEBHOOK_URL: '',
    AGENT_CHAT_WEBHOOK_URL: '',
    OPENCLAW_WHATSAPP_NOTIFY_URL: '',
    IMAP_HOST: '',
    IMAP_EMAIL: '',
    IMAP_USERNAME: '',
    IMAP_PASSWORD: '',
    IMAP_API_TOKEN: '',
    DASHBOARD_INITIAL_EMAIL: '',
    DASHBOARD_INITIAL_PASSWORD: '',
    MAIL_RECONCILIATION_ENABLED: 'false',
    MAIL_DELETION_SYNC_ENABLED: 'false',
    DAILY_BRIEF_ENABLED: 'false',
  })) args.push('--env', `${key}=${value}`);
  args.push('--entrypoint', 'node', 'backend', '/app/scripts/run-ui-crm-fixture-entry.cjs');

  console.log('\nThe test server will be available only through 127.0.0.1:3001. Press Ctrl+C to stop it and drop its uniquely named fixture database.');
  run('Start browser fixture', docker, args);
}

main().catch((error) => {
  console.error(`UI CRM acceptance runner stopped: ${error.message}`);
  process.exitCode = 1;
});
