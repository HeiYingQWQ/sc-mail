import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gatewayBaseUrl, mailApiUrl } from './endpoint-utils.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(import.meta.dirname, '.env');
let source;
try {
  source = await readFile(resolve(root, '.env'), 'utf8');
} catch {
  throw new Error('Ai Mail .env was not found. Configure Ai Mail first, then rerun this script.');
}

const values = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!match) continue;
  let value = match[2];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  values.set(match[1], value);
}

if (values.get('AI_PROVIDER') && values.get('AI_PROVIDER') !== 'openai') {
  throw new Error('This setup script expects Ai Mail AI_PROVIDER=openai.');
}
const required = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'AI_MODEL', 'IMAP_API_TOKEN'];
const missing = required.filter((key) => !values.get(key));
if (missing.length) throw new Error(`Missing required Ai Mail settings: ${missing.join(', ')}`);
if (!/^https:\/\//i.test(values.get('OPENAI_BASE_URL'))) throw new Error('The custom model endpoint must use HTTPS.');

try {
  await readFile(output);
  throw new Error('openclaw-stack/.env already exists; refusing to overwrite local credentials.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const result = {
  OPENCLAW_GATEWAY_TOKEN: randomBytes(32).toString('hex'),
  OPENCLAW_GATEWAY_PORT: '18789',
  CUSTOM_API_KEY: values.get('OPENAI_API_KEY'),
  CUSTOM_BASE_URL: values.get('OPENAI_BASE_URL'),
  CUSTOM_MODEL_ID: values.get('AI_MODEL'),
  AI_MAIL_API_TOKEN: values.get('IMAP_API_TOKEN'),
  AI_MAIL_API_URL: mailApiUrl(new Map([['AI_MAIL_API_URL', process.env.AI_MAIL_API_URL || '']]), values),
  OPENCLAW_INTERNAL_URL: gatewayBaseUrl(new Map([['OPENCLAW_INTERNAL_URL', process.env.OPENCLAW_INTERNAL_URL || '']])),
  OPENCLAW_HOOK_TOKEN: randomBytes(32).toString('hex'),
};
for (const [key, value] of Object.entries(result)) {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid multiline value in ${key}`);
}
await writeFile(output, `${Object.entries(result).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
console.log('Created openclaw-stack/.env with local OpenClaw credentials. Secret values were not printed.');
