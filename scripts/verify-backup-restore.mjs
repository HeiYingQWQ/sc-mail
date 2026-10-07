#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localDocker = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
const docker = process.env.DOCKER_BIN || (localDocker && process.platform === 'win32' ? localDocker : 'docker');
const restoreDb = `aimail_restore_check_${Date.now()}`;
let created = false;

function quoteShell(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(docker, ['compose', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolveRun(output.trim()) : reject(new Error(`docker compose exited with ${code}`)));
  });
}

function runCopy(command, db, stdin = 'ignore') {
  return spawn(docker, ['compose', 'exec', '-T', '-e', `RESTORE_DB=${db}`, 'postgres', 'sh', '-lc', command], { cwd: root, stdio: [stdin, 'pipe', 'inherit'] });
}

async function pipeDumpToRestore() {
  const dump = runCopy('pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"', restoreDb);
  const restore = runCopy('pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d "$RESTORE_DB"', restoreDb, 'pipe');
  const dumpDone = new Promise((resolveDone, reject) => { dump.once('error', reject); dump.once('close', (code) => code === 0 ? resolveDone() : reject(new Error(`pg_dump exited with ${code}`))); });
  const restoreDone = new Promise((resolveDone, reject) => { restore.once('error', reject); restore.once('close', (code) => code === 0 ? resolveDone() : reject(new Error(`pg_restore exited with ${code}`))); });
  try { await Promise.all([pipeline(dump.stdout, restore.stdin), dumpDone, restoreDone]); }
  catch (error) { dump.kill(); restore.kill(); throw error; }
}

async function counts(db) {
  const sql = `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'), (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), (SELECT count(*) FROM "EmailMessage"), (SELECT count(*) FROM "AgentEvent")`;
  const output = await run(['exec', '-T', '-e', `RESTORE_DB=${restoreDb}`, 'postgres', 'sh', '-lc', `psql -U "$POSTGRES_USER" -d "$${db === 'source' ? 'POSTGRES_DB' : 'RESTORE_DB'}" -A -t -F ',' -c ${quoteShell(sql)}`]);
  return output.split(',').map(Number);
}

try {
  await run(['exec', '-T', '-e', `RESTORE_DB=${restoreDb}`, 'postgres', 'sh', '-lc', 'createdb -U "$POSTGRES_USER" "$RESTORE_DB"']);
  created = true;
  const sourceCounts = await counts('source');
  await pipeDumpToRestore();
  const restoredCounts = await counts('restore');
  if (sourceCounts.some((value, index) => value !== restoredCounts[index]) || restoredCounts[1] < 1) throw new Error(`Restore verification mismatch: source=${sourceCounts.join(',')} restored=${restoredCounts.join(',')}`);
  process.stdout.write(`Backup/restore drill passed in disposable database ${restoreDb}; tables/migrations/mail/events=${restoredCounts.join('/')}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (created) {
    try { await run(['exec', '-T', '-e', `RESTORE_DB=${restoreDb}`, 'postgres', 'sh', '-lc', 'dropdb -U "$POSTGRES_USER" "$RESTORE_DB"']); }
    catch (error) { process.stderr.write(`Could not drop disposable restore database ${restoreDb}: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
  }
}
