import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { backup } from './backup.mjs';
import { verifyBackup } from './verify-backup-restore.mjs';
import { positiveInteger, postgresRunner, runProcess, operation } from './backup-runtime.mjs';

const dir = await mkdtemp(join(tmpdir(), 'sc-mail-backup-unit-'));
process.env.BACKUP_RESTORE_ALLOW_LOCAL_DB_CREATE = '1';
let passed = 0;
async function test(name, body) { await body(); passed++; console.log(`ok ${name}`); }
const data = Buffer.from('PGDMPsynthetic-archive');
const dump = async (_tool, _args, { output, op }) => pipeline(Readable.from([data]), output, { signal: op.signal });
try {
  await test('saved bytes and refusal to overwrite existing backup', async () => {
    const path = join(dir, 'saved.dump'); await backup(path, { run: dump });
    assert.deepEqual(await readFile(path), data);
    await assert.rejects(backup(path, { run: dump }), /EEXIST/);
    assert.deepEqual(await readFile(path), data);
  });
  await test('failed dump removes partial and reservation', async () => {
    await assert.rejects(backup(join(dir, 'failed.dump'), { run: async (_t, _a, { output }) => { output.end('partial'); throw new Error('dump failed'); } }));
    assert.deepEqual(await readdir(dir), ['saved.dump']);
  });
  await test('stalled dump deadline and progress', async () => {
    const messages = []; const saved = process.stderr.write;
    process.stderr.write = text => { messages.push(String(text)); return true; };
    try {
      await assert.rejects(backup(join(dir, 'timeout.dump'), { timeoutMs: 500, progressMs: 10, run: async (_t, _a, { op }) => new Promise((_, reject) => op.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) }));
    } finally { process.stderr.write = saved; }
    assert.ok(messages.length >= 2); assert.ok(messages.some(value => value.includes('bytes')));
    assert.deepEqual(await readdir(dir), ['saved.dump']);
  });
  await test('saved-file restore reads exact bytes, reports digest and cleans its database', async () => {
    const calls = [];
    const run = async (tool, args, options) => {
      calls.push({ tool, args, database: options.database });
      if (options.input) { const chunks = []; for await (const chunk of options.input) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), data); }
      if (tool === 'psql') return JSON.stringify({ migrations: 27, mail: 1 });
    };
    const result = await verifyBackup(join(dir, 'saved.dump'), { run });
    assert.equal(result.sha256.length, 64);
    assert.equal(calls.filter(c => c.tool === 'pg_dump').length, 0);
    assert.deepEqual(calls.map(c => c.tool), ['pg_restore', 'createdb', 'pg_restore', 'psql', 'dropdb']);
    assert.equal(calls[4].args[1], calls[1].args[1]);
    assert.match(calls[1].args[1], /^aimail_restore_check_[a-f0-9]{32}$/);
  });
  await test('failed restore still cleans unique database', async () => {
    let dropped = false;
    await assert.rejects(verifyBackup(join(dir, 'saved.dump'), { run: async (tool, args, { input }) => {
      if (input) for await (const _ of input) { /* consume */ }
      if (tool === 'pg_restore' && args.includes('--dbname')) throw new Error('invalid archive');
      if (tool === 'dropdb') dropped = true;
    } }), /invalid archive/);
    assert.equal(dropped, true);
  });
  await test('missing path and corrupt magic fail before database access', async () => {
    await writeFile(join(dir, 'invalid.dump'), 'invalid');
    const run = async () => assert.fail('must not reach PostgreSQL');
    await assert.rejects(verifyBackup(undefined, { run }));
    await assert.rejects(verifyBackup(join(dir, 'missing.dump'), { run }));
    await assert.rejects(verifyBackup(join(dir, 'invalid.dump'), { run }));
  });
  await test('restore deadline retains independent cleanup budget', async () => {
    let dropped = false;
    await assert.rejects(verifyBackup(join(dir, 'saved.dump'), { timeoutMs: 500, progressMs: 20, run: async (tool, args, { input, op }) => {
      if (input) for await (const _ of input) { /* consume */ }
      op.signal.throwIfAborted();
      if (tool === 'pg_restore' && args.includes('--dbname')) await new Promise((_, reject) => op.signal.addEventListener('abort', () => reject(new Error('restore timeout')), { once: true }));
      if (tool === 'dropdb') { assert.equal(op.signal.aborted, false); dropped = true; }
    } }), /restore timeout/);
    assert.equal(dropped, true);
  });
  await test('cleanup failure is reported, not passed', async () => {
    await assert.rejects(verifyBackup(join(dir, 'saved.dump'), { run: async (tool, _args, { input }) => {
      if (input) for await (const _ of input) { /* consume */ }
      if (tool === 'psql') return '{"migrations":27}';
      if (tool === 'dropdb') throw new Error('cleanup unavailable');
    } }), /Cleanup failed; remove only disposable database aimail_restore_check_/);
  });
  const largeInput = () => Readable.from((function* () { for (let i = 0; i < 512; i++) yield Buffer.alloc(65536, 65); })());
  async function processCase(code, extra = {}, timeoutMs = 5000) {
    const op = operation('process fixture', { timeoutMs, progressMs: 1000 });
    try { return await runProcess(process.execPath, ['-e', code], { op, ...extra }); }
    finally { op.close(); }
  }
  await test('TOC-style early successful exit accepts large stdin only when opted in', async () => {
    await processCase("process.stdin.once('data', () => process.exit(0))", { input: largeInput(), allowEarlyInputClose: true });
  });
  await test('ordinary commands reject an early input close', async () => {
    await assert.rejects(processCase("process.stdin.once('data', () => process.exit(0))", { input: largeInput() }));
  });
  await test('TOC-style early close never hides a nonzero process exit', async () => {
    await assert.rejects(processCase("process.stdin.once('data', () => process.exit(2))", { input: largeInput(), allowEarlyInputClose: true }));
  });
  await test('actual child process timeout terminates and settles streams', async () => {
    await assert.rejects(processCase('setInterval(() => {}, 1000)', {}, 250), /timed out/);
  });
  await test('destination failure terminates child and settles streams', async () => {
    const output = new Writable({ write(_chunk, _encoding, done) { done(new Error('synthetic disk failure')); } });
    const started = Date.now();
    await assert.rejects(processCase("setInterval(() => process.stdout.write('x'), 10)", { output }));
    assert.ok(Date.now() - started < 4000, 'failed output must not wait for the operation deadline');
  });
  await test('invalid timeout and remote native target refused', async () => {
    assert.throws(() => positiveInteger('0', 1)); assert.throws(() => positiveInteger('abc', 1));
    const saved = { mode: process.env.BACKUP_PG_MODE, url: process.env.DATABASE_URL };
    process.env.BACKUP_PG_MODE = 'native'; process.env.DATABASE_URL = 'postgresql://test:test@remote.invalid/db';
    try { assert.throws(() => postgresRunner(), /loopback/); }
    finally { for (const [key, value] of [['BACKUP_PG_MODE', saved.mode], ['DATABASE_URL', saved.url]]) value === undefined ? delete process.env[key] : process.env[key] = value; }
  });
  console.log(`Backup unit regressions: ${passed} passed`);
} finally { await rm(dir, { recursive: true, force: true }); }
