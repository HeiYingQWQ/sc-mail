#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docker = process.env.DOCKER_BIN || (process.platform === 'win32'
  ? resolve(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : 'docker');
// Only compiled code and synthetic fixtures are mounted. The harness creates its own database.
const child = spawn(docker, ['compose', 'run', '--rm', '--no-deps', '-T',
  '--volume', `${resolve(root, 'dist')}:/app/dist:ro`,
  '--volume', `${resolve(root, 'scripts')}:/app/scripts:ro`,
  '--volume', `${resolve(root, 'prisma')}:/app/prisma:ro`,
  '--entrypoint', 'node', 'backend', '/app/scripts/run-acceptance.cjs'], { cwd: root, stdio: 'inherit' });
child.on('error', () => { console.error('Could not start Docker acceptance container'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
