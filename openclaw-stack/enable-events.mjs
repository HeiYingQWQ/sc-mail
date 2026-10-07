import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gatewayBaseUrl, mailApiUrl } from './endpoint-utils.mjs';

const root = resolve(import.meta.dirname, '..');
const openclawEnvPath = resolve(import.meta.dirname, '.env');
const aiMailEnvPath = resolve(root, '.env');

function parse(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

function update(text, updates) {
  const seen = new Set();
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && updates.has(match[1])) {
      const key = match[1];
      if (seen.has(key)) continue;
      lines.push(`${key}=${updates.get(key)}`);
      seen.add(key);
    } else if (line || lines.length) lines.push(line);
  }
  for (const [key, value] of updates) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

async function replace(path, text) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

const [openclawText, aiMailText] = await Promise.all([readFile(openclawEnvPath, 'utf8'), readFile(aiMailEnvPath, 'utf8')]);
const openclaw = parse(openclawText);
const aiMail = parse(aiMailText);
const channels = (aiMail.get('NOTIFICATION_ALLOWED_CHANNELS') || '').split(',').map((value) => value.trim()).filter(Boolean);
const recipients = (aiMail.get('NOTIFICATION_ALLOWED_RECIPIENTS') || '').split(',').map((value) => value.trim()).filter(Boolean);
if (!channels.includes('whatsapp') || recipients.length !== 1 || !/^\+[1-9]\d{4,14}$/.test(recipients[0])) {
  throw new Error('Event notifications require WhatsApp enabled and exactly one valid E.164 recipient in the Ai Mail allowlist.');
}
let hookToken = openclaw.get('OPENCLAW_HOOK_TOKEN');
if (!hookToken) hookToken = randomBytes(32).toString('hex');
if (hookToken.length < 24 || /[\r\n]/.test(hookToken)) throw new Error('OPENCLAW_HOOK_TOKEN must be a single-line secret of at least 24 characters.');

const eventUrl = `${gatewayBaseUrl(openclaw)}/hooks/ai-mail-event`;
const publicApiUrl = mailApiUrl(openclaw, aiMail);
if (aiMail.get('AGENT_EVENT_WEBHOOK_URL') && aiMail.get('AGENT_EVENT_WEBHOOK_URL') !== eventUrl) throw new Error('AGENT_EVENT_WEBHOOK_URL is already configured differently; refusing to replace it.');
if (aiMail.get('AGENT_WEBHOOK_TOKEN') && aiMail.get('AGENT_WEBHOOK_TOKEN') !== hookToken && (aiMail.get('AGENT_EVENT_WEBHOOK_URL') || aiMail.get('AGENT_CHAT_WEBHOOK_URL'))) {
  throw new Error('A different Agent webhook already uses AGENT_WEBHOOK_TOKEN; refusing to overwrite active credentials.');
}

await Promise.all([
  replace(openclawEnvPath, update(openclawText, new Map([['OPENCLAW_HOOK_TOKEN', hookToken], ['AI_MAIL_NOTIFY_RECIPIENT', recipients[0]]]))),
  replace(aiMailEnvPath, update(aiMailText, new Map([
    ['AGENT_EVENT_WEBHOOK_URL', eventUrl],
    ['AGENT_WEBHOOK_TOKEN', hookToken],
    ['AI_MAIL_PUBLIC_API_URL', publicApiUrl],
  ]))),
]);
process.stdout.write('OpenClaw event hook credentials and Ai Mail callback settings saved. Secret values were not printed. Restart/configure OpenClaw before restarting the Ai Mail worker.\n');
