#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { operation, postgresRunner } from './backup-runtime.mjs';

export async function backup(destination, options = {}) {
  destination = resolve(destination);
  const temporary = `${destination}.partial-${randomUUID()}`;
  const run = options.run || postgresRunner();
  const op = operation('backup', options);
  let reserved = false, completed = false;
  try {
    await mkdir(dirname(destination), { recursive: true });
    const reservation = await open(destination, 'wx', 0o600);
    reserved = true; await reservation.close();
    op.phase('writing custom-format dump');
    const meter = op.meter();
    const tasks = [
      run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges'], { output: meter, op }),
      pipeline(meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: op.signal }),
    ];
    try { await Promise.all(tasks); }
    catch (error) { op.abort(); meter.destroy(); await Promise.allSettled(tasks); throw error; }
    op.signal.throwIfAborted();
    await rename(temporary, destination);
    completed = true;
    op.phase('complete');
    return destination;
  } finally {
    op.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (reserved && !completed) await unlink(destination);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  if (args.length > 1) { process.stderr.write('Usage: pnpm backup -- [output.dump]\n'); process.exitCode = 1; }
  else try { const path = await backup(args[0] || `backups/ai-mail-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`); process.stdout.write(`Backup written: ${path}\n`); }
  catch { process.stderr.write('Backup failed or timed out; no completed backup was published.\n'); process.exitCode = 1; }
}
