const id = { type: 'string', minLength: 1, maxLength: 200 };
const operationId = { type: 'string', minLength: 1, maxLength: 200 };
const expectedVersion = { type: 'integer', minimum: 0 };
const pagination = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
};
const deliveryFailurePagination = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  offset: pagination.offset,
};
const historyPagination = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  offset: pagination.offset,
};
const email = { type: 'string', format: 'email', maxLength: 320 };
const nonempty = { type: 'string', minLength: 1, maxLength: 500 };
const nullableText = { anyOf: [{ type: 'string', maxLength: 10000 }, { type: 'null' }] };
const stages = ['lead', 'planning', 'design', 'quotation', 'revision', 'approval', 'production', 'delivery', 'completed', 'on_hold', 'cancelled'];
const projectStatus = { type: 'string', enum: ['active', 'completed'] };
const crmActor = { actorId: id };

const contactFields = {
  displayName: { type: 'string', minLength: 1, maxLength: 200 },
  emails: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: email },
  primaryEmail: email,
  companyId: { anyOf: [id, { type: 'null' }] },
  notes: nullableText,
};
const companyFields = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  domain: nullableText,
  website: { anyOf: [{ type: 'string', format: 'uri', maxLength: 2048 }, { type: 'null' }] },
  address: nullableText,
  notes: nullableText,
  contactIds: { type: 'array', minItems: 1, uniqueItems: true, maxItems: 1000, items: id },
};
const projectFields = {
  name: { type: 'string', minLength: 1, maxLength: 500 },
  companyId: id,
  description: nullableText,
  contactIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: id },
  primaryContactId: { anyOf: [id, { type: 'null' }] },
  status: projectStatus,
  stage: { type: 'string', enum: stages },
};
const rangeFields = {
  from: { type: 'string', format: 'date' },
  to: { type: 'string', format: 'date' },
  limit: { type: 'integer', minimum: 1, maximum: 500, default: 500 },
};

function objectSchema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

function isPrivateIpv4(hostname) {
  const octets = hostname.split('.').map(part => Number(part));
  if (octets.length !== 4 || octets.some((part, index) => !/^\d{1,3}$/.test(hostname.split('.')[index]) || part > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isApprovedHttpHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'host.docker.internal' || host === 'sc-mail-api') return true;
  if (isPrivateIpv4(host)) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host)) return true;

  // IPv4-mapped IPv6 addresses inherit the IPv4 address's local/private scope.
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return Boolean(mapped && isPrivateIpv4(mapped[1]));
}

export function validateApiBaseUrl(value) {
  const invalid = () => { throw new Error('INVALID_API_BASE_URL: use HTTPS, or HTTP with an approved local/private address'); };
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) invalid();

  let url;
  try { url = new URL(value); } catch { invalid(); }
  const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? '';
  if (!['http:', 'https:'].includes(url.protocol)
    || !url.hostname
    || authority.includes('@')
    || url.username !== ''
    || url.password !== ''
    || value.includes('?')
    || value.includes('#')) invalid();
  if (url.protocol === 'http:' && !isApprovedHttpHostname(url.hostname)) invalid();

  return url.href.replace(/\/$/, '');
}

export const CONTRACT_TOOL_SCHEMAS = {
  list_delivery_failures: objectSchema({
    date: { type: 'string', format: 'date' }, ...deliveryFailurePagination,
  }),
  list_system_mail_senders: objectSchema({}),
  add_system_mail_sender: objectSchema({ email, operationId, ...crmActor }, ['email', 'operationId']),
  delete_system_mail_sender: objectSchema({ senderId: id, operationId, ...crmActor }, ['senderId', 'operationId']),
  list_contacts: objectSchema({ search: { type: 'string', minLength: 1, maxLength: 200 }, companyId: id, ...pagination }),
  get_contact: objectSchema({ contactId: id }, ['contactId']),
  create_contact: objectSchema({ ...contactFields, ...crmActor, operationId }, ['displayName', 'emails', 'operationId']),
  update_contact: objectSchema({ contactId: id, ...contactFields, ...crmActor, operationId, expectedVersion }, ['contactId', 'operationId', 'expectedVersion']),
  delete_contact: objectSchema({ contactId: id, ...crmActor, operationId, expectedVersion }, ['contactId', 'operationId', 'expectedVersion']),
  contact_messages: objectSchema({
    contactId: id, projectId: id, fromDate: { type: 'string', format: 'date' }, throughDate: { type: 'string', format: 'date' },
    direction: { type: 'string', enum: ['inbound', 'outbound'] }, includeBodies: { type: 'boolean' }, ...historyPagination,
  }, ['contactId']),
  list_companies: objectSchema(pagination),
  get_company: objectSchema({ companyId: id }, ['companyId']),
  create_company: objectSchema({ ...companyFields, ...crmActor, operationId }, ['name', 'contactIds', 'operationId']),
  update_company: objectSchema({ companyId: id, ...companyFields, ...crmActor, operationId, expectedVersion }, ['companyId', 'operationId', 'expectedVersion']),
  delete_company: objectSchema({ companyId: id, ...crmActor, operationId, expectedVersion }, ['companyId', 'operationId', 'expectedVersion']),
  list_projects: objectSchema({ companyId: id, ...pagination }),
  get_project: objectSchema({ projectId: id }, ['projectId']),
  create_project: objectSchema({ ...projectFields, ...crmActor, operationId }, ['name', 'companyId', 'contactIds', 'status', 'operationId']),
  update_project: objectSchema({ projectId: id, ...projectFields, ...crmActor, operationId, expectedVersion }, ['projectId', 'operationId', 'expectedVersion']),
  delete_project: objectSchema({ projectId: id, ...crmActor, operationId, expectedVersion }, ['projectId', 'operationId', 'expectedVersion']),
  project_messages: objectSchema({
    projectId: id, contactId: id, fromDate: { type: 'string', format: 'date' }, throughDate: { type: 'string', format: 'date' },
    direction: { type: 'string', enum: ['inbound', 'outbound'] }, ...historyPagination,
  }, ['projectId']),
  start_project_analysis: objectSchema({ projectId: id, ...rangeFields, operationId }, ['projectId', 'operationId']),
  get_project_analysis: objectSchema({ projectId: id }, ['projectId']),
  get_project_analysis_job: objectSchema({ jobId: id, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, offset: pagination.offset }, ['jobId']),
  cancel_project_analysis: objectSchema({ jobId: id, operationId }, ['jobId', 'operationId']),
  retry_project_analysis: objectSchema({ jobId: id, operationId }, ['jobId', 'operationId']),
  set_message_project: objectSchema({ messageId: id, projectId: { anyOf: [id, { type: 'null' }] }, operationId, expectedVersion }, ['messageId', 'projectId', 'operationId', 'expectedVersion']),
};

function matchesType(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(option => matchesType(value, option));
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'integer') return Number.isInteger(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return true;
}

function validateValue(value, schema, path, issues) {
  if (schema.anyOf) {
    const matching = schema.anyOf.filter(option => matchesType(value, option));
    if (!matching.length) { issues.push(`${path} has the wrong type`); return; }
    const alternatives = matching.map(option => { const candidate = []; validateValue(value, option, path, candidate); return candidate; });
    const best = alternatives.sort((left, right) => left.length - right.length)[0];
    issues.push(...best);
    return;
  }
  if (!matchesType(value, schema)) { issues.push(`${path} has the wrong type`); return; }
  if (value === null || value === undefined) return;
  if (schema.enum && !schema.enum.includes(value)) issues.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) issues.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${path} is too long`);
    if (schema.format === 'email' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 320)) issues.push(`${path} must be an email address`);
    if (schema.format === 'uri') {
      try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
      catch { issues.push(`${path} must be an http or https URL`); }
    }
    if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) issues.push(`${path} must be a real YYYY-MM-DD date`);
    if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) issues.push(`${path} must be an ISO date-time with timezone`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path} allows at most ${schema.maxItems} item(s)`);
    if (schema.uniqueItems && new Set(value).size !== value.length) issues.push(`${path} must not contain duplicates`);
    if (schema.items) value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, issues));
  }
}

export function validateToolArguments(name, args) {
  const schema = CONTRACT_TOOL_SCHEMAS[name];
  if (!schema) return args;
  const issues = [];
  if (!matchesType(args, schema)) throw new Error('INVALID_TOOL_ARGUMENTS: arguments must be an object');
  for (const key of schema.required) if (args[key] === undefined) issues.push(`${key} is required`);
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) issues.push(`${key} is not allowed`);
    else validateValue(args[key], schema.properties[key], key, issues);
  }
  if (name === 'update_contact' && !['displayName', 'emails', 'primaryEmail', 'companyId', 'notes'].some(key => Object.hasOwn(args, key))) issues.push('provide at least one contact field');
  if (name === 'update_company' && !['name', 'domain', 'website', 'address', 'notes', 'contactIds'].some(key => Object.hasOwn(args, key))) issues.push('provide at least one company field');
  if (name === 'update_project' && !['name', 'companyId', 'description', 'contactIds', 'primaryContactId', 'status', 'stage'].some(key => Object.hasOwn(args, key))) issues.push('provide at least one project field');
  if (name === 'start_project_analysis' && Boolean(args.from) !== Boolean(args.to)) issues.push('from and to must be supplied together');
  if (name === 'start_project_analysis' && args.from && args.to && args.from > args.to) issues.push('from must be on or before to');
  if (['contact_messages', 'project_messages'].includes(name) && args.fromDate && args.throughDate && args.fromDate > args.throughDate) issues.push('fromDate must be on or before throughDate');
  if (name === 'contact_messages' && args.includeBodies && args.limit > 20) issues.push('includeBodies supports at most 20 messages per page');
  if (name === 'create_contact' || name === 'update_contact') {
    if (Array.isArray(args.emails) && args.primaryEmail && !args.emails.includes(args.primaryEmail)) issues.push('primaryEmail must be included in emails');
  }
  if (name === 'create_project' || name === 'update_project') {
    if (Array.isArray(args.contactIds) && args.primaryContactId && !args.contactIds.includes(args.primaryContactId)) issues.push('primaryContactId must be included in contactIds');
    if (name === 'create_project' && args.status === 'completed' && !args.stage) issues.push('completed projects must explicitly use stage=completed');
    if (name === 'update_project' && Object.hasOwn(args, 'status') !== Object.hasOwn(args, 'stage')) issues.push('status and stage must be updated together');
    if (args.status === 'completed' && args.stage && args.stage !== 'completed') issues.push('completed projects must use stage=completed');
    if (args.status === 'active' && args.stage === 'completed') issues.push('active projects cannot use stage=completed');
  }
  if (issues.length) throw new Error(`INVALID_TOOL_ARGUMENTS: ${issues.join('; ')}`);
  return args;
}
