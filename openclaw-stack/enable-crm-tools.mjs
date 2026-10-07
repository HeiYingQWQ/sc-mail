#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const contractModule = process.env.AI_MAIL_TOOL_CONTRACTS_MODULE || new URL('../scripts/tool-contracts.mjs', import.meta.url);
const { CONTRACT_TOOL_SCHEMAS } = await import(contractModule);

// This helper is intentionally scoped to user-authorized SC Mail business tools.
// It does not register MCP, edit general assistant permissions, or alter denies.
export const CRM_TOOL_NAMES = Object.freeze([
  'list_contacts', 'get_contact', 'create_contact', 'update_contact', 'delete_contact',
  'contact_messages',
  'list_companies', 'get_company', 'create_company', 'update_company', 'delete_company',
  'list_projects', 'get_project', 'create_project', 'update_project', 'delete_project', 'project_messages',
  'start_project_analysis', 'get_project_analysis', 'get_project_analysis_job',
  'cancel_project_analysis', 'retry_project_analysis', 'set_message_project',
]);

const allowedHttpHosts = new Set(['localhost', '127.0.0.1', 'host.docker.internal', 'sc-mail-api']);

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Existing OpenClaw configuration is missing ${label}; run the initial MCP setup before enabling scoped CRM tools.`);
  return value;
}

function validatePrivateApiUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('The configured Ai Mail API URL is invalid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname.replace(/\/$/, '') !== '/api/v1'
    || !allowedHttpHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error('The configured Ai Mail API URL must use an allowed private host and end at /api/v1, without credentials, query, or fragment.');
  }
  return parsed;
}

function assertNoScopedDeny(config, scopedToolNames) {
  const prefixed = scopedToolNames.map(name => `ai-mail__${name}`);
  const scoped = [...prefixed, ...scopedToolNames];
  const checks = [
    ['global tool deny', config.tools?.deny, scoped],
    ['ai-mail agent tool deny', config.agents?.entries?.['ai-mail']?.tools?.deny, scoped],
    ['Ai Mail MCP tool exclusion', config.mcp?.servers?.['ai-mail']?.toolFilter?.exclude, scoped],
  ];
  for (const [label, denied, candidates] of checks) {
    if (!Array.isArray(denied)) continue;
    const conflicts = denied.filter(value => typeof value === 'string' && candidates.some(tool => {
      const expression = value.split('*').map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(`^${expression}$`).test(tool);
    }));
    if (conflicts.length) throw new Error(`Refusing to override ${label}: ${conflicts.join(', ')}.`);
  }
}

export function validateOpenClawConfig(config, schemaRegistry, token = process.env.AI_MAIL_API_TOKEN) {
  for (const name of CRM_TOOL_NAMES) {
    if (!Object.hasOwn(schemaRegistry, name)) throw new Error(`Shared tool contract is missing ${name}.`);
  }
  const globalAllow = requireArray(config.tools?.allow, 'tools.allow');
  const agentTools = config.agents?.entries?.['ai-mail']?.tools;
  const agentAllow = requireArray(agentTools?.allow, "agents.entries['ai-mail'].tools.allow");
  const server = config.mcp?.servers?.['ai-mail'];
  if (!server || server.command !== 'node' || !Array.isArray(server.args)
    || !server.args.some(arg => arg === '/opt/ai-mail-mcp.mjs' || /(?:^|\/)ai-mail-mcp\.mjs$/.test(arg))) {
    throw new Error("Ai Mail MCP is not registered as a Node server; run the initial configure-mcp setup first. This helper will not register or rewrite the server.");
  }
  if (!server.env || server.env.AI_MAIL_API_TOKEN !== '${AI_MAIL_API_TOKEN}') {
    throw new Error("Ai Mail MCP must reference AI_MAIL_API_TOKEN through the environment; run the initial configure-mcp setup first. Literal tokens are not accepted.");
  }
  validatePrivateApiUrl(server.env.AI_MAIL_API_URL);
  if (token && JSON.stringify(config).includes(token)) throw new Error('Refusing to persist a literal API token in OpenClaw configuration.');
  const serverInclude = requireArray(server.toolFilter?.include, "mcp.servers['ai-mail'].toolFilter.include");
  assertNoScopedDeny(config, CRM_TOOL_NAMES);
  return { globalAllow, agentAllow, serverInclude };
}

export function applyScopedCrmTools(config, schemaRegistry = CONTRACT_TOOL_SCHEMAS, token = process.env.AI_MAIL_API_TOKEN) {
  const { globalAllow, agentAllow, serverInclude } = validateOpenClawConfig(config, schemaRegistry, token);
  const prefixed = CRM_TOOL_NAMES.map(name => `ai-mail__${name}`);
  const appendMissing = (existing, additions) => [...existing, ...additions.filter(value => !existing.includes(value))];
  config.tools.allow = appendMissing(globalAllow, prefixed);
  config.agents.entries['ai-mail'].tools.allow = appendMissing(agentAllow, prefixed);
  config.mcp.servers['ai-mail'].toolFilter.include = appendMissing(serverInclude, CRM_TOOL_NAMES);
  return { changed: true, toolNames: [...CRM_TOOL_NAMES] };
}

export async function enableScopedCrmToolsFile(configPath, {
  schemaRegistry = CONTRACT_TOOL_SCHEMAS,
  token = process.env.AI_MAIL_API_TOKEN,
  log = () => {},
} = {}) {
  configPath = resolve(configPath);
  const original = await readFile(configPath, 'utf8');
  let config;
  try { config = JSON.parse(original); } catch { throw new Error('The OpenClaw configuration is not valid JSON; no changes were made.'); }
  const result = applyScopedCrmTools(config, schemaRegistry, token);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (token && serialized.includes(token)) throw new Error('Refusing to write a literal API token into OpenClaw configuration.');
  if (serialized === original) {
    const output = { enabled: true, changed: false, count: result.toolNames.length, toolNames: result.toolNames };
    log(output);
    return output;
  }

  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}.${randomBytes(4).toString('hex')}`;
  const backupPath = `${configPath}.${suffix}.bak`;
  const temporaryPath = resolve(dirname(configPath), `.openclaw.crm-tools.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(backupPath, original, { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(temporaryPath, serialized, { mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, configPath);
  } catch (error) {
    try { await (await import('node:fs/promises')).unlink(temporaryPath); } catch {}
    throw error;
  }
  const output = { enabled: true, changed: true, count: result.toolNames.length, toolNames: result.toolNames, backup: backupPath };
  log(output);
  return output;
}

async function main() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || '/home/node/.openclaw/openclaw.json';
  const output = await enableScopedCrmToolsFile(configPath, { log: record => process.stdout.write(`${JSON.stringify(record)}\n`) });
  return output;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) await main();
