#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { operation, postgresRunner } from './backup-runtime.mjs';

export async function verifyBackup(file, options = {}) {
  if (!file) throw new Error('A saved custom-format backup file is required');
  if (process.env.BACKUP_RESTORE_ALLOW_LOCAL_DB_CREATE !== '1') throw new Error('Set BACKUP_RESTORE_ALLOW_LOCAL_DB_CREATE=1 to authorize a disposable database');
  const database = `aimail_restore_check_${randomUUID().replaceAll('-', '')}`;
  const run = options.run || postgresRunner();
  const op = operation('restore', options);
  let handle, created = false;
  try {
    handle = await open(resolve(file), 'r');
    const stat = await handle.stat();
    const magic = Buffer.alloc(5); await handle.read(magic, 0, 5, 0);
    if (!stat.isFile() || magic.toString() !== 'PGDMP') throw new Error('Expected a PostgreSQL custom-format backup');
    const stream = () => handle.createReadStream({ start: 0, autoClose: false });
    op.phase('hashing saved file');
    const hash = createHash('sha256');
    await pipeline(stream(), op.meter(), new Writable({ write(chunk, _encoding, done) { hash.update(chunk); done(); } }), { signal: op.signal });
    const sha256 = hash.digest('hex');
    op.phase('checking archive');
    await run('pg_restore', ['--list'], { input: stream(), output: new Writable({ write(_chunk, _encoding, done) { done(); } }), op });
    op.phase('creating isolated database');
    try { await run('createdb', ['--template=template0', database], { op }); created = true; }
    catch { throw new Error(`Database creation failed or outcome unknown; inspect only ${database}`); }
    op.phase('restoring saved file');
    await run('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--dbname', database], { database, input: stream(), op });
    op.phase('checking restored application tables');
    const sql = `SELECT json_build_object('migrations', (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), 'mail', (SELECT count(*) FROM "EmailMessage"), 'rawMail', (SELECT count(*) FROM "EmailMessage" WHERE "rawSource" IS NOT NULL), 'contacts', (SELECT count(*) FROM "Contact"), 'projects', (SELECT count(*) FROM "Project"), 'tasks', (SELECT count(*) FROM "Task"), 'events', (SELECT count(*) FROM "AgentEvent"), 'notifications', (SELECT count(*) FROM "NotificationDelivery"))`;
    const counts = JSON.parse(await run('psql', ['-X', '--set=ON_ERROR_STOP=1', '-At', '-c', sql], { database, op }));
    if (!counts.migrations || Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid restored application schema');
    if (options.validate) await options.validate({ database, run, op, counts });
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Backup file changed during verification');
    op.phase('verification complete');
    return { sha256, bytes: stat.size, counts };
  } finally {
    op.close();
    await handle?.close();
    if (created) {
      const cleanup = operation('restore cleanup', { timeoutMs: 30000 });
      try { await run('dropdb', ['--force', database], { op: cleanup }); }
      catch { throw new Error(`Cleanup failed; remove only disposable database ${database}`); }
      finally { cleanup.close(); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  try {
    if (args.length !== 1) throw new Error('Usage: pnpm verify:backup-restore -- <saved.dump>');
    const report = await verifyBackup(args[0]);
    process.stdout.write(`${JSON.stringify(report)}\nSaved-file restore verified; application/channel disaster recovery remains a separate acceptance.\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
