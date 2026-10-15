import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { CONTRACT_TOOL_SCHEMAS } from './tool-contracts.mjs';
import { DELIVERY_TOOL_NAMES, enableScopedDeliveryToolsFile } from '../openclaw-stack/enable-crm-tools.mjs';

const folder = await mkdtemp(join(tmpdir(), 'sc-mail-delivery-tools-'));
const token = 'synthetic-fixture-token';
const original = {
  tools: { allow: ['existing'], deny: ['exec'], profile: 'minimal' },
  agents: { entries: {
    'ai-mail': { tools: { allow: ['existing-agent'], deny: ['shell'] }, model: 'keep-model' },
    'ai-mail-notify': { tools: { allow: ['session_status'] } },
    other: { tools: { allow: ['other-tool'] } },
  } },
  mcp: { servers: { 'ai-mail': {
    command: 'node', args: ['/opt/ai-mail-mcp.mjs'],
    env: { AI_MAIL_API_URL: 'http://host.docker.internal:3000/api/v1', AI_MAIL_API_TOKEN: '${AI_MAIL_API_TOKEN}' },
    toolFilter: { include: ['existing-mcp'], exclude: ['unrelated'] },
  } } },
  hooks: { token: '${OPENCLAW_HOOK_TOKEN}', mappings: [{ id: 'keep-hook' }] },
};
let cases = 0;
try {
  assert.deepEqual(DELIVERY_TOOL_NAMES, ['list_delivery_failures', 'list_system_mail_senders', 'add_system_mail_sender', 'delete_system_mail_sender']);
  const path = join(folder, 'openclaw.json');
  const text = JSON.stringify(original, null, 2) + '\n'; await writeFile(path, text);
  const output = await enableScopedDeliveryToolsFile(path, { token });
  const expected = structuredClone(original);
  expected.tools.allow.push(...DELIVERY_TOOL_NAMES.map(name => `ai-mail__${name}`));
  expected.agents.entries['ai-mail'].tools.allow.push(...DELIVERY_TOOL_NAMES.map(name => `ai-mail__${name}`));
  expected.mcp.servers['ai-mail'].toolFilter.include.push(...DELIVERY_TOOL_NAMES);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), expected);
  assert.equal(output.count, 4); assert.equal(output.changed, true);
  assert.equal(await readFile(output.backup, 'utf8'), text);
  assert.ok(!JSON.stringify(output).includes(token)); cases++;
  const rerun = await enableScopedDeliveryToolsFile(path, { token });
  assert.equal(rerun.changed, false); assert.equal((await readdir(folder)).filter(name => name.endsWith('.bak')).length, 1); cases++;

  const invalid = [
    ['global deny', c => c.tools.deny.push('ai-mail__list_delivery_failures')],
    ['agent wildcard deny', c => c.agents.entries['ai-mail'].tools.deny.push('ai-mail__*system_mail_sender*')],
    ['MCP exclusion', c => c.mcp.servers['ai-mail'].toolFilter.exclude.push('list_*')],
    ['missing registration', c => { delete c.mcp.servers['ai-mail']; }],
    ['literal credential', c => { c.mcp.servers['ai-mail'].env.AI_MAIL_API_TOKEN = token; }],
    ['unapproved host', c => { c.mcp.servers['ai-mail'].env.AI_MAIL_API_URL = 'https://remote.invalid/api/v1'; }],
    ['missing allowlist', c => { delete c.tools.allow; }],
  ];
  for (const [name, mutate] of invalid) {
    const config = structuredClone(original); mutate(config);
    const badPath = join(folder, name + '.json'), before = JSON.stringify(config);
    await writeFile(badPath, before);
    await assert.rejects(enableScopedDeliveryToolsFile(badPath, { token }));
    assert.equal(await readFile(badPath, 'utf8'), before);
    assert.ok(!(await readdir(folder)).some(file => file.startsWith(name + '.json.') && file.endsWith('.bak'))); cases++;
  }
  const missingSchema = { ...CONTRACT_TOOL_SCHEMAS }; delete missingSchema.list_delivery_failures;
  await assert.rejects(enableScopedDeliveryToolsFile(path, { token, schemaRegistry: missingSchema })); cases++;
  const cliPath = join(folder, 'cli.json'); await writeFile(cliPath, text);
  const report = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../openclaw-stack/enable-delivery-tools.mjs', import.meta.url))], {
    env: { ...process.env, OPENCLAW_CONFIG_PATH: cliPath, AI_MAIL_API_TOKEN: token }, encoding: 'utf8', timeout: 10000,
  }));
  assert.equal(report.count, 4); assert.deepEqual(JSON.parse(await readFile(cliPath, 'utf8')), expected); cases++;
  assert.ok(!(await readdir(folder)).some(name => name.endsWith('.tmp')));
  // Exercise the real MCP process against a loopback HTTP fixture after enabling
  // the scope. This validates exposure and requests without a production Gateway.
  const requests = [], errors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      let data = ''; for await (const chunk of request) data += chunk;
      requests.push({ method: request.method, url: request.url, body: data ? JSON.parse(data) : null });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ synthetic: true }));
    } catch (error) { errors.push(error); response.writeHead(500); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./ai-mail-mcp.mjs', import.meta.url))], {
    env: { ...process.env, AI_MAIL_API_URL: 'http://127.0.0.1:' + server.address().port + '/api/v1', AI_MAIL_API_TOKEN: token },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout }); const pending = new Map(); let id = 0;
  lines.on('line', line => { const reply = JSON.parse(line); const waiting = pending.get(reply.id); if (waiting) { pending.delete(reply.id); waiting(reply); } });
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const current = ++id; const timer = setTimeout(() => { pending.delete(current); reject(new Error('MCP fixture response timed out')); }, 5000);
      pending.set(current, reply => { clearTimeout(timer); resolve(reply); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
    });
  }
  try {
    const listed = await rpc('tools/list');
    for (const name of DELIVERY_TOOL_NAMES) {
      assert.ok(expected.tools.allow.includes('ai-mail__' + name));
      assert.ok(expected.agents.entries['ai-mail'].tools.allow.includes('ai-mail__' + name));
      assert.ok(expected.mcp.servers['ai-mail'].toolFilter.include.includes(name));
      assert.deepEqual(listed.result.tools.find(tool => tool.name === name).inputSchema, CONTRACT_TOOL_SCHEMAS[name]);
    }
    cases++;
    const calls = [
      ['list_delivery_failures', { date: '2026-10-15', limit: 20, offset: 40 }, 'GET', '/api/v1/mail/delivery-failures?date=2026-10-15&limit=20&offset=40', null],
      ['list_system_mail_senders', {}, 'GET', '/api/v1/mail/system-mail-senders', null],
      ['add_system_mail_sender', { email: 'daemon@test.invalid', operationId: 'add-fixture' }, 'PUT', '/api/v1/mail/system-mail-senders', { email: 'daemon@test.invalid', operationId: 'add-fixture' }],
      ['delete_system_mail_sender', { senderId: 'sender-fixture', operationId: 'delete-fixture' }, 'DELETE', '/api/v1/mail/system-mail-senders/sender-fixture', { operationId: 'delete-fixture' }],
    ];
    for (const [name, args, method, url, body] of calls) {
      const reply = await rpc('tools/call', { name, arguments: args });
      assert.equal(reply.result.isError, false); assert.equal(JSON.parse(reply.result.content[0].text).synthetic, true);
      assert.deepEqual(requests.at(-1), { method, url, body }); cases++;
    }
    const before = requests.length;
    const invalid = await rpc('tools/call', { name: 'add_system_mail_sender', arguments: { email: 'daemon@test.invalid' } });
    assert.equal(invalid.result.isError, true); assert.equal(requests.length, before); cases++;
    assert.deepEqual(errors, []);
  } finally {
    child.kill(); await closed; lines.close(); await new Promise(resolve => server.close(resolve));
  }
  console.log(`PASS delivery tool enablement: ${cases} isolated cases; only 3 allowlists changed; relay/denies/models/hooks preserved; real MCP to 4 loopback fixture API calls; no production host/model/mailbox/notification used.`);
} finally { await rm(folder, { recursive: true, force: true }); }
