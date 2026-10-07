/* Actual CLI and MCP subprocesses against the disposable Nest/PostgreSQL fixture. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolve } = require('node:path');

exports.run = async function run({ baseUrl, token, prisma }) {
  const url = new URL(baseUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const env = { ...process.env, AI_MAIL_API_URL: baseUrl, AI_MAIL_API_TOKEN: token };
  const prefix = `crm-http-${randomUUID()}`;
  const operation = name => `${prefix}-${name}`;
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
  const cli = args => new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/ai-mail.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI fixture timeout')); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`CLI ${args[0]} failed: ${stderr.split(token).join('[redacted]')}`));
      try { resolvePromise(JSON.parse(stdout)); } catch { reject(new Error(`CLI ${args[0]} did not return JSON`)); }
    });
  });
  const json = JSON.stringify;
  const request = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: json(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const extract = (value, key) => value[key] ?? value;
  const snapshot = async () => {
    const mails = await prisma.emailMessage.findMany({ orderBy: { id: 'asc' }, select: { id: true, rawSource: true, bodyText: true } });
    return mails.map(row => ({ id: row.id, raw: Buffer.from(row.rawSource).toString('base64'), body: row.bodyText }));
  };
  const beforeMail = await snapshot();
  const contactInput = { displayName: 'Anna Fischer', emails: ['anna@nordlicht.invalid'], notes: 'CLI fixture', operationId: operation('contact-create'), actorId: 'fixture-cli' };
  const contact = extract(await cli(['contact-create', json(contactInput)]), 'contact');
  check(Boolean(contact.id), 'CLI creates contact');
  const contactReplay = extract(await cli(['contact-create', json(contactInput)]), 'contact');
  check(contactReplay.id === contact.id, 'CLI contact creation is idempotent');
  const company = extract(await cli(['company-create', json({ name: 'Nordlicht Energie', contactIds: [contact.id], website: 'https://nordlicht.invalid/', operationId: operation('company-create') })]), 'company');
  check(Boolean(company.id), 'CLI creates company from registered contact');
  const project = extract(await cli(['project-create', json({ name: 'Berlin Retrofit 2026', companyId: company.id, contactIds: [contact.id], primaryContactId: contact.id, status: 'active', stage: 'design', operationId: operation('project-create') })]), 'project');
  check(Boolean(project.id), 'CLI creates project under company');
  const fetchedContact = extract(await cli(['contact-get', contact.id]), 'contact');
  check(fetchedContact.companyId === company.id, 'company links contact');
  await cli(['contact-update', contact.id, json({ notes: 'Changed via actual CLI', expectedVersion: fetchedContact.version, operationId: operation('contact-update') })]);
  const updatedContact = extract(await cli(['contact-get', contact.id]), 'contact');
  check(updatedContact.notes === 'Changed via actual CLI', 'CLI updates contact');
  const fetchedCompany = extract(await cli(['company-get', company.id]), 'company');
  await cli(['company-update', company.id, json({ address: 'Synthetic address', expectedVersion: fetchedCompany.version, operationId: operation('company-update') })]);
  check(extract(await cli(['company-get', company.id]), 'company').address === 'Synthetic address', 'CLI updates company');
  const fetchedProject = extract(await cli(['project-get', project.id]), 'project');
  await cli(['project-update', project.id, json({ description: 'Synthetic project update', expectedVersion: fetchedProject.version, operationId: operation('project-update') })]);
  check(extract(await cli(['project-get', project.id]), 'project').description === 'Synthetic project update', 'CLI updates project');
  const history = await cli(['contact-messages', contact.id, '--limit', '20']);
  check(history.total > 0 && history.messages.length > 0, 'CLI finds contact mail by registered address');
  const selectedMail = history.messages[0];
  const storedMail = await prisma.emailMessage.findUniqueOrThrow({ where: { id: selectedMail.id } });
  await cli(['message-project-set', selectedMail.id, json({ projectId: project.id, expectedVersion: storedMail.projectAssignmentVersion, operationId: operation('assignment') })]);
  check((await cli(['project-messages', project.id])).messages.some(row => row.id === selectedMail.id), 'CLI assigns source mail to project');
  const analysis = await cli(['project-analysis-start', project.id, json({ operationId: operation('analysis'), limit: 500 })]);
  const jobId = analysis.job?.id ?? analysis.id ?? analysis.jobId;
  check(Boolean(jobId), 'CLI starts project analysis');
  let status;
  for (let attempt = 0; attempt < 35; attempt++) {
    const current = await cli(['project-analysis-job', jobId]);
    status = current.job?.status ?? current.status;
    if (['completed', 'partial', 'failed', 'cancelled'].includes(status)) break;
    await new Promise(done => setTimeout(done, 500));
  }
  check(['completed', 'partial'].includes(status), `fake Provider job completed: ${status}`);
  check((await cli(['project-messages', project.id])).total > 0, 'project mail is queryable after analysis');

  const mcp = spawn(process.execPath, [resolve('scripts/ai-mail-mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; let sequence = 0; const pending = new Map();
  mcp.stderr.on('data', () => {});
  mcp.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let value; try { value = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(value.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(value.id); waiter.resolve(value); }
    }
  });
  const call = (method, params) => new Promise((resolvePromise, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP fixture timeout')); }, 20000);
    pending.set(id, { resolve: resolvePromise, timer });
    mcp.stdin.write(json({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args) => {
    const result = await call('tools/call', { name, arguments: args });
    assert.ok(!result.error && !result.result?.isError, `MCP ${name} succeeds`);
    return JSON.parse(result.result.content.find(item => item.type === 'text').text);
  };
  try {
    const inventory = await call('tools/list');
    check(['delete_contact', 'delete_company', 'delete_project'].every(name => inventory.result.tools.some(row => row.name === name)), 'MCP advertises all delete contracts');
    check(extract(await tool('get_project', { projectId: project.id }), 'project').id === project.id, 'MCP reads CLI-created project');
    const raceProject = extract(await cli(['project-create', json({ name: 'Concurrent delete fixture', companyId: company.id, contactIds: [contact.id], status: 'active', stage: 'planning', operationId: operation('race-project-create') })]), 'project');
    const raced = await Promise.all([
      request('POST', '/mail/tasks', { title: 'Concurrent fixture task', kind: 'action', ownerType: 'us', projectId: raceProject.id, operationId: operation('race-task') }),
      request('DELETE', `/mail/projects/${raceProject.id}`, { expectedVersion: raceProject.version, operationId: operation('race-delete') }),
    ]);
    check(raced.every(row => [200, 201, 404, 409].includes(row.status)), `concurrent writes return supported outcomes: ${json(raced.map(row => ({ status: row.status, code: row.body?.code, message: row.body?.message })))}`);
    check(raced.some(row => row.status >= 200 && row.status < 300), 'one concurrent write can commit');
    const raceState = await prisma.project.findUniqueOrThrow({ where: { id: raceProject.id } });
    const raceTasks = await prisma.task.findMany({ where: { projectId: raceProject.id, status: { in: ['open', 'in_progress', 'waiting'] } } });
    check(!(raceState.status === 'deleted' && raceTasks.length > 0), 'concurrent task create cannot leave active task under deleted project');
    for (const task of raceTasks) await cli(['task-update', task.id, json({ status: 'cancelled', expectedVersion: task.version, operationId: operation(`race-task-cancel-${task.id}`) })]);
    if (raceState.status !== 'deleted') {
      const latest = extract(await cli(['project-get', raceProject.id]), 'project');
      await cli(['project-delete', raceProject.id, json({ expectedVersion: latest.version, operationId: operation('race-delete-after-cancel') })]);
    }
    const mcpContact = extract(await tool('create_contact', { displayName: 'MCP contact', emails: [`mcp-${prefix}@test.invalid`], operationId: operation('mcp-contact-create') }), 'contact');
    check(Boolean(mcpContact.id), 'MCP creates a contact using same backend');
    await tool('update_contact', { contactId: mcpContact.id, notes: 'MCP changed', expectedVersion: mcpContact.version, operationId: operation('mcp-contact-update') });
    check(extract(await tool('get_contact', { contactId: mcpContact.id }), 'contact').notes === 'MCP changed', 'MCP updates contact');
    await tool('delete_contact', { contactId: mcpContact.id, expectedVersion: mcpContact.version + 1, operationId: operation('mcp-contact-delete') });
    check((await prisma.contact.findUnique({ where: { id: mcpContact.id } })).status === 'deleted', 'MCP contact delete preserves row');
    const deleteProjectInput = { expectedVersion: extract(await cli(['project-get', project.id]), 'project').version, operationId: operation('project-delete') };
    await cli(['project-delete', project.id, json(deleteProjectInput)]);
    await cli(['project-delete', project.id, json(deleteProjectInput)]);
    check((await prisma.project.findUnique({ where: { id: project.id } })).status === 'deleted', 'CLI project delete and replay preserve row');
    check(!(await cli(['projects'])).projects.some(row => row.id === project.id), 'deleted project hidden from list');
    check((await request('GET', `/mail/projects/${project.id}`)).status === 404, 'deleted project detail is unavailable');
    check((await request('POST', `/mail/projects/${project.id}/analysis`, { operationId: operation('deleted-analysis') })).status === 404, 'deleted project cannot start analysis');
    check((await request('POST', '/mail/tasks', { title: 'No resurrection', kind: 'action', ownerType: 'us', projectId: project.id, operationId: operation('deleted-task') })).status === 404, 'deleted project cannot receive new tasks');
    check((await request('PATCH', `/mail/projects/${project.id}/stage`, { status: 'active', stage: 'planning', expectedVersion: deleteProjectInput.expectedVersion + 1, operationId: operation('deleted-stage') })).status === 404, 'stage endpoint cannot reactivate deleted project');
    const deleteCompanyInput = { expectedVersion: extract(await cli(['company-get', company.id]), 'company').version, operationId: operation('company-delete') };
    await tool('delete_company', { companyId: company.id, ...deleteCompanyInput });
    check((await prisma.company.findUnique({ where: { id: company.id } })).status === 'deleted', 'MCP company soft delete succeeds after project removal');
    const deleteContactInput = { expectedVersion: extract(await cli(['contact-get', contact.id]), 'contact').version, operationId: operation('contact-delete') };
    await cli(['contact-delete', contact.id, json(deleteContactInput)]);
    check(!(await cli(['contacts'])).contacts.some(row => row.id === contact.id), 'deleted contact hidden from list');
    check(!(await cli(['companies'])).companies.some(row => row.id === company.id), 'deleted company hidden from list');
    assert.deepEqual(await snapshot(), beforeMail); checks += 1;
    const unauthorized = await fetch(`${baseUrl}/mail/projects/${project.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: json({ expectedVersion: 1, operationId: operation('unauthorized') }) });
    check(unauthorized.status === 401, 'DELETE requires authentication');
    check(await prisma.businessOperation.count({ where: { operationId: { startsWith: prefix } } }) >= 12, 'operations are audited');
    console.log(JSON.stringify({ suite: 'crm-cli-mcp-real-http', checks, provider: 'fake-only', databaseIsolated: true, originalMailPreserved: true, status }));
  } finally {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    mcp.stdin.end(); mcp.kill();
  }
};
