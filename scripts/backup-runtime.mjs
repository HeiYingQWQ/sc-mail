import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve } from 'node:path';

export function positiveInteger(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new Error('Invalid positive timeout/interval');
  return number;
}

// One deadline for the whole operation, including streams.
export function operation(label, { timeoutMs = positiveInteger(process.env.BACKUP_TIMEOUT_MS, 900000), progressMs = positiveInteger(process.env.BACKUP_PROGRESS_MS, 5000) } = {}) {
  const controller = new AbortController();
  const started = Date.now();
  let bytes = 0, phase = 'starting';
  const report = () => process.stderr.write(`[${label}] ${phase}; ${bytes} bytes; ${Math.floor((Date.now() - started) / 1000)}s\n`);
  const timer = setTimeout(() => controller.abort(new Error('Operation deadline exceeded')), timeoutMs);
  const progress = setInterval(report, progressMs);
  const cancel = () => controller.abort(new Error('Operation cancelled'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  return {
    signal: controller.signal,
    remainingSeconds() { return Math.max(1, Math.ceil((timeoutMs - (Date.now() - started)) / 1000)); },
    abort() { controller.abort(new Error('Operation failed')); },
    phase(value) { phase = value; report(); },
    meter() { return new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(null, chunk); } }); },
    close() { clearTimeout(timer); clearInterval(progress); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); },
  };
}

export function postgresRunner() {
  const native = process.env.BACKUP_PG_MODE === 'native';
  const container = process.env.BACKUP_PG_MODE === 'container';
  if (process.env.BACKUP_PG_MODE && !['native', 'compose', 'container'].includes(process.env.BACKUP_PG_MODE)) throw new Error('Unsupported BACKUP_PG_MODE');
  if (container && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(process.env.BACKUP_PG_CONTAINER || '')) throw new Error('An explicit PostgreSQL container is required');
  let env = { ...process.env };
  if (native) {
    const url = new URL(process.env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Native backup tools require a loopback PostgreSQL server');
    env = { ...env, PGHOST: url.hostname.replace(/[\[\]]/g, ''), PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '10' };
    delete env.DATABASE_URL;
  }
  return async function run(tool, args, { database, input, output, op } = {}) {
    op.signal.throwIfAborted();
    let command, parameters, childEnv = { ...env };
    if (native) {
      command = process.env.BACKUP_PG_BIN ? resolve(process.env.BACKUP_PG_BIN, tool + (process.platform === 'win32' ? '.exe' : '')) : tool;
      parameters = args;
      if (database) childEnv.PGDATABASE = database;
    } else {
      command = process.env.DOCKER_BIN || (process.platform === 'win32' ? resolve(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : 'docker');
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      // Bound the server-side exec too: killing the Docker client alone need not stop it.
      parameters = [...(container ? ['exec', '-i', process.env.BACKUP_PG_CONTAINER] : ['compose', 'exec', '-T', 'postgres']), 'sh', '-lc', `export PGUSER="$POSTGRES_USER" PGDATABASE=${database ? quote(database) : '"$POSTGRES_DB"'} PGCONNECT_TIMEOUT=10; exec timeout -s KILL ${op.remainingSeconds()}s ${[tool, ...args].map(quote).join(' ')}`];
    }
    return runProcess(command, parameters, { env: childEnv, input, output, op,
      allowEarlyInputClose: tool === 'pg_restore' && args.length === 1 && args[0] === '--list' });
  };
}

// pg_restore --list can exit successfully after its TOC without consuming data blocks.
// Only that command may tolerate an early stdin close, and only after confirmed exit 0.
export async function runProcess(command, parameters, { env = process.env, input, output, op, allowEarlyInputClose = false }) {
  const transport = new AbortController();
  const signal = AbortSignal.any([op.signal, transport.signal]);
  signal.throwIfAborted();
  const child = spawn(command, parameters, { env, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
  child.stderr.resume();
  let result = '', overflow = false, processError;
  if (!output) child.stdout.on('data', chunk => { if (result.length < 1024 * 1024) result += chunk; else overflow = true; });
  const ended = new Promise((resolveExit, reject) => {
    child.once('error', error => { processError = error; });
    // Wait for close, including after spawn/abort errors, before releasing streams/files.
    child.once('close', code => code === 0 && !overflow && !processError ? resolveExit() : reject(new Error(op.signal.aborted ? 'Operation timed out or cancelled' : 'PostgreSQL command failed (exit ' + (code ?? 'unknown') + ')')));
  }).catch(error => { transport.abort(); throw error; });
  const earlyClose = error => allowEarlyInputClose && ['EPIPE', 'EOF', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code);
  const inputDone = input ? pipeline(input, op.meter(), child.stdin, { signal }).catch(error => {
    if (!earlyClose(error)) transport.abort();
    throw error;
  }) : Promise.resolve();
  const outputDone = output ? pipeline(child.stdout, output, { signal }).catch(error => {
    transport.abort(); throw error;
  }) : Promise.resolve();
  const [processResult, inputResult, outputResult] = await Promise.allSettled([ended, inputDone, outputDone]);
  if (processResult.status === 'rejected') throw processResult.reason;
  if (outputResult.status === 'rejected') throw outputResult.reason;
  if (inputResult.status === 'rejected' && !earlyClose(inputResult.reason)) throw inputResult.reason;
  op.signal.throwIfAborted();
  return result.trim();
}
