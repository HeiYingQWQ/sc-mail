#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const arguments_ = process.argv.slice(2); if (arguments_[0] === '--') arguments_.shift();
const destination = resolve(arguments_[0] || `backups/ai-mail-${stamp}.dump`);
const temporary = `${destination}.partial-${randomUUID()}`;
const localDocker = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
const docker = process.env.DOCKER_BIN || (localDocker && process.platform === 'win32' ? localDocker : 'docker');

await mkdir(dirname(destination), { recursive: true });
let reserved = false;
let completed = false;
const target = await open(destination, 'wx', 0o600);
reserved = true;
await target.close();
const child = spawn(docker, ['compose', 'exec', '-T', 'postgres', 'sh', '-lc', 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
const ended = new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? resolveExit() : reject(new Error(`docker pg_dump exited with ${code}`)));
});
try {
  await Promise.all([pipeline(child.stdout, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })), ended]);
  await copyFile(temporary, destination);
  completed = true;
  await unlink(temporary);
  process.stdout.write(`Backup written: ${destination}\n`);
} catch (error) {
  child.kill();
  await unlink(temporary).catch(() => undefined);
  if (reserved && !completed) await unlink(destination).catch(() => undefined);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
