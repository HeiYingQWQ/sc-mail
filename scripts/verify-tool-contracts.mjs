#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTRACT_TOOL_SCHEMAS, validateApiBaseUrl, validateToolArguments } from './tool-contracts.mjs';
import { CRM_TOOL_NAMES, enableScopedCrmToolsFile } from '../openclaw-stack/enable-crm-tools.mjs';

const base = 'https://fixture.invalid/api/v1';
const fixtureToken = 'tool-contract-test-only';
const requests = [];
const rows = Array.from({ length: 73 }, (_, index) => ({ id: 'fixture-' + index }));
const safeFetchOrigins = [];
const collections = new Map([
  ['/api/v1/mail/tasks', 'tasks'],
  ['/api/v1/mail/projects', 'projects'],
  ['/api/v1/mail/crm/contacts', 'contacts'],
  ['/api/v1/mail/crm/companies', 'companies'],
  ['/api/v1/mail/reviews', 'items'],
  ['/api/v1/mail/classifications/messages', 'messages'],
]);

async function fakeFetch(input, request) {
  const url = new URL(input);
  assert.equal(url.origin, 'https://fixture.invalid', 'Adapters must only call the in-memory fixture');
  const query = Object.fromEntries(url.searchParams);
  const body = request.body;
  requests.push({ path: url.pathname, query, method: request.method, body: body ? JSON.parse(body) : null });
  const response = (status, data) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(data) });
  if (request.headers.Authorization !== 'Bearer ' + fixtureToken) return response(401, { code: 'UNAUTHORIZED_FIXTURE' });
  if (request.method === 'GET' && url.pathname === '/api/v1/mail/delivery-failures') {
    const limit = Number(query.limit ?? 50); const offset = Number(query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) return response(400, { code: 'INVALID_PAGINATION_FIXTURE' });
    return response(200, { date: query.date || null, timezone: 'Europe/Rome', total: 1, limit, offset, stats: { configuredSourceReports: 1, deliveryFailureReports: 1, uniqueFailedRecipientAddresses: 1 }, reports: [{ messageId: 'synthetic-report', targets: [{ email: 'person@example.test', status: 'failed' }], reason: 'Synthetic only' }] });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/mail/system-mail-senders') return response(200, { senders: [], total: 0 });
  const collection = collections.get(url.pathname);
  if (request.method === 'POST' && url.pathname === '/api/v1/mail/projects/project-test/topics') return response(201, { id: 'topic-test', received: JSON.parse(body) });
  if (request.method === 'GET' && collection) {
    const limit = Number(query.limit ?? 50);
    const offset = Number(query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
      return response(400, { code: 'INVALID_PAGINATION_FIXTURE' });
    }
    return response(200, { total: rows.length, limit, offset, query, [collection]: rows.slice(offset, offset + limit) });
  }
  const routeAllowed = /^\/api\/v1\/mail\/(?:delivery-failures|system-mail-senders(?:\/[^/]+)?|crm\/(?:contacts|companies)(?:\/[^/]+(?:\/messages)?)?|projects(?:\/[^/]+(?:\/(?:messages|analysis|topics))?)?|project-analysis\/[^/]+(?:\/(?:cancel|retry))?|messages\/by-id\/[^/]+\/project)$/.test(url.pathname);
  if (!routeAllowed) return response(404, { code: 'UNEXPECTED_FIXTURE_ROUTE' });
  if (request.method !== 'GET') return response(200, { method: request.method, path: url.pathname, query, body: body ? JSON.parse(body) : null });
  if (url.pathname.includes('/analysis') || url.pathname.includes('/project-analysis/')) return response(200, { job: null, items: [], totalItems: 0, limit: Number(query.limit || 50), offset: Number(query.offset || 0) });
  if (url.pathname.endsWith('/messages')) return response(200, { contact: { id: 'contact-test' }, total: 0, offset: Number(query.offset || 0), limit: Number(query.limit || 20), hasMore: false, messages: [] });
  if (url.pathname.endsWith('/contacts/contact-test')) return response(200, { contact: { id: 'contact-test', emails: [] }, version: 4 });
  if (url.pathname.endsWith('/companies/company-test')) return response(200, { company: { id: 'company-test' }, contacts: [], projects: [] });
  if (url.pathname.endsWith('/projects/project-test')) return response(200, { project: { id: 'project-test' } });
  if (url.pathname.endsWith('/crm/companies/company-test')) return response(200, { company: { id: 'company-test' }, contacts: [], projects: [] });
  return response(200, { id: url.pathname.split('/').at(-1), query });
}

async function safeFetch(input, request) {
  safeFetchOrigins.push(new URL(input).origin);
  assert.equal(request.headers.Authorization, 'Bearer ' + fixtureToken);
  return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true }) };
}

// Execute the actual adapters with isolated process/fetch objects.
// No subprocess, socket, configured credentials, or database is used.
const cliSource = (await readFile(new URL('./ai-mail.mjs', import.meta.url), 'utf8'))
  .replace(/^#![^\n]*\n/, '')
  .replace(/^import \{ readFile \} from 'node:fs\/promises';\r?\n/m, '')
  .replace(/^import \{ resolve \} from 'node:path';\r?\n/m, '')
  .replace(/^import \{ validateApiBaseUrl, validateToolArguments \} from '\.\/tool-contracts\.mjs';\r?\n/m, '');
const mcpSource = (await readFile(new URL('./ai-mail-mcp.mjs', import.meta.url), 'utf8')).replace(/^#![^\n]*\n/, '').replace(/^import \{ CONTRACT_TOOL_SCHEMAS, validateApiBaseUrl, validateToolArguments \} from '\.\/tool-contracts\.mjs';\r?\n/m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runCliSource = new AsyncFunction('process', 'fetch', 'readFile', 'resolve', 'validateToolArguments', 'validateApiBaseUrl', cliSource);
const runMcpSource = new Function('process', 'fetch', 'CONTRACT_TOOL_SCHEMAS', 'validateToolArguments', 'validateApiBaseUrl', mcpSource);

async function runCli(args, { apiBaseUrl = base, fetchImpl = fakeFetch } = {}) {
  const result = { code: 0, stdout: '', stderr: '' };
  const fakeProcess = {
    argv: ['node', 'ai-mail.mjs', ...args],
    env: { AI_MAIL_API_URL: apiBaseUrl, AI_MAIL_API_TOKEN: fixtureToken },
    stdout: { write: text => { result.stdout += text; } },
    stderr: { write: text => { result.stderr += text; } },
    exitCode: 0,
  };
  await runCliSource(fakeProcess, fetchImpl, readFile, resolve, validateToolArguments, validateApiBaseUrl);
  result.code = fakeProcess.exitCode;
  return result;
}

async function cli(args) {
  const result = await runCli(args);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function mcp(messages, { apiBaseUrl = base, fetchImpl = fakeFetch } = {}) {
  const stdin = new EventEmitter();
  stdin.setEncoding = () => undefined;
  const replies = [];
  await new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP fixture did not reply to every request')), 1000);
    const fakeProcess = {
      env: { AI_MAIL_API_URL: apiBaseUrl, AI_MAIL_API_TOKEN: fixtureToken }, stdin,
      stdout: { write: text => {
        try {
          replies.push(JSON.parse(text));
          if (replies.length === messages.length) { clearTimeout(timer); resolveDone(); }
        } catch (error) { clearTimeout(timer); reject(error); }
      } },
    };
    try {
      runMcpSource(fakeProcess, fetchImpl, CONTRACT_TOOL_SCHEMAS, validateToolArguments, validateApiBaseUrl);
      stdin.emit('data', messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
    } catch (error) { clearTimeout(timer); reject(error); }
  });
  return new Map(replies.map(reply => [reply.id, reply.result]));
}

function assertPage(value, collection, offset, limit, query) {
  assert.equal(value.total, rows.length);
  assert.equal(value.limit, limit);
  assert.equal(value.offset, offset);
  assert.deepEqual(value[collection], rows.slice(offset, offset + limit));
  assert.deepEqual(value.query, query);
}

assert.equal(validateApiBaseUrl('https://api.example.invalid/api/v1'), 'https://api.example.invalid/api/v1');
const approvedHttpBases = [
  'http://localhost:3000/api/v1',
  'http://127.0.0.1:3000/api/v1',
  'http://10.24.0.8:3000/api/v1',
  'http://172.20.0.4:3000/api/v1',
  'http://192.168.1.40:3000/api/v1',
  'http://[::1]:3000/api/v1',
  'http://[fd12:3456::8]:3000/api/v1',
  'http://host.docker.internal:3000/api/v1',
  'http://sc-mail-api:3000/api/v1',
];
for (const apiBaseUrl of approvedHttpBases) assert.equal(validateApiBaseUrl(apiBaseUrl), apiBaseUrl);
for (const apiBaseUrl of [
  'http://public-host.invalid/api/v1',
  'http://8.8.8.8/api/v1',
  'http://172.32.0.1/api/v1',
  'https://fixture-user:fixture-password@fixture.invalid/api/v1',
  'https://fixture.invalid/api/v1?mode=unsafe',
  'https://fixture.invalid/api/v1#unsafe',
]) assert.throws(() => validateApiBaseUrl(apiBaseUrl), /INVALID_API_BASE_URL/);

// Both adapters must validate before invoking fetch, while approved local/private HTTP stays usable.
const rejectedBase = 'http://public-host.invalid/api/v1';
const safetyCallsBefore = safeFetchOrigins.length;
const unsafeCli = await runCli(['tasks'], { apiBaseUrl: rejectedBase, fetchImpl: safeFetch });
assert.equal(unsafeCli.code, 1);
assert.match(unsafeCli.stderr, /INVALID_API_BASE_URL/);
assert.equal(unsafeCli.stderr.includes(rejectedBase), false);
assert.equal(unsafeCli.stderr.includes(fixtureToken), false);
const unsafeMcp = (await mcp([{ id: 917, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } }], { apiBaseUrl: rejectedBase, fetchImpl: safeFetch })).get(917);
assert.equal(unsafeMcp.isError, true);
assert.match(unsafeMcp.content[0].text, /INVALID_API_BASE_URL/);
assert.equal(unsafeMcp.content[0].text.includes(rejectedBase), false);
assert.equal(unsafeMcp.content[0].text.includes(fixtureToken), false);
assert.equal(safeFetchOrigins.length, safetyCallsBefore, 'Public HTTP is rejected before either adapter calls fetch');
const credentialBase = 'https://fixture-user:fixture-password@fixture.invalid/api/v1';
const credentialCli = await runCli(['tasks'], { apiBaseUrl: credentialBase, fetchImpl: safeFetch });
assert.equal(credentialCli.code, 1);
assert.match(credentialCli.stderr, /INVALID_API_BASE_URL/);
assert.equal(credentialCli.stderr.includes('fixture-password'), false);
const credentialMcp = (await mcp([{ id: 919, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } }], { apiBaseUrl: credentialBase, fetchImpl: safeFetch })).get(919);
assert.equal(credentialMcp.isError, true);
assert.match(credentialMcp.content[0].text, /INVALID_API_BASE_URL/);
assert.equal(credentialMcp.content[0].text.includes('fixture-password'), false);
assert.equal(safeFetchOrigins.length, safetyCallsBefore, 'URL userinfo is rejected before either adapter calls fetch');

for (const apiBaseUrl of approvedHttpBases) {
  const localCli = await runCli(['tasks'], { apiBaseUrl, fetchImpl: safeFetch });
  assert.equal(localCli.code, 0, localCli.stderr);
  const localMcp = (await mcp([{ id: 918, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } }], { apiBaseUrl, fetchImpl: safeFetch })).get(918);
  assert.equal(localMcp.isError, false);
}
assert.equal(safeFetchOrigins.length, approvedHttpBases.length * 2);

const definitions = (await mcp([{ id: 1, method: 'tools/list' }])).get(1).tools;
const byName = new Map(definitions.map(tool => [tool.name, tool]));
for (const name of ['list_tasks', 'list_projects', 'list_reviews']) {
  const properties = byName.get(name).inputSchema.properties;
  assert.deepEqual(properties.limit, { type: 'integer', minimum: 1, maximum: 100, default: 50 });
  assert.deepEqual(properties.offset, { type: 'integer', minimum: 0, maximum: 100000, default: 0 });
}
assert.ok(byName.get('list_tasks').inputSchema.properties.status.enum.includes('active'));
const gateSource = await readFile(new URL('../apps/backend/src/modules/mail/business-gate.rules.ts', import.meta.url), 'utf8');
const gateClasses = [...gateSource.match(/export const GATE_CLASSES = \[([\s\S]*?)\] as const;/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
assert.deepEqual(byName.get('list_classified_emails').inputSchema.properties.classification.enum, gateClasses, 'MCP classifications must cover the backend contract');

const cases = [
  { command: 'tasks', tool: 'list_tasks', collection: 'tasks', args: ['--status', 'active', '--project-id', 'project-test', '--topic-id', 'topic-test'], filters: { status: 'active', projectId: 'project-test', topicId: 'topic-test' } },
  { command: 'projects', tool: 'list_projects', collection: 'projects', args: ['--company-id', 'company-test'], filters: { companyId: 'company-test' } },
  { command: 'reviews', tool: 'list_reviews', collection: 'items', args: ['--status', 'resolved'], filters: { status: 'resolved' } },
];
const calls = [];
for (const item of cases) {
  for (const offset of [0, 50, 73]) {
    const query = { ...item.filters, limit: '20', offset: String(offset) };
    assertPage(await cli([item.command, ...item.args, '--limit', '20', '--offset', String(offset)]), item.collection, offset, 20, query);
    calls.push({ id: calls.length + 1, method: 'tools/call', params: { name: item.tool, arguments: { ...item.filters, limit: 20, offset } }, item, offset, query });
  }
}
const replies = await mcp(calls.map(({ id, method, params }) => ({ id, method, params })));
for (const { id, item, offset, query } of calls) {
  const reply = replies.get(id);
  assert.equal(reply.isError, false);
  assertPage(JSON.parse(reply.content[0].text), item.collection, offset, 20, query);
}
for (const item of cases) {
  const query = item.command === 'reviews' ? { status: 'pending' } : {};
  assertPage(await cli([item.command]), item.collection, 0, 50, query);
}
const defaultReplies = await mcp(cases.map((item, id) => ({ id, method: 'tools/call', params: { name: item.tool, arguments: {} } })));
for (const [id, item] of cases.entries()) {
  assertPage(JSON.parse(defaultReplies.get(id).content[0].text), item.collection, 0, 50, item.command === 'reviews' ? { status: 'pending' } : {});
}

const blockedQuery = { classification: 'BLACKLISTED', limit: '10', offset: '0' };
assertPage(await cli(['classified-emails', 'BLACKLISTED', '--limit', '10', '--offset', '0']), 'messages', 0, 10, blockedQuery);
const blockedReply = (await mcp([{ id: 1, method: 'tools/call', params: { name: 'list_classified_emails', arguments: { classification: 'BLACKLISTED', limit: 10, offset: 0 } } }])).get(1);
assertPage(JSON.parse(blockedReply.content[0].text), 'messages', 0, 10, blockedQuery);

const invalidCli = await runCli(['reviews', '--offset', '-1']);
assert.equal(invalidCli.code, 1);
assert.match(invalidCli.stderr, /INVALID_PAGINATION_FIXTURE/);
const invalidMcp = (await mcp([{ id: 1, method: 'tools/call', params: { name: 'list_reviews', arguments: { offset: -1 } } }])).get(1);
assert.equal(invalidMcp.isError, true);
assert.match(invalidMcp.content[0].text, /INVALID_PAGINATION_FIXTURE/);

const topic = { name: 'Drawing', type: 'design', actorId: 'user-test', operationId: 'topic-test-operation' };
assert.deepEqual((await cli(['request', 'POST', '/mail/projects/project-test/topics', JSON.stringify(topic)])).received, topic);
assert.equal(requests.filter(request => request.method !== 'GET').length, 1, 'Only the fake Topic endpoint should receive a write');

const contractNames = [
  'list_delivery_failures', 'list_system_mail_senders', 'add_system_mail_sender', 'delete_system_mail_sender',
  'list_contacts', 'get_contact', 'create_contact', 'update_contact', 'delete_contact', 'contact_messages',
  'list_companies', 'get_company',
  'create_company', 'update_company', 'delete_company', 'list_projects', 'get_project', 'create_project', 'update_project', 'delete_project', 'project_messages',
  'start_project_analysis', 'get_project_analysis', 'get_project_analysis_job', 'cancel_project_analysis', 'retry_project_analysis', 'set_message_project',
];
for (const name of contractNames) {
  assert.ok(byName.has(name), `MCP must publish ${name}`);
  assert.deepEqual(byName.get(name).inputSchema, CONTRACT_TOOL_SCHEMAS[name], `${name} publishes the shared JSON Schema`);
  assert.equal(CONTRACT_TOOL_SCHEMAS[name].additionalProperties, false, `${name} rejects unknown fields`);
}

const openclawScript = new URL('../openclaw-stack/configure-mcp.mjs', import.meta.url);
const openclawSource = await readFile(openclawScript, 'utf8');
assert.match(openclawSource, /Object\.keys\(CONTRACT_TOOL_SCHEMAS\)/, 'OpenClaw allowlists must derive from the shared tool registry');
const compose = await readFile(new URL('../openclaw-stack/compose.yml', import.meta.url), 'utf8');
assert.equal((compose.match(/\.\.\/scripts\/tool-contracts\.mjs:\/opt\/tool-contracts\.mjs:ro/g) || []).length, 2, 'Gateway and CLI must mount the same read-only tool registry');
assert.equal((compose.match(/\.\.\/scripts\/ai-mail\.mjs:\/opt\/ai-mail\.mjs:ro/g) || []).length, 2, 'Gateway and CLI must mount the operator CLI');
assert.equal((compose.match(/\.\/enable-crm-tools\.mjs:\/opt\/enable-crm-tools\.mjs:ro/g) || []).length, 2, 'Gateway and CLI must mount the scoped allowlist helper');
const openclawFixtureDir = await mkdtemp(join(tmpdir(), 'sc-mail-openclaw-contract-'));
try {
  const configPath = join(openclawFixtureDir, 'openclaw.json');
  await writeFile(configPath, JSON.stringify({
    agents: { entries: { 'ai-mail': { tools: { allow: ['existing-ai-mail-tool'] } }, unrelated: { tools: { allow: ['unrelated-tool'] } } } },
    tools: { allow: ['existing-global-tool'] },
  }));
  const fixtureEnv = {
    OPENCLAW_CONFIG_PATH: configPath,
    AI_MAIL_TOOL_CONTRACTS_MODULE: new URL('./tool-contracts.mjs', import.meta.url).href,
    OPENCLAW_HOOK_TOKEN: 'fixture-hook-token-with-enough-entropy',
    AI_MAIL_API_TOKEN: 'fixture-api-token-not-a-secret',
    AI_MAIL_API_URL: 'http://localhost:3000/api/v1',
    CUSTOM_API_KEY: 'fixture-model-key-not-a-secret',
    CUSTOM_BASE_URL: 'http://model.invalid/v1',
    CUSTOM_MODEL_ID: 'fixture-model',
  };
  const oldEnv = new Map(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(fixtureEnv)) process.env[key] = value;
  const priorLog = console.log; const output = [];
  console.log = (...args) => output.push(args.join(' '));
  try { await import(`${openclawScript.href}?contract-fixture=${Date.now()}`); }
  finally {
    console.log = priorLog;
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const configured = JSON.parse(await readFile(configPath, 'utf8'));
  const outputRecord = JSON.parse(output.at(-1));
  const globalAllow = configured.tools.allow;
  const agentAllow = configured.agents.entries['ai-mail'].tools.allow;
  const serverInclude = configured.mcp.servers['ai-mail'].toolFilter.include;
  for (const name of contractNames) {
    assert.ok(globalAllow.includes(`ai-mail__${name}`), `${name} is enabled in the host tool allowlist`);
    assert.ok(agentAllow.includes(`ai-mail__${name}`), `${name} is enabled for the ai-mail Agent`);
    assert.ok(serverInclude.includes(name), `${name} is exposed through the ai-mail MCP filter`);
  }
  assert.deepEqual(configured.agents.entries.unrelated.tools.allow, ['unrelated-tool'], 'the configuration must not widen unrelated Agent permissions');
  assert.deepEqual(configured.agents.entries['ai-mail-notify'].tools.allow, ['session_status'], 'the notification Agent stays minimal');
  assert.equal(outputRecord.apiCredentialsExcludedFromConfig, true);
  assert.equal((await readFile(configPath, 'utf8')).includes('fixture-api-token-not-a-secret'), false, 'API fixture credentials stay out of OpenClaw config');
} finally {
  await rm(openclawFixtureDir, { recursive: true, force: true });
}

assert.deepEqual(CRM_TOOL_NAMES, [
  'list_contacts', 'get_contact', 'create_contact', 'update_contact', 'delete_contact',
  'contact_messages',
  'list_companies', 'get_company', 'create_company', 'update_company', 'delete_company',
  'list_projects', 'get_project', 'create_project', 'update_project', 'delete_project', 'project_messages',
  'start_project_analysis', 'get_project_analysis', 'get_project_analysis_job',
  'cancel_project_analysis', 'retry_project_analysis', 'set_message_project',
]);
assert.ok(CRM_TOOL_NAMES.every(name => CONTRACT_TOOL_SCHEMAS[name]), 'Scoped enable list must only contain shared business contracts');
assert.ok(!CRM_TOOL_NAMES.some(name => /shell|exec|cron|write|read|filesystem/i.test(name)), 'Scoped enable list must not grant generic host access');
const scopedFixtureDir = await mkdtemp(join(tmpdir(), 'sc-mail-crm-enable-'));
try {
  const token = 'synthetic-api-token-do-not-log';
  const configPath = join(scopedFixtureDir, 'openclaw.json');
  const originalConfig = {
    tools: { allow: ['general-tool', 'general-tool', 'ai-mail__list_contacts'], deny: ['dangerous-tool'], profile: 'custom', fs: { workspaceOnly: false }, cron: { enabled: true } },
    agents: { entries: {
      'ai-mail': { model: 'kept-model', tools: { allow: ['existing-ai-mail-tool'], deny: ['other-deny'], profile: 'minimal' } },
      unrelated: { tools: { allow: ['unrelated-tool'] } },
    } },
    mcp: { servers: { 'ai-mail': {
      command: 'node', args: ['/opt/ai-mail-mcp.mjs'],
      env: { AI_MAIL_API_URL: 'http://host.docker.internal:3000/api/v1', AI_MAIL_API_TOKEN: '${AI_MAIL_API_TOKEN}' },
      toolFilter: { include: ['existing-mcp-tool', 'list_contacts'], exclude: ['dangerous-tool'] },
    } } },
    hooks: { enabled: true, token: '${OPENCLAW_HOOK_TOKEN}', mappings: [{ id: 'kept-hook' }] },
    relay: { enabled: true, target: 'kept-relay' },
  };
  await writeFile(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`);
  const logRecords = [];
  const enabled = await enableScopedCrmToolsFile(configPath, { token, log: record => logRecords.push(record) });
  const resultingConfig = JSON.parse(await readFile(configPath, 'utf8'));
  const expectedConfig = structuredClone(originalConfig);
  const appendMissing = (existing, additions) => [...existing, ...additions.filter(value => !existing.includes(value))];
  expectedConfig.tools.allow = appendMissing(expectedConfig.tools.allow, CRM_TOOL_NAMES.map(name => `ai-mail__${name}`));
  expectedConfig.agents.entries['ai-mail'].tools.allow = appendMissing(expectedConfig.agents.entries['ai-mail'].tools.allow, CRM_TOOL_NAMES.map(name => `ai-mail__${name}`));
  expectedConfig.mcp.servers['ai-mail'].toolFilter.include = appendMissing(expectedConfig.mcp.servers['ai-mail'].toolFilter.include, CRM_TOOL_NAMES);
  assert.deepEqual(resultingConfig, expectedConfig, 'Scoped helper changes only the three intended allow/include arrays');
  assert.equal(enabled.changed, true);
  assert.deepEqual(logRecords, [enabled]);
  assert.equal(JSON.stringify(logRecords).includes(token), false, 'Enable output must not contain API tokens');
  assert.equal(JSON.stringify(logRecords).includes(JSON.stringify(resultingConfig)), false, 'Enable output must not contain configuration contents');
  const fileNames = await (await import('node:fs/promises')).readdir(scopedFixtureDir);
  const backupNames = fileNames.filter(name => name.endsWith('.bak'));
  assert.equal(backupNames.length, 1, 'A changed config receives one backup');
  assert.equal(await readFile(join(scopedFixtureDir, backupNames[0]), 'utf8'), `${JSON.stringify(originalConfig, null, 2)}\n`);
  assert.equal(fileNames.some(name => name.endsWith('.tmp')), false, 'Atomic write leaves no temporary file');
  const rerun = await enableScopedCrmToolsFile(configPath, { token });
  assert.equal(rerun.changed, false, 'Scoped enable is idempotent');
  assert.equal((await (await import('node:fs/promises')).readdir(scopedFixtureDir)).filter(name => name.endsWith('.bak')).length, 1);

  const invalidCases = [
    ['missing MCP registration', config => { delete config.mcp.servers['ai-mail']; }],
    ['literal token reference', config => { config.mcp.servers['ai-mail'].env.AI_MAIL_API_TOKEN = token; }],
    ['non-private API host', config => { config.mcp.servers['ai-mail'].env.AI_MAIL_API_URL = 'https://api.example.com/api/v1'; }],
    ['deny collision', config => { config.agents.entries['ai-mail'].tools.deny.push('ai-mail__delete_project'); }],
  ];
  for (const [label, mutate] of invalidCases) {
    const badPath = join(scopedFixtureDir, `${label.replaceAll(' ', '-')}.json`);
    const badConfig = structuredClone(originalConfig); mutate(badConfig);
    const badText = `${JSON.stringify(badConfig, null, 2)}\n`;
    await writeFile(badPath, badText);
    await assert.rejects(enableScopedCrmToolsFile(badPath, { token }), undefined, label);
    assert.equal(await readFile(badPath, 'utf8'), badText, `${label} must not mutate the config`);
    assert.equal((await (await import('node:fs/promises')).readdir(scopedFixtureDir)).some(name => name.startsWith(`${label.replaceAll(' ', '-')}.json.`) && name.endsWith('.bak')), false, `${label} must fail before backup or write`);
  }
} finally {
  await rm(scopedFixtureDir, { recursive: true, force: true });
}

async function paired(name, cliArgs, toolArgs, expected) {
  const start = requests.length;
  const cliResult = await runCli(cliArgs);
  assert.equal(cliResult.code, 0, cliResult.stderr);
  const cliRequest = requests[start];
  const reply = (await mcp([{ id: 1, method: 'tools/call', params: { name, arguments: toolArgs } }])).get(1);
  assert.equal(reply.isError, false, reply.content?.[0]?.text);
  const mcpRequest = requests[start + 1];
  assert.deepEqual({ method: cliRequest.method, path: cliRequest.path, query: cliRequest.query, body: cliRequest.body }, { method: mcpRequest.method, path: mcpRequest.path, query: mcpRequest.query, body: mcpRequest.body }, `${name} CLI and MCP use the same route, query, and body`);
  if (expected) assert.deepEqual({ method: cliRequest.method, path: cliRequest.path, query: cliRequest.query, body: cliRequest.body }, expected);
  return JSON.parse(reply.content[0].text);
}

await paired('list_contacts', ['contacts', '--search', '李', '--company-id', 'company-test', '--limit', '10', '--offset', '20'], { search: '李', companyId: 'company-test', limit: 10, offset: 20 }, {
  method: 'GET', path: '/api/v1/mail/crm/contacts', query: { search: '李', companyId: 'company-test', limit: '10', offset: '20' }, body: null,
});
await paired('get_contact', ['contact-get', 'contact-test'], { contactId: 'contact-test' }, { method: 'GET', path: '/api/v1/mail/crm/contacts/contact-test', query: {}, body: null });
const contactCreate = { displayName: 'Li', emails: ['li@example.test', 'li.work@example.test'], primaryEmail: 'li@example.test', companyId: 'company-test', notes: 'Main buyer', actorId: 'user-test', operationId: 'contact-create-op' };
await paired('create_contact', ['contact-create', JSON.stringify(contactCreate)], contactCreate, { method: 'POST', path: '/api/v1/mail/crm/contacts', query: {}, body: contactCreate });
const contactUpdate = { displayName: 'Li Updated', expectedVersion: 4, operationId: 'contact-update-op', notes: null };
await paired('update_contact', ['contact-update', 'contact-test', JSON.stringify(contactUpdate)], { contactId: 'contact-test', ...contactUpdate }, { method: 'PATCH', path: '/api/v1/mail/crm/contacts/contact-test', query: {}, body: contactUpdate });
const contactDelete = { expectedVersion: 5, operationId: 'contact-delete-op', actorId: 'user-test' };
await paired('delete_contact', ['contact-delete', 'contact-test', JSON.stringify(contactDelete)], { contactId: 'contact-test', ...contactDelete }, { method: 'DELETE', path: '/api/v1/mail/crm/contacts/contact-test', query: {}, body: contactDelete });
await paired('contact_messages', ['contact-messages', 'contact-test', '--project-id', 'project-test', '--from-date', '2026-09-01', '--through-date', '2026-09-30', '--direction', 'inbound', '--include-bodies', '--limit', '20', '--offset', '40'], {
  contactId: 'contact-test', projectId: 'project-test', fromDate: '2026-09-01', throughDate: '2026-09-30', direction: 'inbound', includeBodies: true, limit: 20, offset: 40,
}, { method: 'GET', path: '/api/v1/mail/crm/contacts/contact-test/messages', query: { projectId: 'project-test', fromDate: '2026-09-01', throughDate: '2026-09-30', direction: 'inbound', limit: '20', offset: '40', includeBodies: 'true' }, body: null });
await paired('list_companies', ['companies', '--limit', '25', '--offset', '50'], { limit: 25, offset: 50 }, { method: 'GET', path: '/api/v1/mail/crm/companies', query: { limit: '25', offset: '50' }, body: null });
await paired('get_company', ['company-get', 'company-test'], { companyId: 'company-test' }, { method: 'GET', path: '/api/v1/mail/crm/companies/company-test', query: {}, body: null });
const companyCreate = { name: 'Acme', website: 'https://acme.example', address: 'Milan', notes: null, contactIds: ['contact-test'], actorId: 'user-test', operationId: 'company-create-op' };
await paired('create_company', ['company-create', JSON.stringify(companyCreate)], companyCreate, { method: 'POST', path: '/api/v1/mail/crm/companies', query: {}, body: companyCreate });
const companyUpdate = { website: null, contactIds: ['contact-test'], expectedVersion: 2, operationId: 'company-update-op' };
await paired('update_company', ['company-update', 'company-test', JSON.stringify(companyUpdate)], { companyId: 'company-test', ...companyUpdate }, { method: 'PATCH', path: '/api/v1/mail/crm/companies/company-test', query: {}, body: companyUpdate });
const companyDelete = { expectedVersion: 3, operationId: 'company-delete-op' };
await paired('delete_company', ['company-delete', 'company-test', JSON.stringify(companyDelete)], { companyId: 'company-test', ...companyDelete }, { method: 'DELETE', path: '/api/v1/mail/crm/companies/company-test', query: {}, body: companyDelete });
await paired('list_projects', ['projects', '--company-id', 'company-test', '--limit', '10', '--offset', '10'], { companyId: 'company-test', limit: 10, offset: 10 }, { method: 'GET', path: '/api/v1/mail/projects', query: { companyId: 'company-test', limit: '10', offset: '10' }, body: null });
await paired('get_project', ['project-get', 'project-test'], { projectId: 'project-test' }, { method: 'GET', path: '/api/v1/mail/projects/project-test', query: {}, body: null });
const projectCreate = { name: '2026 Expo', companyId: 'company-test', description: 'Milan 2026', contactIds: ['contact-test'], primaryContactId: 'contact-test', status: 'active', stage: 'planning', actorId: 'user-test', operationId: 'project-create-op' };
await paired('create_project', ['project-create', JSON.stringify(projectCreate)], projectCreate, { method: 'POST', path: '/api/v1/mail/projects', query: {}, body: projectCreate });
const projectUpdate = { status: 'completed', stage: 'completed', expectedVersion: 3, operationId: 'project-update-op' };
await paired('update_project', ['project-update', 'project-test', JSON.stringify(projectUpdate)], { projectId: 'project-test', ...projectUpdate }, { method: 'PATCH', path: '/api/v1/mail/projects/project-test', query: {}, body: projectUpdate });
const projectDelete = { expectedVersion: 4, operationId: 'project-delete-op' };
await paired('delete_project', ['project-delete', 'project-test', JSON.stringify(projectDelete)], { projectId: 'project-test', ...projectDelete }, { method: 'DELETE', path: '/api/v1/mail/projects/project-test', query: {}, body: projectDelete });
await paired('project_messages', ['project-messages', 'project-test', '--contact-id', 'contact-test', '--from-date', '2026-09-01', '--through-date', '2026-09-30', '--direction', 'outbound', '--limit', '20', '--offset', '20'], {
  projectId: 'project-test', contactId: 'contact-test', fromDate: '2026-09-01', throughDate: '2026-09-30', direction: 'outbound', limit: 20, offset: 20,
}, { method: 'GET', path: '/api/v1/mail/projects/project-test/messages', query: { contactId: 'contact-test', fromDate: '2026-09-01', throughDate: '2026-09-30', direction: 'outbound', limit: '20', offset: '20' }, body: null });
const analysisStart = { operationId: 'analysis-start-op', from: '2026-09-30', to: '2026-09-30', limit: 500 };
await paired('start_project_analysis', ['project-analysis-start', 'project-test', JSON.stringify(analysisStart)], { projectId: 'project-test', ...analysisStart }, { method: 'POST', path: '/api/v1/mail/projects/project-test/analysis', query: {}, body: analysisStart });
await paired('get_project_analysis', ['project-analysis', 'project-test'], { projectId: 'project-test' }, { method: 'GET', path: '/api/v1/mail/projects/project-test/analysis', query: {}, body: null });
await paired('get_project_analysis_job', ['project-analysis-job', 'job-test', '--limit', '30', '--offset', '60'], { jobId: 'job-test', limit: 30, offset: 60 }, { method: 'GET', path: '/api/v1/mail/project-analysis/job-test', query: { limit: '30', offset: '60' }, body: null });
await paired('cancel_project_analysis', ['project-analysis-cancel', 'job-test', 'cancel-op'], { jobId: 'job-test', operationId: 'cancel-op' }, { method: 'POST', path: '/api/v1/mail/project-analysis/job-test/cancel', query: {}, body: { operationId: 'cancel-op' } });
await paired('retry_project_analysis', ['project-analysis-retry', 'job-test', 'retry-op'], { jobId: 'job-test', operationId: 'retry-op' }, { method: 'POST', path: '/api/v1/mail/project-analysis/job-test/retry', query: {}, body: { operationId: 'retry-op' } });
const assignment = { projectId: null, operationId: 'manual-set-op', expectedVersion: 7 };
await paired('set_message_project', ['message-project-set', 'message-test', JSON.stringify(assignment)], { messageId: 'message-test', ...assignment }, { method: 'PATCH', path: '/api/v1/mail/messages/by-id/message-test/project', query: {}, body: assignment });

await paired('list_delivery_failures', ['delivery-failures', '--date', '2026-10-02', '--limit', '20', '--offset', '40'], { date: '2026-10-02', limit: 20, offset: 40 }, {
  method: 'GET', path: '/api/v1/mail/delivery-failures', query: { date: '2026-10-02', limit: '20', offset: '40' }, body: null,
});
await paired('list_system_mail_senders', ['system-mail-senders'], {}, { method: 'GET', path: '/api/v1/mail/system-mail-senders', query: {}, body: null });
const senderAdd = { email: 'mailer-daemon@example.test', operationId: 'sender-add-op' };
await paired('add_system_mail_sender', ['system-mail-sender-add', senderAdd.email, senderAdd.operationId], senderAdd, { method: 'PUT', path: '/api/v1/mail/system-mail-senders', query: {}, body: senderAdd });
const senderDelete = { operationId: 'sender-delete-op' };
await paired('delete_system_mail_sender', ['system-mail-sender-delete', 'sender-test', senderDelete.operationId], { senderId: 'sender-test', ...senderDelete }, { method: 'DELETE', path: '/api/v1/mail/system-mail-senders/sender-test', query: {}, body: senderDelete });

const noWriteCount = requests.length;
const invalidUpdateCli = await runCli(['contact-update', 'contact-test', JSON.stringify({ displayName: 'Missing CAS', operationId: 'missing-version' })]);
assert.equal(invalidUpdateCli.code, 1); assert.match(invalidUpdateCli.stderr, /INVALID_TOOL_ARGUMENTS/);
const invalidDeleteCli = await runCli(['project-delete', 'project-test', JSON.stringify({ operationId: 'missing-cas' })]);
assert.equal(invalidDeleteCli.code, 1); assert.match(invalidDeleteCli.stderr, /INVALID_TOOL_ARGUMENTS/);
const pathOverrideCli = await runCli(['contact-delete', 'contact-test', JSON.stringify({ contactId: 'other-contact', expectedVersion: 1, operationId: 'path-override' })]);
assert.equal(pathOverrideCli.code, 1); assert.match(pathOverrideCli.stderr, /belongs in the command path/);
const invalidUpdateMcp = (await mcp([{ id: 1, method: 'tools/call', params: { name: 'update_contact', arguments: { contactId: 'contact-test', displayName: 'Missing CAS', operationId: 'missing-version' } } }])).get(1);
assert.equal(invalidUpdateMcp.isError, true); assert.match(invalidUpdateMcp.content[0].text, /INVALID_TOOL_ARGUMENTS/);
const invalidAnalysisCli = await runCli(['project-analysis-start', 'project-test', JSON.stringify({ operationId: 'bad-range', from: '2026-09-30', to: '2026-09-01' })]);
assert.equal(invalidAnalysisCli.code, 1); assert.match(invalidAnalysisCli.stderr, /from must be on or before to/);
const invalidProjectMcp = (await mcp([{ id: 1, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'No members', companyId: 'company-test', contactIds: [], status: 'active', operationId: 'invalid-project' } } }])).get(1);
assert.equal(invalidProjectMcp.isError, true); assert.match(invalidProjectMcp.content[0].text, /INVALID_TOOL_ARGUMENTS/);
assert.equal(requests.length, noWriteCount, 'Schema failures are rejected before any API request');

const noDeliveryWriteCount = requests.length;
const invalidDeliveryDate = await runCli(['delivery-failures', '--date', '2026-02-30']);
assert.equal(invalidDeliveryDate.code, 1); assert.match(invalidDeliveryDate.stderr, /INVALID_TOOL_ARGUMENTS/);
const invalidDeliveryMcp = (await mcp([{ id: 1, method: 'tools/call', params: { name: 'list_delivery_failures', arguments: { date: '2026-02-30' } } }])).get(1);
assert.equal(invalidDeliveryMcp.isError, true); assert.match(invalidDeliveryMcp.content[0].text, /INVALID_TOOL_ARGUMENTS/);
const invalidSenderAdd = (await mcp([{ id: 1, method: 'tools/call', params: { name: 'add_system_mail_sender', arguments: { email: 'not-an-email', operationId: 'bad-sender' } } }])).get(1);
assert.equal(invalidSenderAdd.isError, true); assert.match(invalidSenderAdd.content[0].text, /INVALID_TOOL_ARGUMENTS/);
const invalidSenderDelete = await runCli(['system-mail-sender-delete', 'sender-test']);
assert.equal(invalidSenderDelete.code, 1); assert.match(invalidSenderDelete.stderr, /Usage: ai-mail system-mail-sender-delete/);
assert.equal(requests.length, noDeliveryWriteCount, 'Invalid report dates and sender writes are rejected before API requests');

console.log(`PASS CLI/MCP business contract parity, pagination, date filters, CAS/idempotency fields, error validation and safe fixture requests (${requests.length} fake API requests; no database used)`);
