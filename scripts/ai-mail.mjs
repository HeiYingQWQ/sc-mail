#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateApiBaseUrl, validateToolArguments } from './tool-contracts.mjs';

const base = (process.env.AI_MAIL_API_URL || 'http://localhost:3000/api/v1').replace(/\/$/, '');
const token = process.env.AI_MAIL_API_TOKEN || process.env.IMAP_API_TOKEN;
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

function usage() {
  process.stdout.write(`Ai Mail CLI (v1 API)

Usage:
  ai-mail brief [today|yesterday|YYYY-MM-DD] [--from email] [--no-emails]
  ai-mail emails [--date today|yesterday|YYYY-MM-DD] [--from email]
  ai-mail sent [--date today|yesterday|YYYY-MM-DD] [--to email] [--limit n] [--offset n]
  ai-mail classification-summary [--date today|yesterday|YYYY-MM-DD]
  ai-mail classified-emails <classification> [--date today|yesterday|YYYY-MM-DD] [--limit n] [--offset n]
  ai-mail importance-triage [pending|processing|high|urgent|quiet|review|failed|all] [--limit n] [--offset n]
  ai-mail importance-triage-retry <triage-id> <operation-id>
  ai-mail audit-candidates [uncertain|filtered|business_without_analysis] [--limit n] [--offset n]
  ai-mail suggest-email-analysis <message-id> <operation-id>
  ai-mail tasks [--status active|open|in_progress|waiting|done|cancelled] [--project-id id] [--topic-id id] [--limit n] [--offset n]
  ai-mail projects [--company-id id] [--limit n] [--offset n]
  ai-mail contacts [--search name-or-email] [--company-id id] [--limit n] [--offset n]
  ai-mail project-get <project-id>
  ai-mail contact-get <contact-id>
  ai-mail contact-create <json-or-@file>
  ai-mail contact-update <contact-id> <json-or-@file>
  ai-mail contact-delete <contact-id> <json-or-@file>
  ai-mail contact-messages <contact-id> [--project-id id] [--from-date YYYY-MM-DD] [--through-date YYYY-MM-DD] [--direction inbound|outbound] [--include-bodies] [--limit n] [--offset n]
  ai-mail companies [--limit n] [--offset n]
  ai-mail company-get <company-id>
  ai-mail company-create <json-or-@file>
  ai-mail company-update <company-id> <json-or-@file>
  ai-mail company-delete <company-id> <json-or-@file>
  ai-mail project-create <json-or-@file>
  ai-mail project-update <project-id> <json-or-@file>
  ai-mail project-delete <project-id> <json-or-@file>
  ai-mail project-messages <project-id> [--contact-id id] [--from-date YYYY-MM-DD] [--through-date YYYY-MM-DD] [--direction inbound|outbound] [--limit n] [--offset n]
  ai-mail project-analysis-start <project-id> <json-or-@file>
  ai-mail project-analysis <project-id>
  ai-mail project-analysis-job <job-id> [--limit n] [--offset n]
  ai-mail project-analysis-cancel <job-id> <operation-id>
  ai-mail project-analysis-retry <job-id> <operation-id>
  ai-mail message-project-set <message-id> <json-or-@file>
  ai-mail delivery-failures [--date YYYY-MM-DD] [--limit n] [--offset n]
  ai-mail system-mail-senders
  ai-mail system-mail-sender-add <email> <operation-id>
  ai-mail system-mail-sender-delete <sender-id> <operation-id>
  ai-mail contact-decisions <contact-id> [--limit n] [--offset n]
  ai-mail contact-reply-status <contact-id>
  ai-mail reviews [--status pending|resolved|dismissed|all] [--limit n] [--offset n]
  ai-mail task-update <id> <json-or-@file>
  ai-mail review-resolve <id> <json-or-@file>
  ai-mail sender-rules
  ai-mail sender-rule-set <blacklist|whitelist> <address|domain> <pattern> <actor-id> <operation-id>
  ai-mail sender-rule-delete <rule-id> <actor-id> <operation-id>
  ai-mail request <METHOD> /mail/... [json-or-@file]

Task status active includes open, in_progress, and waiting; it is a query filter only.
Tasks, projects, and reviews default to limit 50 and offset 0; limit is 1-100 and offset is 0-100000.
Use classification BLACKLISTED to query archived mail from blacklisted senders.
Set AI_MAIL_API_URL (default http://localhost:3000/api/v1) and AI_MAIL_API_TOKEN (or IMAP_API_TOKEN).
`);
}

async function bodyArg(value) {
  if (!value) return undefined;
  return JSON.parse(value.startsWith('@') ? await readFile(resolve(value.slice(1)), 'utf8') : value);
}

function entityBody(command, idField, id, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`INVALID_TOOL_ARGUMENTS: ${command} body must be an object`);
  if (Object.hasOwn(body, idField)) throw new Error(`INVALID_TOOL_ARGUMENTS: ${idField} belongs in the command path, not the body`);
  return { [idField]: id, ...body };
}

async function api(method, path, body) {
  const safeBase = validateApiBaseUrl(base);
  if (!token) throw new Error('Set AI_MAIL_API_TOKEN or IMAP_API_TOKEN first');
  const response = await fetch(`${safeBase}${path.startsWith('/') ? path : `/${path}`}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let result; try { result = text ? JSON.parse(text) : null; } catch { result = text; }
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, error: result }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function option(name) { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }

function paginatedQuery(filters = []) {
  const query = new URLSearchParams();
  for (const [flag, key] of [...filters, ['--limit', 'limit'], ['--offset', 'offset']]) {
    const value = option(flag);
    if (value !== undefined) query.set(key, value);
  }
  return query;
}

try {
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') { usage(); process.exit(0); }
  if (command === 'delivery-failures') {
    const contract = { ...(option('--date') ? { date: option('--date') } : {}), ...(option('--limit') ? { limit: Number(option('--limit')) } : {}), ...(option('--offset') ? { offset: Number(option('--offset')) } : {}) };
    validateToolArguments('list_delivery_failures', contract);
    const query = new URLSearchParams(); for (const [flag, key] of [['--date', 'date'], ['--limit', 'limit'], ['--offset', 'offset']]) if (option(flag)) query.set(key, option(flag));
    await api('GET', `/mail/delivery-failures${query.size ? `?${query}` : ''}`);
  } else if (command === 'system-mail-senders') {
    validateToolArguments('list_system_mail_senders', {});
    await api('GET', '/mail/system-mail-senders');
  } else if (command === 'system-mail-sender-add') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail system-mail-sender-add <email> <operation-id>');
    const body = { email: args[0], operationId: args[1] }; validateToolArguments('add_system_mail_sender', body);
    await api('PUT', '/mail/system-mail-senders', body);
  } else if (command === 'system-mail-sender-delete') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail system-mail-sender-delete <sender-id> <operation-id>');
    const body = { operationId: args[1] }; validateToolArguments('delete_system_mail_sender', { senderId: args[0], ...body });
    await api('DELETE', `/mail/system-mail-senders/${encodeURIComponent(args[0])}`, body);
  } else if (command === 'brief' || command === 'emails') {
    const date = command === 'brief' ? (args[0] && !args[0].startsWith('--') ? args[0] : 'today') : (option('--date') || 'today');
    const from = option('--from'); const query = new URLSearchParams({ date }); if (from) query.set('fromEmail', from); if (command === 'brief' && args.includes('--no-emails')) query.set('includeEmails', 'false');
    await api('GET', `/mail/brief?${query}`);
  } else if (command === 'sent') {
    const query = new URLSearchParams();
    for (const [flag, key] of [['--date', 'date'], ['--to', 'toEmail'], ['--limit', 'limit'], ['--offset', 'offset']]) if (option(flag)) query.set(key, option(flag));
    await api('GET', `/mail/sent${query.size ? `?${query}` : ''}`);
  } else if (command === 'classification-summary') {
    const query = new URLSearchParams(); if (option('--date')) query.set('date', option('--date'));
    await api('GET', `/mail/classifications/summary${query.size ? `?${query}` : ''}`);
  } else if (command === 'classified-emails') {
    if (!args[0]) throw new Error('Usage: ai-mail classified-emails <classification> [--date today|yesterday|YYYY-MM-DD] [--limit n] [--offset n]');
    const query = new URLSearchParams({ classification: args[0] });
    if (option('--date')) query.set('date', option('--date'));
    if (option('--limit')) query.set('limit', option('--limit'));
    if (option('--offset')) query.set('offset', option('--offset'));
    await api('GET', `/mail/classifications/messages?${query}`);
  } else if (command === 'importance-triage') {
    const status = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
    const query = new URLSearchParams({ status });
    if (option('--limit')) query.set('limit', option('--limit'));
    if (option('--offset')) query.set('offset', option('--offset'));
    await api('GET', `/mail/importance-triage?${query}`);
  } else if (command === 'importance-triage-retry') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail importance-triage-retry <triage-id> <operation-id>');
    await api('POST', `/mail/importance-triage/${encodeURIComponent(args[0])}/retry`, { operationId: args[1] });
  } else if (command === 'sender-rules') {
    await api('GET', '/mail/sender-rules');
  } else if (command === 'sender-rule-set') {
    if (!args[0] || !args[1] || !args[2] || !args[3] || !args[4]) throw new Error('Usage: ai-mail sender-rule-set <blacklist|whitelist> <address|domain> <pattern> <actor-id> <operation-id>');
    const [action, matchType, pattern, actorId, operationId] = args;
    await api('PUT', '/mail/sender-rules', { action, matchType, pattern, actorId, operationId });
  } else if (command === 'sender-rule-delete') {
    if (!args[0] || !args[1] || !args[2]) throw new Error('Usage: ai-mail sender-rule-delete <rule-id> <actor-id> <operation-id>');
    const [ruleId, actorId, operationId] = args;
    await api('DELETE', `/mail/sender-rules/${encodeURIComponent(ruleId)}`, { actorId, operationId });
  } else if (command === 'audit-candidates') {
    const scope = args[0] && !args[0].startsWith('--') ? args[0] : 'uncertain';
    const query = new URLSearchParams({ scope });
    if (option('--limit')) query.set('limit', option('--limit'));
    if (option('--offset')) query.set('offset', option('--offset'));
    await api('GET', `/mail/ai-audit/candidates?${query}`);
  } else if (command === 'suggest-email-analysis') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail suggest-email-analysis <message-id> <operation-id>');
    await api('POST', '/mail/analysis', { messageId: args[0], operationId: args[1] });
  } else if (command === 'tasks') {
    const query = paginatedQuery([['--status', 'status'], ['--project-id', 'projectId'], ['--topic-id', 'topicId']]);
    await api('GET', `/mail/tasks${query.size ? `?${query}` : ''}`);
  } else if (command === 'projects') {
    const query = paginatedQuery([['--company-id', 'companyId']]);
    validateToolArguments('list_projects', { ...(option('--company-id') ? { companyId: option('--company-id') } : {}), ...(option('--limit') ? { limit: Number(option('--limit')) } : {}), ...(option('--offset') ? { offset: Number(option('--offset')) } : {}) });
    await api('GET', `/mail/projects${query.size ? `?${query}` : ''}`);
  } else if (command === 'project-get') {
    validateToolArguments('get_project', { projectId: args[0] });
    await api('GET', `/mail/projects/${encodeURIComponent(args[0])}`);
  } else if (command === 'contacts') {
    const contract = { ...(option('--search') ? { search: option('--search') } : {}), ...(option('--company-id') ? { companyId: option('--company-id') } : {}), ...(option('--limit') ? { limit: Number(option('--limit')) } : {}), ...(option('--offset') ? { offset: Number(option('--offset')) } : {}) };
    validateToolArguments('list_contacts', contract);
    const query = new URLSearchParams(); for (const [flag, key] of [['--search', 'search'], ['--company-id', 'companyId'], ['--limit', 'limit'], ['--offset', 'offset']]) if (option(flag)) query.set(key, option(flag));
    await api('GET', `/mail/crm/contacts${query.size ? `?${query}` : ''}`);
  } else if (command === 'contact-get') {
    const contract = { contactId: args[0] }; validateToolArguments('get_contact', contract);
    await api('GET', `/mail/crm/contacts/${encodeURIComponent(args[0])}`);
  } else if (command === 'contact-create') {
    if (!args[0]) throw new Error('Usage: ai-mail contact-create <json-or-@file>');
    const body = await bodyArg(args[0]); validateToolArguments('create_contact', body);
    await api('POST', '/mail/crm/contacts', body);
  } else if (command === 'contact-update') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail contact-update <contact-id> <json-or-@file>');
    const body = await bodyArg(args[1]); validateToolArguments('update_contact', entityBody(command, 'contactId', args[0], body));
    await api('PATCH', `/mail/crm/contacts/${encodeURIComponent(args[0])}`, body);
  } else if (command === 'contact-delete') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail contact-delete <contact-id> <json-or-@file>');
    const body = await bodyArg(args[1]); validateToolArguments('delete_contact', entityBody(command, 'contactId', args[0], body));
    await api('DELETE', `/mail/crm/contacts/${encodeURIComponent(args[0])}`, body);
  } else if (command === 'contact-messages') {
    if (!args[0]) throw new Error('Usage: ai-mail contact-messages <contact-id>');
    const contract = { contactId: args[0], ...(option('--project-id') ? { projectId: option('--project-id') } : {}), ...(option('--from-date') ? { fromDate: option('--from-date') } : {}), ...(option('--through-date') ? { throughDate: option('--through-date') } : {}), ...(option('--direction') ? { direction: option('--direction') } : {}), ...(option('--limit') ? { limit: Number(option('--limit')) } : {}), ...(option('--offset') ? { offset: Number(option('--offset')) } : {}), ...(args.includes('--include-bodies') ? { includeBodies: true } : {}) };
    validateToolArguments('contact_messages', contract);
    const query = new URLSearchParams(); for (const [flag, key] of [['--project-id', 'projectId'], ['--from-date', 'fromDate'], ['--through-date', 'throughDate'], ['--direction', 'direction'], ['--limit', 'limit'], ['--offset', 'offset']]) if (option(flag)) query.set(key, option(flag)); if (args.includes('--include-bodies')) query.set('includeBodies', 'true');
    await api('GET', `/mail/crm/contacts/${encodeURIComponent(args[0])}/messages${query.size ? `?${query}` : ''}`);
  } else if (command === 'contact-decisions') {
    if (!args[0]) throw new Error('Usage: ai-mail contact-decisions <contact-id>');
    const query = new URLSearchParams(); for (const [flag, key] of [['--limit', 'limit'], ['--offset', 'offset']]) if (option(flag)) query.set(key, option(flag));
    await api('GET', `/mail/crm/contacts/${encodeURIComponent(args[0])}/decisions${query.size ? `?${query}` : ''}`);
  } else if (command === 'contact-reply-status') {
    if (!args[0]) throw new Error('Usage: ai-mail contact-reply-status <contact-id>');
    await api('GET', `/mail/crm/contacts/${encodeURIComponent(args[0])}/reply-status`);
  } else if (command === 'companies') {
    const contract = { ...(option('--limit') ? { limit: Number(option('--limit')) } : {}), ...(option('--offset') ? { offset: Number(option('--offset')) } : {}) };
    validateToolArguments('list_companies', contract);
    const query = paginatedQuery(); await api('GET', `/mail/crm/companies${query.size ? `?${query}` : ''}`);
  } else if (command === 'company-get') {
    validateToolArguments('get_company', { companyId: args[0] });
    await api('GET', `/mail/crm/companies/${encodeURIComponent(args[0])}`);
  } else if (command === 'company-create' || command === 'company-update') {
    const update = command === 'company-update';
    if (!args[0] || (update && !args[1])) throw new Error(`Usage: ai-mail ${command} ${update ? '<company-id> ' : ''}<json-or-@file>`);
    const companyId = update ? args[0] : undefined; const body = await bodyArg(update ? args[1] : args[0]);
    validateToolArguments(update ? 'update_company' : 'create_company', update ? entityBody(command, 'companyId', companyId, body) : body);
    await api(update ? 'PATCH' : 'POST', update ? `/mail/crm/companies/${encodeURIComponent(companyId)}` : '/mail/crm/companies', body);
  } else if (command === 'company-delete') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail company-delete <company-id> <json-or-@file>');
    const body = await bodyArg(args[1]); validateToolArguments('delete_company', entityBody(command, 'companyId', args[0], body));
    await api('DELETE', `/mail/crm/companies/${encodeURIComponent(args[0])}`, body);
  } else if (command === 'project-create' || command === 'project-update') {
    const update = command === 'project-update';
    if (!args[0] || (update && !args[1])) throw new Error(`Usage: ai-mail ${command} ${update ? '<project-id> ' : ''}<json-or-@file>`);
    const projectId = update ? args[0] : undefined; const body = await bodyArg(update ? args[1] : args[0]);
    validateToolArguments(update ? 'update_project' : 'create_project', update ? entityBody(command, 'projectId', projectId, body) : body);
    await api(update ? 'PATCH' : 'POST', update ? `/mail/projects/${encodeURIComponent(projectId)}` : '/mail/projects', body);
  } else if (command === 'project-delete') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail project-delete <project-id> <json-or-@file>');
    const body = await bodyArg(args[1]); validateToolArguments('delete_project', entityBody(command, 'projectId', args[0], body));
    await api('DELETE', `/mail/projects/${encodeURIComponent(args[0])}`, body);
  } else if (command === 'project-messages') {
    const contract = { projectId: args[0], ...(option('--contact-id') ? { contactId: option('--contact-id') } : {}), ...(option('--from-date') ? { fromDate: option('--from-date') } : {}), ...(option('--through-date') ? { throughDate: option('--through-date') } : {}), ...(option('--direction') ? { direction: option('--direction') } : {}), ...(option('--limit') ? { limit: Number(option('--limit')) } : {}), ...(option('--offset') ? { offset: Number(option('--offset')) } : {}) };
    validateToolArguments('project_messages', contract);
    const query = new URLSearchParams(); for (const [flag, key] of [['--contact-id', 'contactId'], ['--from-date', 'fromDate'], ['--through-date', 'throughDate'], ['--direction', 'direction'], ['--limit', 'limit'], ['--offset', 'offset']]) if (option(flag)) query.set(key, option(flag));
    await api('GET', `/mail/projects/${encodeURIComponent(args[0])}/messages${query.size ? `?${query}` : ''}`);
  } else if (command === 'project-analysis-start') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail project-analysis-start <project-id> <json-or-@file>');
    const body = await bodyArg(args[1]); validateToolArguments('start_project_analysis', { projectId: args[0], ...body });
    await api('POST', `/mail/projects/${encodeURIComponent(args[0])}/analysis`, body);
  } else if (command === 'project-analysis') {
    validateToolArguments('get_project_analysis', { projectId: args[0] });
    await api('GET', `/mail/projects/${encodeURIComponent(args[0])}/analysis`);
  } else if (command === 'project-analysis-job') {
    const contract = { jobId: args[0], ...(option('--limit') ? { limit: Number(option('--limit')) } : {}), ...(option('--offset') ? { offset: Number(option('--offset')) } : {}) };
    validateToolArguments('get_project_analysis_job', contract);
    const query = paginatedQuery(); await api('GET', `/mail/project-analysis/${encodeURIComponent(args[0])}${query.size ? `?${query}` : ''}`);
  } else if (command === 'project-analysis-cancel' || command === 'project-analysis-retry') {
    const retry = command === 'project-analysis-retry';
    const contract = { jobId: args[0], operationId: args[1] }; validateToolArguments(retry ? 'retry_project_analysis' : 'cancel_project_analysis', contract);
    await api('POST', `/mail/project-analysis/${encodeURIComponent(args[0])}/${retry ? 'retry' : 'cancel'}`, { operationId: args[1] });
  } else if (command === 'message-project-set') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail message-project-set <message-id> <json-or-@file>');
    const body = await bodyArg(args[1]); validateToolArguments('set_message_project', { messageId: args[0], ...body });
    await api('PATCH', `/mail/messages/by-id/${encodeURIComponent(args[0])}/project`, body);
  } else if (command === 'reviews') {
    const query = paginatedQuery([['--status', 'status']]); if (!query.has('status')) query.set('status', 'pending');
    await api('GET', `/mail/reviews?${query}`);
  } else if (command === 'task-update') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail task-update <id> <json-or-@file>');
    await api('PATCH', `/mail/tasks/${encodeURIComponent(args[0])}`, await bodyArg(args[1]));
  } else if (command === 'review-resolve') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail review-resolve <id> <json-or-@file>');
    await api('POST', `/mail/reviews/${encodeURIComponent(args[0])}/resolve`, await bodyArg(args[1]));
  } else if (command === 'request') {
    if (!args[0] || !args[1]) throw new Error('Usage: ai-mail request <METHOD> /mail/... [json-or-@file]');
    await api(args[0].toUpperCase(), args[1], await bodyArg(args[2]));
  } else { usage(); throw new Error(`Unknown command: ${command}`); }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
