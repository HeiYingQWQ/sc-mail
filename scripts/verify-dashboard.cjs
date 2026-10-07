/* Regression checks for Dashboard workflows without accessing a live mailbox. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'apps/dashboard/app.js'), 'utf8');
const source = appSource.replace(/\}\)\(\);\s*$/, 'globalThis.testApp = { state, loadPage, openEmail, openTask, openReview, openContact, openCompany, openProject, contactEditor, companyEditor, projectEditor, projectAnalysisDialog, pagedSelect, requestScope, setTimezone, formatDate, formatApiError, closeDialog, createTopicDialog, content, dialogContent }; })();');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {};
    this.className = ''; this.dataset = {}; this.disabled = false; this.open = false; this._text = ''; this._value = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
      remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' '); },
      toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classList[add ? 'add' : 'remove'](name); },
    };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get value() { return this.tagName === 'SELECT' ? this.options.find(item => item.selected)?.value ?? this.options[0]?.value ?? '' : this._value; }
  set value(value) { this._value = String(value); if (this.tagName === 'SELECT') for (const option of this.options) option.selected = option.value === String(value); }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  toString() { return this.tagName === '#TEXT' ? this._text : `[object HTML${this.tagName[0]}${this.tagName.slice(1).toLowerCase()}Element]`; }
  append(...items) { for (let item of items) { if (!(item instanceof Element)) { const text = new Element('#text'); text.textContent = item; item = text; } item.parentElement = this; this.children.push(item); } }
  prepend(...items) { const existing = this.children; this.children = []; this.append(...items); this.children.push(...existing); }
  replaceChildren(...items) { this._text = ''; this.children = []; this.append(...items); }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  focus() {}
  closest(selector) {
    const tags = selector.split(',').map(value => value.trim().toUpperCase());
    for (let node = this; node; node = node.parentElement) if (tags.includes(node.tagName)) return node;
    return null;
  }
  querySelectorAll(selector) { return descendants(this).filter(node => selector.split(',').some(part => node.tagName === part.trim().toUpperCase())); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function find(node, predicate) { const found = descendants(node).find(predicate); assert.ok(found, 'Expected UI control not found'); return found; }
function button(node, label) { return find(node, child => child.tagName === 'BUTTON' && child.textContent === label); }
async function fire(node, event = 'click', extra = {}) {
  if (event === 'click' && node.tagName === 'SUMMARY' && node.parentElement?.tagName === 'DETAILS') node.parentElement.open = !node.parentElement.open;
  const emitted = { target: node, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  for (let current = node; current; current = current.parentElement) for (const listener of current.listeners[event] || []) await listener(emitted);
  return emitted;
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }; }

function harness(handler, authHandler) {
  const nodes = new Map(); const requests = []; const timers = new Map(); let nextTimerId = 1; let confirmCalls = 0;
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  get('#login').className = 'hidden'; get('#app').className = 'hidden';
  const context = {
    document: { querySelector: get, querySelectorAll: () => [], createElement: tag => new Element(tag), createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; } },
    Node: Element, Headers, URL, URLSearchParams, AbortController, Intl, Date, Number, String, Object, Array, Map, Set, Promise, Error, TypeError, JSON, crypto: webcrypto,
    setTimeout: (callback, delay = 0) => { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id), confirm: () => { confirmCalls++; return true; },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/auth/me')) return authHandler ? authHandler(url, options) : new Promise(() => {});
      return handler(url, options);
    },
  };
  vm.createContext(context); vm.runInContext(source, context, { filename: 'app.js' });
  const app = context.testApp; app.state.user = { id: 'dashboard-test', mustChangePassword: false }; app.setTimezone('Asia/Tokyo');
  return { app, get, requests, timers, confirmCalls: () => confirmCalls, async runTimer(delay) { const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay); assert.ok(entry, `Expected timer after ${delay}ms`); timers.delete(entry[0]); await entry[1].callback(); await flush(); } };
}
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('initial auth screen hides login until authentication resolves', () => {
  const html = fs.readFileSync(path.join(root, 'apps/dashboard/index.html'), 'utf8');
  assert.match(html, /id="auth-loading"/); assert.match(html, /id="login" class="login-screen hidden"/); assert.match(html, /id="app" class="app-shell hidden"/);
});

test('successful session restoration shows the app without showing login', async () => {
  const auth = deferred(); const h = harness(() => response({}), () => auth.promise);
  assert.ok(h.get('#login').classList.contains('hidden')); assert.ok(h.get('#app').classList.contains('hidden'));
  auth.resolve(response({ user: { email: 'test@example.com', mustChangePassword: true } })); await flush();
  assert.ok(h.get('#login').classList.contains('hidden')); assert.ok(!h.get('#app').classList.contains('hidden')); assert.ok(h.get('#auth-loading').classList.contains('hidden'));
});

test('an expired session shows login', async () => {
  const h = harness(() => response({}), () => response({ message: 'Expired session' }, 401)); await flush();
  assert.ok(!h.get('#login').classList.contains('hidden')); assert.ok(h.get('#app').classList.contains('hidden'));
});

test('session network failure keeps login hidden and can be retried', async () => {
  let attempts = 0;
  const h = harness(() => response({}), () => attempts++ ? response({ user: { email: 'test@example.com', mustChangePassword: true } }) : Promise.reject(new TypeError('offline')));
  await flush(); assert.ok(h.get('#login').classList.contains('hidden')); assert.ok(!h.get('#auth-loading').classList.contains('hidden'));
  await fire(button(h.get('.auth-loading-card'), '重试连接')); assert.equal(attempts, 2); assert.ok(!h.get('#app').classList.contains('hidden'));
});

test('session server error offers retry instead of presenting a signed-out session', async () => {
  const h = harness(() => response({}), () => response({ message: 'Service unavailable' }, 503)); await flush();
  assert.ok(h.get('#login').classList.contains('hidden')); assert.ok(button(h.get('.auth-loading-card'), '重试连接'));
});

test('overview requests all active tasks and only counts over-threshold waits', async () => {
  const h = harness(url => response(url.includes('/brief?') ? { timezone: 'America/New_York', emails: [], followUps: { waitingForCustomer: { count: 4, overThresholdCount: 0, complete: true } }, audit: {} } : url.includes('/classifications/summary') ? { total: 2, categories: [] } : { total: url.includes('/tasks?') ? 3 : 0 }));
  await h.app.loadPage('overview');
  assert.ok(h.requests.some(item => item.url.includes('tasks?status=active')));
  assert.match(h.app.content.textContent, /待办任务3所有未关闭任务/);
  assert.match(h.app.content.textContent, /客户等待超过阈值0 项0/);
  assert.equal(h.app.state.timezone, 'America/New_York');
});

for (const kind of ['success', 'failure', 'unauthorized']) test(`stale page ${kind} cannot replace the current page`, async () => {
  const pending = deferred();
  const h = harness(url => url.includes('/classifications/messages') ? pending.promise : response({ total: 0, companies: [] }));
  const old = h.app.loadPage('inbox'); await flush();
  await h.app.loadPage('companies');
  const before = h.app.content.textContent;
  if (kind === 'failure') pending.reject(new Error('old network failure'));
  else pending.resolve(response(kind === 'success' ? { total: 0, messages: [] } : { message: 'Expired' }, kind === 'unauthorized' ? 401 : 200));
  await old;
  assert.equal(h.app.state.page, 'companies'); assert.equal(h.app.content.textContent, before);
  assert.ok(h.app.state.user); assert.ok(h.requests.find(item => item.url.includes('/classifications/messages')).options.signal.aborted);
});

test('stale response parsing cannot replace a newer page', async () => {
  const body = deferred();
  const h = harness(url => url.includes('/classifications/messages') ? { ...response({}), json: () => body.promise } : response({ total: 0, companies: [] }));
  const old = h.app.loadPage('inbox'); await flush(); await h.app.loadPage('companies');
  body.resolve({ total: 0, messages: [] }); await old;
  assert.match(h.app.content.textContent, /公司列表/); assert.doesNotMatch(h.app.content.textContent, /商务收件箱/);
});

test('stale modal response cannot replace the next modal', async () => {
  const pending = deferred();
  const h = harness(url => url.endsWith('/old') ? pending.promise : response({ id: 'new', subject: 'new message', bodyText: 'current content' }));
  const old = h.app.openEmail('old'); await h.app.openEmail('new');
  pending.resolve(response({ subject: 'old message', bodyText: 'outdated content' })); await old;
  assert.match(h.app.dialogContent.textContent, /new message/); assert.doesNotMatch(h.app.dialogContent.textContent, /old message/);
});

test('closing a modal aborts its read request', async () => {
  const pending = deferred(); const h = harness(() => pending.promise);
  const read = h.app.openEmail('old'); h.app.closeDialog(); pending.reject(new Error('late failure')); await read;
  assert.ok(h.requests.find(item => item.url.endsWith('/old')).options.signal.aborted);
  assert.doesNotMatch(h.app.dialogContent.textContent, /late failure/);
});

test('picker can reach contact 101 and search without losing selection on load more', async () => {
  const h = harness(url => {
    const params = new URL(url, 'http://test').searchParams;
    const offset = Number(params.get('offset'));
    const contacts = params.get('search') ? [{ id: 'match', displayName: '搜索结果' }] : Array.from({ length: offset ? 1 : 100 }, (_, i) => ({ id: `c${offset + i}`, displayName: `Contact ${offset + i}` }));
    return response({ contacts, total: params.get('search') ? 1 : 101 });
  });
  const selection = h.app.pagedSelect({ path: '/mail/crm/contacts', key: 'contacts', label: item => item.displayName, search: true, request: h.app.requestScope() });
  await selection.ready; selection.select.value = 'c5'; await fire(button(selection.element, '加载更多'));
  assert.equal(selection.select.options.length, 102); assert.equal(selection.select.value, 'c5'); assert.ok(selection.select.options.some(option => option.value === 'c100'));
  find(selection.element, node => node.tagName === 'INPUT').value = '联系人'; await fire(button(selection.element, '搜索')); await flush();
  assert.equal(selection.select.options.length, 2); assert.ok(h.requests.some(item => item.url.includes('search=')));
});

test('picker ignores stale search results and retries the reset page', async () => {
  const oldSearch = deferred(); let fail = true;
  const h = harness(url => {
    const params = new URL(url, 'http://test').searchParams;
    if (params.get('search') === 'old') return oldSearch.promise;
    if (params.get('search') === 'retry' && fail) { fail = false; return Promise.reject(new Error('offline')); }
    return response({ contacts: [{ id: params.get('search') || 'initial', displayName: params.get('search') || 'initial' }], total: 1 });
  });
  const selection = h.app.pagedSelect({ path: '/mail/crm/contacts', key: 'contacts', label: item => item.displayName, search: true, request: h.app.requestScope() });
  await selection.ready; const input = find(selection.element, node => node.tagName === 'INPUT');
  input.value = 'old'; await fire(button(selection.element, '搜索')); input.value = 'new'; await fire(button(selection.element, '搜索')); await flush();
  oldSearch.resolve(response({ contacts: [{ id: 'old', displayName: 'old' }], total: 1 })); await flush();
  assert.equal(selection.select.options[1].value, 'new');
  input.value = 'retry'; await fire(button(selection.element, '搜索')); await flush(); await fire(button(selection.element, '重试加载'));
  assert.equal(selection.select.options[1].value, 'retry'); assert.match(h.requests.at(-1).url, /offset=0/);
});

test('task detail shows actual evidence, source links and deleted-source status', async () => {
  const h = harness(() => response({ title: 'Task', origin: 'email', createdFromMessage: { id: 'source', subject: 'Evidence mail' }, completedSourceDeletedAt: '2026-09-29T00:00:00Z', evidence: [{ evidenceType: 'partial', excerpt: '<script>untrusted evidence</script>', sourceMessage: { id: 'source', subject: 'Evidence mail' }, createdAt: '2026-09-29T00:00:00Z' }] }));
  await h.app.openTask('task');
  assert.match(h.app.dialogContent.textContent, /部分完成/); assert.match(h.app.dialogContent.textContent, /<script>untrusted evidence<\/script>/);
  assert.match(h.app.dialogContent.textContent, /完成来源：来源邮件已删除/); assert.ok(button(h.app.dialogContent, '创建来源：Evidence mail'));
  assert.ok(descendants(h.app.dialogContent).every(node => node.tagName !== 'SCRIPT'));
});

test('empty-topic review offers create-and-assign and retries assignment without another create', async () => {
  let creates = 0; let attempts = 0; const operations = [];
  const h = harness((url, options) => {
    if (url.endsWith('/topics')) { creates++; assert.equal(JSON.parse(options.body).actorId, 'dashboard-user'); return response({ id: 'new-topic' }); }
    if (url.endsWith('/resolve')) { const body = JSON.parse(options.body); operations.push(body.operationId); assert.equal(body.topicId, 'new-topic'); return response(attempts++ ? {} : { message: 'Try again' }, attempts === 1 ? 503 : 200); }
    if (url.endsWith('/reviews/review')) return response({ status: 'pending', reasonCode: 'TOPIC_UNRESOLVED', sourceMessage: { id: 'mail', projectId: 'project' } });
    if (url.endsWith('/projects/project')) return response({ topics: [] });
    return response({ total: 0, items: [] });
  });
  h.app.state.page = 'reviews'; await h.app.openReview('review'); await fire(button(h.app.dialogContent, '新建 Topic 并分配'));
  const form = find(h.app.dialogContent, node => node.tagName === 'FORM'); find(form, node => node.name === 'name').value = 'Design';
  await fire(form, 'submit'); await fire(form, 'submit');
  assert.equal(creates, 1); assert.equal(attempts, 2); assert.equal(operations[0], operations[1]);
});

test('business timezone drives formatting and task creation defaults', async () => {
  const h = harness(url => response(url.includes('/integrations/status') ? { dailyBrief: { timezone: 'America/Los_Angeles' } } : { total: 1, tasks: [{ title: 'Task', project: { name: 'Visible project' } }] }));
  h.app.state.timezone = null; await h.app.loadPage('tasks');
  assert.equal(h.app.state.timezone, 'America/Los_Angeles'); assert.match(h.app.content.textContent, /Visible project/);
  const date = '2026-01-01T00:30:00Z'; const expected = new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
  assert.equal(h.app.formatDate(date), expected); await fire(button(h.app.content, '+ 新建任务'));
  assert.equal(find(h.app.dialogContent, node => node.name === 'deadlineTimezone').value, 'America/Los_Angeles');
  await h.app.loadPage('tasks'); assert.equal(h.requests.filter(item => item.url.includes('/integrations/status')).length, 1);
});

test('classification selector includes blacklisted mail', async () => {
  const h = harness(() => response({ total: 0, messages: [] })); await h.app.loadPage('inbox');
  const select = find(h.app.content, node => node.id === 'inbox-classification');
  assert.ok(select.options.some(option => option.value === 'BLACKLISTED' && option.textContent === '发送方黑名单'));
});

test('contact history can load older pages', async () => {
  const h = harness(() => response({ contact: { displayName: 'Contact', emails: [] }, total: 21, messages: [] }));
  await h.app.openContact('contact'); await fire(button(h.app.dialogContent, '下一页'));
  assert.ok(h.requests.some(item => item.url.endsWith('/messages?limit=20&offset=20')));
});

test('manual contact search accepts a single CJK character and keeps auto contacts out of the normal list', async () => {
  const h = harness(url => {
    const search = new URL(url, 'http://test').searchParams.get('search');
    if (url.includes('/crm/contacts')) return response(search === '李'
      ? { total: 1, contacts: [{ id: 'manual', displayName: '李敏', status: 'confirmed', emails: [{ email: 'li@example.test', isPrimary: true }] }] }
      : { total: 1, contacts: [{ id: 'auto', displayName: 'Auto pending', status: 'provisional', emails: [] }] });
    return response({ total: 0, tasks: [], companies: [], projects: [], messages: [] });
  });
  await h.app.loadPage('contacts');
  assert.doesNotMatch(h.app.content.textContent, /Auto pending/);
  const search = find(h.app.content, node => node.tagName === 'INPUT' && node.attributes['aria-label'] === '按联系人姓名或邮箱搜索');
  search.value = '李'; await fire(button(h.app.content, '搜索')); await flush();
  const request = h.requests.find(item => item.url.includes('/crm/contacts?') && item.url.includes('search='));
  assert.ok(request); assert.equal(new URL(request.url, 'http://test').searchParams.get('search'), '李');
  assert.match(h.app.content.textContent, /李敏/); assert.doesNotMatch(h.app.content.textContent, /Auto pending/);
});

test('contact history matches multiple registered emails and shows CC participation while preserving inclusive filters', async () => {
  const h = harness(url => {
    if (url.endsWith('/crm/contacts/contact-1')) return response({ contact: { id: 'contact-1', displayName: 'Alice', notes: 'Buyer', version: 6, emails: [{ email: 'Alice@Example.test', isPrimary: true }, { email: 'alice.work@example.test', isPrimary: false }], company: { name: 'Acme' } } });
    if (url.includes('/crm/contacts/contact-1/messages')) return response({ contact: { id: 'contact-1' }, total: 1, freshness: { timezone: 'Europe/Rome', fromDate: '2026-09-01', throughDate: '2026-09-30' }, messages: [{ id: 'mail-1', subject: 'CC project update', direction: 'inbound', participantRoles: ['cc'], matchedEmails: ['alice.work@example.test'], project: { name: 'Expo' }, receivedAt: '2026-09-20T10:00:00Z' }] });
    if (url.includes('/mail/projects?')) return response({ total: 1, projects: [{ id: 'project-1', name: 'Expo' }] });
    return response({ total: 0, projects: [] });
  });
  await h.app.openContact('contact-1');
  assert.match(h.app.dialogContent.textContent, /Alice@Example\.test/); assert.match(h.app.dialogContent.textContent, /alice\.work@example\.test/);
  assert.match(h.app.dialogContent.textContent, /抄送/); assert.match(h.app.dialogContent.textContent, /Buyer/);
  const project = find(h.app.dialogContent, node => node.tagName === 'SELECT' && node.options.some(item => item.value === 'project-1'));
  project.value = 'project-1';
  const dates = descendants(h.app.dialogContent).filter(node => node.tagName === 'INPUT' && node.type === 'date');
  dates[0].value = '2026-09-01'; dates[1].value = '2026-09-30';
  await fire(button(h.app.dialogContent, '筛选往来')); await flush();
  const request = h.requests.filter(item => item.url.includes('/crm/contacts/contact-1/messages')).at(-1);
  const query = new URL(request.url, 'http://test').searchParams;
  assert.equal(query.get('projectId'), 'project-1'); assert.equal(query.get('fromDate'), '2026-09-01'); assert.equal(query.get('throughDate'), '2026-09-30');
});

test('company detail opens safe website links and keeps untrusted website text inert', async () => {
  const h = harness(() => response({ company: { id: 'company-1', name: 'Acme', website: 'javascript:alert(1)', address: 'Milan', notes: '<img src=x onerror=alert(1)>', version: 2 }, contacts: [{ id: 'contact-1', displayName: 'Alice', emails: [{ email: 'a@example.test' }], notes: 'Buyer' }], projects: [{ id: 'project-1', name: 'Expo', status: 'completed', stage: 'completed', projectContacts: [{ contact: { displayName: 'Alice' } }] }] }));
  await h.app.openCompany('company-1');
  assert.match(h.app.dialogContent.textContent, /官网地址未显示为链接：javascript:alert\(1\)/);
  assert.match(h.app.dialogContent.textContent, /&lt;img|<img src=x onerror=alert\(1\)>/);
  assert.equal(h.app.dialogContent.querySelectorAll('a').length, 0);
  assert.equal(h.app.dialogContent.querySelectorAll('IMG').length, 0);
  assert.match(h.app.dialogContent.textContent, /Milan/); assert.match(h.app.dialogContent.textContent, /Alice/); assert.match(h.app.dialogContent.textContent, /已完成/);
});

test('company and project creation send explicit members, company ownership, and coherent lifecycle fields', async () => {
  const writes = [];
  const person = { id: 'contact-1', displayName: 'Alice', status: 'confirmed', emails: [{ email: 'a@example.test' }] };
  const company = { id: 'company-1', name: 'Acme', contacts: [person] };
  const h = harness((url, options = {}) => {
    if (options.method === 'POST') { const write = { url, body: JSON.parse(options.body) }; writes.push(write); return response(write.url.endsWith('/crm/companies') ? { company: { id: 'company-1', ...write.body } } : { project: { id: 'project-1', ...write.body } }, 201); }
    if (url.includes('/crm/contacts?')) return response({ total: 1, contacts: [person] });
    if (url.endsWith('/crm/companies/company-1')) return response({ company, contacts: [person], projects: [] });
    if (url.includes('/crm/companies?')) return response({ total: 1, companies: [company] });
    if (url.includes('/crm/companies')) return response({ total: 1, companies: [company] });
    if (url.includes('/mail/projects?')) return response({ total: 0, projects: [] });
    return response({ total: 0, companies: [], projects: [], tasks: [], messages: [] });
  });
  h.app.state.page = 'companies'; await h.app.companyEditor(); await flush();
  const companyForm = find(h.app.dialogContent, node => node.tagName === 'FORM');
  find(companyForm, node => node.name === 'name').value = 'Acme';
  find(companyForm, node => node.name === 'website').value = 'https://acme.example';
  find(companyForm, node => node.name === 'address').value = 'Milan';
  find(companyForm, node => node.name === 'notes').value = 'Selected member only';
  const member = find(companyForm, node => node.type === 'checkbox' && node.value === 'contact-1'); member.checked = true; await fire(member, 'change');
  await fire(companyForm, 'submit'); await flush();
  assert.equal(writes[0].url, '/api/v1/mail/crm/companies');
  assert.deepEqual({ name: writes[0].body.name, website: writes[0].body.website, address: writes[0].body.address, notes: writes[0].body.notes, contactIds: writes[0].body.contactIds }, { name: 'Acme', website: 'https://acme.example', address: 'Milan', notes: 'Selected member only', contactIds: ['contact-1'] });
  assert.ok(writes[0].body.operationId); assert.equal(writes[0].body.actorId, 'dashboard-user');

  h.app.state.page = 'projects'; await h.app.projectEditor(); await flush();
  const projectForm = find(h.app.dialogContent, node => node.tagName === 'FORM');
  find(projectForm, node => node.name === 'name').value = '2026 Expo';
  find(projectForm, node => node.name === 'description').value = 'Milan / 2026';
  const companySelect = find(projectForm, node => node.tagName === 'SELECT' && node.options.some(item => item.value === 'company-1'));
  companySelect.value = 'company-1'; await fire(companySelect, 'change'); await flush();
  const projectMember = find(projectForm, node => node.type === 'checkbox' && node.value === 'contact-1'); projectMember.checked = true; await fire(projectMember, 'change');
  const status = find(projectForm, node => node.tagName === 'SELECT' && node.options.some(item => item.value === 'completed') && node.parentElement.textContent.includes('项目状态'));
  status.value = 'completed'; await fire(status, 'change');
  await fire(projectForm, 'submit'); await flush();
  const projectWrite = writes.find(write => write.url === '/api/v1/mail/projects');
  assert.ok(projectWrite); assert.equal(projectWrite.body.companyId, 'company-1'); assert.deepEqual(projectWrite.body.contactIds, ['contact-1']);
  assert.equal(projectWrite.body.primaryContactId, 'contact-1'); assert.equal(projectWrite.body.status, 'completed'); assert.equal(projectWrite.body.stage, 'completed');
  assert.equal(projectWrite.body.description, 'Milan / 2026'); assert.ok(projectWrite.body.operationId);
});

test('company edits cannot submit an empty member set', async () => {
  let writeCount = 0;
  const person = { id: 'contact-1', displayName: 'Alice', emails: [{ email: 'a@example.test' }] };
  const h = harness((url, options = {}) => {
    if (options.method === 'PATCH') writeCount++;
    if (url.includes('/crm/contacts?')) return response({ contacts: [person], total: 1 });
    if (url.includes('/crm/companies?')) return response({ companies: [], total: 0 });
    return response({ total: 0 });
  });
  h.app.companyEditor({ id: 'company-1', version: 2, name: 'Acme', contacts: [person] }); await flush();
  const form = find(h.app.dialogContent, node => node.tagName === 'FORM');
  const member = find(form, node => node.type === 'checkbox' && node.value === 'contact-1');
  member.checked = false; await fire(member, 'change'); await fire(form, 'submit'); await flush();
  assert.equal(writeCount, 0); assert.match(h.get('#notice').textContent, /至少需要一位/);
});

test('project-analysis review shows named evidence and manually locks a selected no-project decision', async () => {
  let write;
  const h = harness((url, options = {}) => {
    if (url.endsWith('/mail/reviews/review-analysis')) return response({ id: 'review-analysis', entityType: 'email_message', entityId: 'message-1', status: 'pending', reasonCode: 'PROJECT_ANALYSIS_NEW_OPPORTUNITY', confidence: 0.71, proposedChangeJson: { reason: '内容提到下一年度合作。', candidates: [{ id: 'project-id-hidden', name: '2025 展会', status: 'completed' }], evidence: [{ excerpt: '明年我们再讨论新的展台合作。' }] }, sourceMessage: { id: 'message-1', subject: '明年合作', classification: 'BUSINESS_HUMAN', receivedAt: '2026-09-30T10:00:00Z' } });
    if (url.endsWith('/mail/messages/by-id/message-1')) return response({ id: 'message-1', projectAssignmentVersion: 12, projectManualOverride: false });
    if (options.method === 'PATCH' && url.endsWith('/mail/messages/by-id/message-1/project')) { write = { url, body: JSON.parse(options.body) }; return response({ id: 'message-1', projectId: null, projectAssignmentVersion: 13 }); }
    if (url.includes('/mail/reviews?')) return response({ items: [], total: 0 });
    return response({ projects: [], total: 0 });
  });
  await h.app.openReview('review-analysis');
  assert.match(h.app.dialogContent.textContent, /新合作机会待确认/);
  assert.match(h.app.dialogContent.textContent, /2025 展会/);
  assert.match(h.app.dialogContent.textContent, /明年我们再讨论/);
  assert.doesNotMatch(h.app.dialogContent.textContent, /project-id-hidden/);
  await fire(button(h.app.dialogContent, '确认非项目并锁定')); await flush();
  assert.equal(h.confirmCalls(), 0);
  const confirmation = find(h.app.dialogContent, node => node.classList.contains('project-assignment-confirmation'));
  assert.equal(write, undefined, 'assignment must wait until the in-page confirmation is activated');
  await fire(button(confirmation, '确认非项目并锁定')); await flush();
  assert.equal(write.url, '/api/v1/mail/messages/by-id/message-1/project');
  assert.deepEqual(write.body, { projectId: null, expectedVersion: 12, operationId: write.body.operationId });
  assert.ok(write.body.operationId);
});

test('legacy project review creates and assigns only through the company-member project form', async () => {
  let write;
  const person = { id: 'contact-1', displayName: 'Alice', status: 'confirmed', emails: [{ email: 'a@example.test' }] };
  const company = { id: 'company-1', name: 'Acme', contacts: [person] };
  const h = harness((url, options = {}) => {
    if (url.endsWith('/mail/reviews/review-legacy')) return response({ id: 'review-legacy', entityType: 'email_message', entityId: 'message-1', status: 'pending', reasonCode: 'PROJECT_UNRESOLVED', sourceMessage: { id: 'message-1', subject: 'Expo', classification: 'BUSINESS_HUMAN' }, proposedChangeJson: {} });
    if (url.includes('/mail/projects?')) return response({ projects: [], total: 0 });
    if (url.includes('/mail/crm/companies?')) return response({ companies: [company], total: 1 });
    if (url.endsWith('/mail/crm/companies/company-1')) return response({ company, contacts: [person], projects: [] });
    if (options.method === 'POST' && url.endsWith('/mail/reviews/review-legacy/resolve')) { write = { url, body: JSON.parse(options.body) }; return response({ status: 'resolved' }); }
    if (url.includes('/mail/reviews?')) return response({ items: [], total: 0 });
    return response({ total: 0, companies: [], projects: [] });
  });
  await h.app.openReview('review-legacy');
  await fire(button(h.app.dialogContent, '新建项目并分配')); await flush();
  const form = find(h.app.dialogContent, node => node.tagName === 'FORM');
  find(form, node => node.name === 'name').value = '2027 Expo';
  const companySelect = find(form, node => node.tagName === 'SELECT' && node.options.some(item => item.value === 'company-1'));
  companySelect.value = 'company-1'; await fire(companySelect, 'change'); await flush();
  const member = find(form, node => node.type === 'checkbox' && node.value === 'contact-1'); member.checked = true; await fire(member, 'change');
  find(form, node => node.name === 'description').value = 'Next annual event';
  await fire(form, 'submit'); await flush();
  assert.equal(write.url, '/api/v1/mail/reviews/review-legacy/resolve');
  assert.equal(write.body.action, 'create_project'); assert.equal(write.body.projectName, '2027 Expo');
  assert.equal(write.body.companyId, 'company-1'); assert.deepEqual(write.body.contactIds, ['contact-1']);
  assert.equal(write.body.primaryContactId, 'contact-1'); assert.equal(write.body.status, 'active'); assert.equal(write.body.stage, 'planning');
  assert.equal(write.body.description, 'Next annual event'); assert.ok(write.body.operationId);
});

test('project analysis scope overflow tells the user how to narrow the date range', () => {
  const message = harness(() => response({})).app.formatApiError({ message: { code: 'PROJECT_ANALYSIS_SCOPE_TOO_LARGE', totalCandidateCount: 640, limit: 500 } }, 409);
  assert.match(message, /640 封候选邮件/); assert.match(message, /上限 500 封/); assert.match(message, /缩小日期范围/);
});

test('contact creation preserves normalized multiple email values and manual data', async () => {
  let write;
  const h = harness((url, options = {}) => {
    if (options.method === 'POST') { write = { url, body: JSON.parse(options.body) }; return response({ contact: { id: 'contact-new' } }, 201); }
    if (url.includes('/crm/companies?')) return response({ total: 0, companies: [] });
    if (url.includes('/crm/contacts?')) return response({ total: 0, contacts: [] });
    return response({ total: 0, emails: [], followUps: {}, categories: [], tasks: [], companies: [] });
  });
  h.app.state.page = 'contacts'; h.app.contactEditor(); await flush();
  const form = find(h.app.dialogContent, node => node.tagName === 'FORM');
  find(form, node => node.name === 'displayName').value = 'Alice';
  find(form, node => node.name === 'emails').value = 'Alice@Example.test\nalice.work@example.test';
  find(form, node => node.name === 'primaryEmail').value = 'Alice@Example.test';
  find(form, node => node.name === 'notes').value = 'Purchasing contact';
  await fire(form, 'submit'); await flush();
  assert.equal(write.url, '/api/v1/mail/crm/contacts');
  assert.deepEqual({ displayName: write.body.displayName, emails: write.body.emails, primaryEmail: write.body.primaryEmail, companyId: write.body.companyId, notes: write.body.notes }, {
    displayName: 'Alice', emails: ['alice@example.test', 'alice.work@example.test'], primaryEmail: 'alice@example.test', companyId: null, notes: 'Purchasing contact',
  });
  assert.equal(write.body.actorId, 'dashboard-user'); assert.ok(write.body.operationId);
});

test('manual message assignment sends CAS version and can lock no-project explicitly', async () => {
  const writes = [];
  const h = harness((url, options = {}) => {
    if (url.endsWith('/messages/by-id/message-1')) return response({ id: 'message-1', subject: 'New partnership', projectId: 'project-old', project: { id: 'project-old', name: 'Old project' }, projectAssignmentVersion: 9, projectManualOverride: false, bodyText: 'Current message only' });
    if (url.includes('/mail/projects?')) return response({ projects: [{ id: 'project-old', name: 'Old project', status: 'active' }], total: 1 });
    if (options.method === 'PATCH') { writes.push({ url, body: JSON.parse(options.body) }); return response({ messageId: 'message-1', projectId: null, projectResolutionStatus: 'unresolved', projectAssignmentVersion: 10 }); }
    if (url.includes('/mail/projects')) return response({ total: 0, projects: [] });
    return response({ total: 0 });
  });
  await h.app.openEmail('message-1'); await fire(button(h.app.dialogContent, '人工调整归属')); await flush();
  const form = find(h.app.dialogContent, node => node.tagName === 'FORM');
  const projectSelect = find(form, node => node.tagName === 'SELECT'); projectSelect.value = '';
  await fire(form, 'submit'); await flush();
  assert.equal(writes.length, 1); assert.equal(writes[0].url, '/api/v1/mail/messages/by-id/message-1/project');
  assert.equal(writes[0].body.projectId, null); assert.equal(writes[0].body.expectedVersion, 9); assert.ok(writes[0].body.operationId);
});

test('project detail renders a clickable company button and message participants from address fields', async () => {
  const h = harness(url => {
    if (url.endsWith('/mail/projects/project-1/summary')) return response({ summary: '', versions: [] });
    if (url.includes('/mail/projects/project-1/timeline?')) return response({ events: [] });
    if (url.includes('/mail/projects/project-1/messages?')) return response({ total: 1, messages: [{
      id: 'mail-1', subject: 'Berlin update', direction: 'inbound',
      fromJson: [{ name: 'Anna Fischer', address: 'anna@nordlicht.invalid' }],
      toJson: [{ name: 'SC Mail', address: 'mailbox@fixture.invalid' }],
      ccJson: [{ name: 'Morgan Reed', address: 'morgan@cedar.invalid' }], bccJson: [], receivedAt: '2026-09-20T10:00:00Z',
      projectReason: 'Sender confirms the commissioning date.',
      projectResolutionEvidence: [{ source_message_id: 'private-history-source-id', excerpt: 'The installer confirmed the commissioning date.' }],
    }] });
    if (url.endsWith('/mail/projects/project-1/analysis')) return response({ job: null });
    if (url.endsWith('/mail/projects/project-1')) return response({ project: { id: 'project-1', name: 'Berlin Retrofit 2026', company: { id: 'company-1', name: 'Nordlicht Energie' }, projectContacts: [], status: 'active', stage: 'planning', topics: [], tasks: [] } });
    if (url.endsWith('/mail/crm/companies/company-1')) return response({ company: { id: 'company-1', name: 'Nordlicht Energie' }, contacts: [], projects: [] });
    if (url.endsWith('/mail/messages/by-id/private-history-source-id')) return response({ id: 'private-history-source-id', subject: 'Commissioning date', bodyText: 'The installer confirmed the commissioning date.' });
    return response({ total: 0, projects: [] });
  });
  await h.app.openProject('project-1');
  const actions = find(h.app.dialogContent, node => node.classList.contains('project-header-actions'));
  let companyButton = button(actions, 'Nordlicht Energie');
  assert.equal(actions.children[0], companyButton); assert.equal(companyButton.disabled, false);
  assert.doesNotMatch(h.app.dialogContent.textContent, /\[object HTMLButtonElement\]/);
  assert.match(h.app.dialogContent.textContent, /发件人：Anna Fischer/);
  assert.match(h.app.dialogContent.textContent, /抄送：Morgan Reed/);
  assert.match(h.app.dialogContent.textContent, /The installer confirmed the commissioning date\./);
  assert.doesNotMatch(h.app.dialogContent.textContent, /private-history-source-id|source_message_id/);
  const historyEvidenceLink = button(h.app.dialogContent, '查看来源邮件'); assert.equal(historyEvidenceLink.disabled, false);
  await fire(historyEvidenceLink);
  assert.ok(h.requests.some(item => item.url === '/api/v1/mail/messages/by-id/private-history-source-id'));
  await h.app.openProject('project-1');
  const refreshedActions = find(h.app.dialogContent, node => node.classList.contains('project-header-actions'));
  companyButton = button(refreshedActions, 'Nordlicht Energie');
  await fire(companyButton);
  assert.ok(h.requests.some(item => item.url === '/api/v1/mail/crm/companies/company-1'));
  assert.match(h.app.dialogContent.textContent, /Nordlicht Energie/);
});

test('project detail tabs support ARIA keyboard navigation and scope dialog width to the project view', async () => {
  const h = harness(url => {
    if (url.endsWith('/mail/projects/project-tabs/summary')) return response({ summary: 'Current project progress', versions: [] });
    if (url.includes('/mail/projects/project-tabs/timeline?')) return response({ events: [] });
    if (url.includes('/mail/projects/project-tabs/messages?')) return response({ total: 0, messages: [] });
    if (url.endsWith('/mail/projects/project-tabs/analysis')) return response({ job: { id: 'job-existing', status: 'completed' } });
    if (url.includes('/mail/project-analysis/job-existing?')) return response({ job: { id: 'job-existing', status: 'completed', summaryStatus: 'completed' }, items: [], totalItems: 0 });
    if (url.endsWith('/mail/projects/project-tabs')) return response({ project: { id: 'project-tabs', name: 'Expo project', companyId: 'company-1', company: { id: 'company-1', name: 'Acme' }, projectContacts: [], status: 'active', stage: 'planning', topics: [], tasks: [] } });
    if (url.includes('/mail/crm/companies?')) return response({ total: 0, companies: [] });
    if (url.endsWith('/mail/crm/companies/company-1')) return response({ company: { id: 'company-1', name: 'Acme' }, contacts: [], projects: [] });
    return response({ total: 0, projects: [] });
  });
  await h.app.openProject('project-tabs');
  const dialog = h.get('#detail-dialog');
  assert.ok(dialog.classList.contains('project-detail-dialog'));
  const tabs = descendants(h.app.dialogContent).filter(node => node.attributes.role === 'tab');
  assert.deepEqual(tabs.map(tab => tab.textContent), ['概览', '邮件往来', '分析记录']);
  assert.equal(tabs[0].attributes['aria-selected'], 'true');
  const overview = find(h.app.dialogContent, node => node.attributes.role === 'tabpanel' && node.id === 'project-panel-overview');
  const mail = find(h.app.dialogContent, node => node.attributes.role === 'tabpanel' && node.id === 'project-panel-mail');
  const analysis = find(h.app.dialogContent, node => node.attributes.role === 'tabpanel' && node.id === 'project-panel-analysis');
  assert.equal(overview.hidden, false); assert.equal(mail.hidden, true); assert.equal(analysis.hidden, true);
  await fire(tabs[1]);
  assert.equal(mail.hidden, false); assert.equal(overview.hidden, true); assert.equal(find(h.app.dialogContent, node => node.classList.contains('project-sidebar')).hidden, true);
  const keyEvent = await fire(tabs[1], 'keydown', { key: 'End' });
  assert.equal(keyEvent.defaultPrevented, true); assert.equal(tabs[2].attributes['aria-selected'], 'true');
  assert.equal(analysis.hidden, false); assert.ok(find(h.app.dialogContent, node => node.classList.contains('project-workspace-main')).classList.contains('project-workspace-main-wide'));
  assert.ok(button(analysis, '分析邮件'), 'analysis action remains available when a job exists');
  await fire(button(analysis, '分析邮件')); await flush();
  assert.match(h.app.dialogContent.textContent, /分析项目邮件/);
  assert.equal(dialog.classList.contains('project-detail-dialog'), false, 'analysis form clears project-only sizing');
  assert.equal(h.requests.some(item => item.options.method === 'POST' && item.url.includes('/analysis')), false, 'opening the scope form does not start analysis');
  h.app.closeDialog();

  await h.app.openProject('project-tabs');
  await fire(button(h.app.dialogContent, '编辑项目')); await flush();
  assert.match(h.app.dialogContent.textContent, /编辑项目/);
  assert.equal(dialog.classList.contains('project-detail-dialog'), false, 'project editor uses the ordinary form dialog');
  h.app.closeDialog();
  await h.app.openProject('project-tabs');
  assert.equal(dialog.dataset.activeProjectTab, 'overview', 'opening a project from the list starts on overview');
  assert.equal(dialog.classList.contains('project-detail-dialog'), true);
  await fire(dialog, 'cancel');
  assert.equal(dialog.open, false); assert.equal(dialog.classList.contains('project-detail-dialog'), false);
  assert.equal(dialog.dataset.activeProjectTab, '');
});

test('expanding project email evidence does not open the row and its source link opens the right email', async () => {
  const h = harness(url => {
    if (url.endsWith('/mail/projects/project-evidence/summary')) return response({ summary: '', versions: [] });
    if (url.includes('/mail/projects/project-evidence/timeline?')) return response({ events: [] });
    if (url.includes('/mail/projects/project-evidence/messages?')) return response({ total: 1, messages: [{
      id: 'project-mail-row', subject: 'Project update', direction: 'inbound', receivedAt: '2026-09-20T10:00:00Z',
      projectReason: 'The sender confirmed the delivery milestone.',
      projectResolutionEvidence: [{ source_message_id: 'evidence-source-mail', excerpt: 'Delivery will arrive on Thursday.' }],
    }] });
    if (url.endsWith('/mail/projects/project-evidence/analysis')) return response({ job: null });
    if (url.endsWith('/mail/projects/project-evidence')) return response({ project: { id: 'project-evidence', name: 'Evidence project', company: { id: 'company-1', name: 'Acme' }, projectContacts: [], status: 'active', stage: 'planning', topics: [], tasks: [] } });
    if (url.endsWith('/mail/messages/by-id/evidence-source-mail')) return response({ id: 'evidence-source-mail', subject: 'Source email', bodyText: 'Delivery will arrive on Thursday.' });
    return response({ total: 0, projects: [] });
  });
  await h.app.openProject('project-evidence');
  const mailTab = find(h.app.dialogContent, node => node.attributes.role === 'tab' && node.textContent === '邮件往来');
  await fire(mailTab);
  const evidence = find(h.app.dialogContent, node => node.classList.contains('analysis-evidence-details'));
  const readBefore = h.requests.filter(item => item.url.endsWith('/mail/messages/by-id/project-mail-row') || item.url.endsWith('/mail/messages/by-id/evidence-source-mail')).length;
  await fire(evidence.firstElementChild);
  assert.equal(evidence.open, true, 'native summary click expands without navigating the table row');
  assert.equal(h.requests.filter(item => item.url.includes('/mail/messages/by-id/')).length, readBefore);
  assert.equal(find(h.app.dialogContent, node => node.id === 'project-panel-mail').hidden, false);
  await fire(button(evidence, '查看来源邮件'));
  assert.ok(h.requests.some(item => item.url === '/api/v1/mail/messages/by-id/evidence-source-mail'));
  assert.match(h.app.dialogContent.textContent, /Source email/);
  assert.equal(h.get('#detail-dialog').classList.contains('project-detail-dialog'), false);
});

test('project-analysis review uses an in-page confirmation before CAS assignment', async () => {
  const writes = [];
  const h = harness((url, options = {}) => {
    if (url.endsWith('/mail/reviews/review-1')) return response({
      id: 'review-1', entityType: 'email_message', entityId: 'review-mail-1', reasonCode: 'PROJECT_ANALYSIS_UNCERTAIN', status: 'pending',
      sourceMessage: { id: 'review-mail-1', subject: 'Possible new project', classification: 'business', receivedAt: '2026-09-25T10:00:00Z' },
      proposedChangeJson: { reason: 'The message mentions a future project without matching the current scope.', candidates: [] },
    });
    if (url.endsWith('/mail/messages/by-id/review-mail-1')) return response({ id: 'review-mail-1', projectAssignmentVersion: 7, projectManualOverride: false });
    if (url.includes('/mail/projects?')) return response({ total: 0, projects: [] });
    if (url.endsWith('/mail/messages/by-id/review-mail-1/project') && options.method === 'PATCH') {
      writes.push(JSON.parse(options.body)); return response({ messageId: 'review-mail-1', projectId: null, projectAssignmentVersion: 8 });
    }
    if (url.endsWith('/mail/reviews?')) return response({ total: 0, reviews: [] });
    return response({ total: 0 });
  });
  await h.app.openReview('review-1'); await flush();
  await fire(button(h.app.dialogContent, '确认非项目并锁定'));
  assert.equal(h.confirmCalls(), 0, 'the confirmation must not invoke a native JavaScript dialog');
  const confirmation = find(h.app.dialogContent, node => node.classList.contains('project-assignment-confirmation'));
  assert.match(confirmation.textContent, /确认为非项目邮件并记录为人工锁定/);
  assert.equal(confirmation.attributes.role, 'group');
  assert.equal(writes.length, 0, 'showing confirmation alone must not change assignment');
  await fire(button(confirmation, '确认非项目并锁定')); await flush();
  assert.equal(writes.length, 1); assert.equal(writes[0].projectId, null); assert.equal(writes[0].expectedVersion, 7); assert.ok(writes[0].operationId);
});

test('project-analysis review dismissal uses an in-page confirmation', async () => {
  let write;
  const h = harness((url, options = {}) => {
    if (url.endsWith('/mail/reviews/review-dismiss')) return response({
      id: 'review-dismiss', entityType: 'email_message', entityId: 'dismiss-mail', reasonCode: 'PROJECT_ANALYSIS_UNCERTAIN', status: 'pending',
      sourceMessage: { id: 'dismiss-mail', subject: 'Possible project update' }, proposedChangeJson: { reason: 'Could not confidently match a project.' },
    });
    if (url.endsWith('/mail/messages/by-id/dismiss-mail')) return response({ id: 'dismiss-mail', projectAssignmentVersion: 3, projectManualOverride: false });
    if (url.endsWith('/mail/reviews/review-dismiss/resolve') && options.method === 'POST') {
      write = JSON.parse(options.body); return response({ status: 'resolved' });
    }
    if (url.includes('/mail/reviews?')) return response({ reviews: [], total: 0 });
    return response({ projects: [], total: 0 });
  });
  await h.app.openReview('review-dismiss');
  await fire(button(h.app.dialogContent, '忽略此项'));
  assert.equal(h.confirmCalls(), 0); assert.equal(write, undefined);
  const confirmation = find(h.app.dialogContent, node => node.classList.contains('review-action-confirmation'));
  assert.match(confirmation.textContent, /标记为已处理/);
  await fire(button(confirmation, '确认忽略')); await flush();
  assert.equal(write.action, 'dismiss'); assert.equal(write.actorId, 'dashboard-user'); assert.ok(write.operationId);
});

test('cancelling project analysis uses an in-page confirmation and keeps operationId', async () => {
  let cancelWrite;
  let status = 'processing';
  const h = harness((url, options = {}) => {
    if (url.endsWith('/mail/projects/project-cancel/summary')) return response({ summary: '', versions: [] });
    if (url.includes('/mail/projects/project-cancel/timeline?')) return response({ events: [] });
    if (url.includes('/mail/projects/project-cancel/messages?')) return response({ total: 0, messages: [] });
    if (url.endsWith('/mail/projects/project-cancel/analysis')) return response({ job: { id: 'job-cancel', status } });
    if (url.includes('/mail/project-analysis/job-cancel?')) return response({ job: { id: 'job-cancel', status }, items: [], totalItems: 0 });
    if (url.endsWith('/mail/project-analysis/job-cancel/cancel') && options.method === 'POST') {
      cancelWrite = JSON.parse(options.body); status = 'cancelled'; return response({ status });
    }
    if (url.endsWith('/mail/projects/project-cancel')) return response({ project: { id: 'project-cancel', name: 'Test project', status: 'active', stage: 'planning', projectContacts: [], topics: [], tasks: [] } });
    return response({ total: 0, projects: [] });
  });
  await h.app.openProject('project-cancel');
  await fire(button(h.app.dialogContent, '取消未开始部分'));
  assert.equal(h.confirmCalls(), 0); assert.equal(cancelWrite, undefined);
  const confirmation = find(h.app.dialogContent, node => node.classList.contains('analysis-cancel-confirmation'));
  assert.match(confirmation.textContent, /尚未领取的邮件/); assert.match(confirmation.textContent, /已完成的结果会保留/);
  await fire(button(confirmation, '确认取消分析')); await flush();
  assert.ok(cancelWrite.operationId); assert.equal(cancelWrite.operationId.length > 10, true);
  assert.equal(cancelWrite.action, undefined);
});

test('project analysis shows named assignment and evidence links without internal identifiers', async () => {
  const h = harness(url => {
    if (url.endsWith('/mail/projects/project-1/summary')) return response({ summary: '', versions: [] });
    if (url.includes('/mail/projects/project-1/timeline?')) return response({ events: [] });
    if (url.includes('/mail/projects/project-1/messages?')) return response({ total: 0, messages: [] });
    if (url.endsWith('/mail/projects/project-1/analysis')) return response({ job: { id: 'job-1', status: 'completed' } });
    if (url.includes('/mail/project-analysis/job-1?')) return response({ job: { id: 'job-1', status: 'completed', summaryStatus: 'completed' }, totalItems: 2, items: [
      { id: 'private-analysis-item-id', messageId: 'current-mail-id', subject: 'Delivery confirmed', outcome: 'assigned', projectId: 'project-1', chosenProject: { id: 'project-1', name: 'Nordlicht Energie Retrofit' }, candidateProjectIds: ['project-1', 'project-2'], candidateProjects: [{ id: 'project-1', name: 'Nordlicht Energie Retrofit' }, { id: 'project-2', name: 'Cedar Point Packaging' }], evidence: [{ source_message_id: 'private-evidence-mail-id', excerpt: 'The site team confirmed the final delivery date.' }], reason: 'The sender confirms a date for the selected project.', status: 'completed' },
      { id: 'private-deleted-item-id', messageId: null, sourceDeletedAt: '2026-10-01T00:00:00Z', isSourceDeleted: true, subject: '[source deleted]', outcome: 'uncertain', candidateProjects: [], evidence: [{ source_message_id: 'private-deleted-mail-id', excerpt: 'Source excerpt retained for audit.' }], status: 'completed' },
    ] });
    if (url.endsWith('/mail/projects/project-1')) return response({ project: { id: 'project-1', name: 'Berlin Retrofit 2026', company: { id: 'company-1', name: 'Nordlicht Energie' }, projectContacts: [], status: 'active', stage: 'planning', topics: [], tasks: [] } });
    if (url.endsWith('/mail/messages/by-id/private-evidence-mail-id')) return response({ id: 'private-evidence-mail-id', subject: 'Evidence source', bodyText: 'The site team confirmed the final delivery date.', projectReason: 'A reviewer confirmed this project assignment.', projectResolutionEvidence: [{ source_message_id: 'private-parent-evidence-id', excerpt: 'The final delivery date is confirmed.' }] });
    if (url.endsWith('/mail/messages/by-id/private-parent-evidence-id')) return response({ id: 'private-parent-evidence-id', subject: 'Parent evidence', bodyText: 'The final delivery date is confirmed.' });
    return response({ total: 0, projects: [] });
  });
  await h.app.openProject('project-1');
  const resultText = h.app.dialogContent.textContent;
  assert.match(resultText, /已归属：Nordlicht Energie Retrofit/);
  assert.match(resultText, /其他候选：Cedar Point Packaging/);
  assert.match(resultText, /The site team confirmed the final delivery date\./);
  assert.doesNotMatch(resultText, /private-(?:analysis-item|evidence-mail|deleted-item|deleted-mail)-id|source_message_id/);
  const evidenceLink = button(h.app.dialogContent, '查看来源邮件'); assert.equal(evidenceLink.disabled, false);
  const deletedLink = button(h.app.dialogContent, '来源邮件已删除'); assert.equal(deletedLink.disabled, true);
  await fire(evidenceLink);
  assert.ok(h.requests.some(item => item.url === '/api/v1/mail/messages/by-id/private-evidence-mail-id'));
  assert.match(h.app.dialogContent.textContent, /A reviewer confirmed this project assignment\./);
  assert.match(h.app.dialogContent.textContent, /The final delivery date is confirmed\./);
  assert.doesNotMatch(h.app.dialogContent.textContent, /private-parent-evidence-id|source_message_id/);
  await fire(button(h.app.dialogContent, '查看来源邮件'));
  assert.ok(h.requests.some(item => item.url === '/api/v1/mail/messages/by-id/private-parent-evidence-id'));
});

test('project analysis range renders the serializer from and through fields', async () => {
  for (const fields of [
    { from: '2026-08-31T22:00:00.000Z', through: '2026-09-30T22:00:00.000Z' },
    { range: { from: '2026-08-31T22:00:00.000Z', through: '2026-09-30T22:00:00.000Z' } },
  ]) {
    const h = harness(url => {
      if (url.endsWith('/mail/projects/project-1/summary')) return response({ summary: '', versions: [] });
      if (url.includes('/mail/projects/project-1/timeline?')) return response({ events: [] });
      if (url.includes('/mail/projects/project-1/messages?')) return response({ total: 0, messages: [] });
      if (url.endsWith('/mail/projects/project-1/analysis')) return response({ job: { id: 'job-1', status: 'completed' } });
      if (url.includes('/mail/project-analysis/job-1?')) return response({ job: { id: 'job-1', status: 'completed', ...fields, summaryStatus: 'completed', candidateCount: 1, processedCount: 1 }, items: [], totalItems: 0 });
      if (url.endsWith('/mail/projects/project-1')) return response({ project: { id: 'project-1', name: 'Berlin Retrofit 2026', company: { id: 'company-1', name: 'Nordlicht Energie' }, projectContacts: [], status: 'active', stage: 'planning', topics: [], tasks: [] } });
      return response({ total: 0, projects: [] });
    });
    h.app.setTimezone('Europe/Rome');
    await h.app.openProject('project-1');
    const rangeRow = find(h.app.dialogContent, node => node.tagName === 'DIV' && node.children[0]?.textContent === '分析范围');
    assert.match(rangeRow.children[1].textContent, /2026\/09\/01 至 2026\/09\/30/);
  }
});

test('project-analysis terminal transition reloads the selected email page and current summary', async () => {
  let detailReads = 0; let summaryReads = 0; let messageReads = 0; let jobReads = 0; let terminal = false;
  const h = harness(url => {
    if (url.includes('/mail/projects/project-1/analysis')) return response({ job: { id: 'job-1', status: terminal ? 'completed' : 'processing' } });
    if (url.includes('/mail/project-analysis/job-1')) {
      jobReads++;
      const status = jobReads === 1 ? 'processing' : 'completed';
      if (status === 'completed') terminal = true;
      return response({ job: { id: 'job-1', status, candidateCount: 1, processedCount: status === 'completed' ? 1 : 0 }, totalItems: 1, items: status === 'completed' ? [{ id: 'item-1', messageId: 'hidden-message-id', subject: 'Customer confirms shipment', outcome: 'assigned', candidateProjects: [{ id: 'project-1', name: '2026 Expo' }], reason: 'Shipment references the project', status: 'completed' }] : [] });
    }
    if (url.endsWith('/mail/projects/project-1')) { detailReads++; return response({ project: { id: 'project-1', name: '2026 Expo', companyId: 'company-1', company: { id: 'company-1', name: 'Acme' }, projectContacts: [], status: 'active', stage: 'planning', topics: [], tasks: [] } }); }
    if (url.endsWith('/mail/projects/project-1/summary')) { summaryReads++; return response({ summaryId: 'summary-1', version: summaryReads, summary: `Fresh summary ${summaryReads}`, isDerived: true, manualOverride: false, stale: false, coverage: { stale: false }, versions: [] }); }
    if (url.includes('/mail/projects/project-1/timeline?')) return response({ total: 0, events: [] });
    if (url.includes('/mail/projects/project-1/messages?')) { messageReads++; return response({ total: messageReads, messages: [{ id: 'message-page-row', subject: 'Page 3 mail', direction: 'inbound', contact: { displayName: 'Alice' }, receivedAt: '2026-09-20T10:00:00Z' }] }); }
    return response({ total: 0, projects: [], tasks: [] });
  });
  await h.app.openProject('project-1', 40, { contactId: 'contact-1', fromDate: '2026-09-01', throughDate: '2026-09-30', direction: 'inbound' }, 'mail');
  assert.match(h.app.dialogContent.textContent, /Fresh summary 1/); assert.equal(messageReads, 1);
  await h.runTimer(2500);
  for (let attempt = 0; attempt < 20 && h.app.dialogContent.textContent.includes('正在加载项目资料'); attempt++) { await new Promise(resolve => setTimeout(resolve, 0)); await flush(); }
  assert.equal(detailReads, 2); assert.equal(summaryReads, 2); assert.equal(messageReads, 2);
  assert.equal(h.get('#detail-dialog').dataset.activeProjectTab, 'mail');
  assert.match(h.app.dialogContent.textContent, /Fresh summary 2/); assert.match(h.app.dialogContent.textContent, /Customer confirms shipment/);
  assert.match(h.app.dialogContent.textContent, /2026 Expo/); assert.doesNotMatch(h.app.dialogContent.textContent, /hidden-message-id/);
  const pageRequest = h.requests.filter(item => item.url.includes('/mail/projects/project-1/messages?')).at(-1);
  const query = new URL(pageRequest.url, 'http://test').searchParams;
  assert.equal(query.get('offset'), '40'); assert.equal(query.get('contactId'), 'contact-1'); assert.equal(query.get('throughDate'), '2026-09-30');
});

test('summary suggestions are sourced and adopted with the current summary version', async () => {
  const writes = []; let summaryReads = 0;
  const h = harness((url, options = {}) => {
    if (url.includes('/mail/projects/project-1/summary')) {
      summaryReads++;
      return response({ summaryId: 'summary-1', version: summaryReads === 1 ? 3 : 4, summary: 'Manually protected summary', currentVersionId: 'current', manualOverride: true, isDerived: false, stale: false, coverage: { stale: false, includedCount: 4, totalProjectMessageCount: 5, sourceIds: ['coverage-private-id'], claims: [{ text: 'Saved quote', evidence: [{ sourceMessageId: 'coverage-private-id', excerpt: 'Source quotation.' }] }] }, versions: [
        { id: 'current', version: 3, newSummary: 'Manually protected summary', isSuggestion: false, triggerMessageId: 'source-1', createdAt: '2026-09-29T00:00:00Z' },
        { id: 'suggestion', version: 5, newSummary: 'Suggested project update', isSuggestion: true, triggerMessageId: 'source-1', sourceDeletedAt: null, model: 'fixture-model', confidence: 0.9, createdAt: '2026-09-30T00:00:00Z' },
      ] });
    }
    if (options.method === 'POST') { const body = JSON.parse(options.body); writes.push({ url, body }); return response({ version: 4, manualOverride: true }); }
    if (url.endsWith('/mail/projects/project-1')) return response({ project: { id: 'project-1', name: 'Expo', company: { id: 'company-1', name: 'Acme' }, projectContacts: [], status: 'active', stage: 'planning', topics: [], tasks: [] } });
    if (url.includes('/mail/projects/project-1/timeline?')) return response({ events: [] });
    if (url.includes('/mail/projects/project-1/messages?')) return response({ total: 0, messages: [] });
    if (url.includes('/mail/projects/project-1/analysis')) return response({ job: null });
    return response({ total: 0, projects: [] });
  });
  await h.app.openProject('project-1');
  assert.match(h.app.dialogContent.textContent, /Manually protected summary/); assert.match(h.app.dialogContent.textContent, /Suggested project update/);
  assert.match(h.app.dialogContent.textContent, /邮件 4\/5 封/); assert.doesNotMatch(h.app.dialogContent.textContent, /coverage-private-id|sourceMessageId/);
  const adopt = button(h.app.dialogContent, '采用此建议'); assert.equal(adopt.disabled, false);
  await fire(adopt); await flush();
  assert.equal(writes.length, 1); assert.match(writes[0].url, /\/mail\/summaries\/rollback$/);
  assert.equal(writes[0].body.summaryId, 'summary-1'); assert.equal(writes[0].body.expectedVersion, 3); assert.equal(writes[0].body.targetVersion, 5); assert.ok(writes[0].body.operationId);
  assert.equal(summaryReads, 2);
});

test('project analysis sends the selected inclusive date bounds, including one-day ranges', async () => {
  let analysisBody;
  const h = harness((url, options = {}) => {
    if (url.includes('/mail/projects/project-1/analysis') && options.method === 'POST') { analysisBody = JSON.parse(options.body); return response({ jobId: 'job-new', status: 'pending' }, 202); }
    if (url.endsWith('/mail/projects/project-1')) return response({ project: { id: 'project-1', name: 'Expo', company: { id: 'company-1', name: 'Acme' }, projectContacts: [], status: 'active', stage: 'planning', topics: [], tasks: [] } });
    if (url.includes('/mail/projects/project-1/summary')) return response({ summaryId: 'summary-1', version: 1, summary: '', versions: [] });
    if (url.includes('/mail/projects/project-1/timeline?')) return response({ events: [] });
    if (url.includes('/mail/projects/project-1/messages?')) return response({ total: 0, messages: [] });
    if (url.includes('/mail/projects/project-1/analysis')) return response({ job: null });
    if (url.includes('/mail/project-analysis/job-new')) return response({ job: { id: 'job-new', status: 'pending' }, items: [], totalItems: 0 });
    return response({ total: 0, projects: [] });
  });
  await h.app.openProject('project-1'); await fire(button(h.app.dialogContent, '分析邮件'));
  const form = find(h.app.dialogContent, node => node.tagName === 'FORM');
  find(form, node => node.name === 'from').value = '2026-10-01'; find(form, node => node.name === 'through').value = '2026-10-01'; find(form, node => node.name === 'limit').value = '10';
  await fire(form, 'submit'); await flush();
  assert.deepEqual(analysisBody, { from: '2026-10-01', to: '2026-10-01', limit: 10, operationId: analysisBody.operationId });
  assert.ok(analysisBody.operationId);
});

test('timeline selector and event history can advance beyond the first page', async () => {
  const h = harness(url => {
    if (url.includes('/timeline?')) return response({ total: 31, events: [{ title: 'Timeline event' }] });
    const params = new URL(url, 'http://test').searchParams; const offset = Number(params.get('offset'));
    return response({ total: 101, projects: Array.from({ length: offset ? 1 : 100 }, (_, i) => ({ id: `p${offset + i}`, name: `Project ${offset + i}` })) });
  });
  await h.app.loadPage('timeline'); await fire(button(h.app.content, '加载更多'));
  const select = find(h.app.content, node => node.id === 'timeline-project'); select.value = 'p100'; await fire(button(h.app.content, '打开时间线'));
  assert.ok(h.requests.some(item => item.url.includes('/projects/p100/timeline?'))); await fire(button(h.app.content, '下一页'));
  assert.ok(h.requests.some(item => item.url.includes('/timeline?limit=30&offset=30')));
});

test('email previous and next controls replace the current message in the modal', async () => {
  const h = harness(url => {
    const id = url.split('/').at(-1);
    return response({ id, subject: `Mail ${id}`, bodyText: `New content ${id}`, quotedHistoryRemoved: true,
      fromJson: [{ name: 'Sender', address: 'sender@example.test' }], toJson: [{ name: 'Mailbox', address: 'mailbox@example.test' }], ccJson: [], bccJson: [],
      threadNavigation: { previous: id === 'b' ? { id: 'a', subject: 'Mail a' } : null, next: id === 'a' ? { id: 'b', subject: 'Mail b' } : null, position: id === 'a' ? 1 : 2, total: 2 } });
  });
  await h.app.openEmail('b'); assert.equal(button(h.app.dialogContent, '下一封 →').disabled, true);
  assert.doesNotMatch(h.app.dialogContent.textContent, /未知发件人/);
  for (const label of ['抄送', '密送']) {
    const row = find(h.app.dialogContent, node => node.tagName === 'DIV' && node.children[0]?.textContent === label);
    assert.equal(row.children[1].textContent, '—');
  }
  await fire(button(h.app.dialogContent, '← 上一封')); assert.match(h.app.dialogContent.textContent, /New content a/); assert.doesNotMatch(h.app.dialogContent.textContent, /New content b/);
  assert.equal(button(h.app.dialogContent, '← 上一封').disabled, true);
  await fire(button(h.app.dialogContent, '下一封 →')); assert.match(h.app.dialogContent.textContent, /New content b/);
  assert.match(h.app.dialogContent.textContent, /已隐藏引用的历史正文/);
});

test('an isolated email has no enabled thread navigation', async () => {
  const h = harness(() => response({ subject: 'Isolated', bodyText: 'Current only', threadNavigation: { previous: null, next: null, position: 1, total: 1 } }));
  await h.app.openEmail('single'); assert.equal(button(h.app.dialogContent, '← 上一封').disabled, true); assert.equal(button(h.app.dialogContent, '下一封 →').disabled, true);
});

test('delivery failure page uses business date, separates report/address counts, and never infers a target from To or body', async () => {
  const reportRequests = [];
  const h = harness(url => {
    if (url.includes('/mail/delivery-failures?')) {
      reportRequests.push(url);
      return response({ date: '2026-10-02', timezone: 'Asia/Tokyo', total: 2, limit: 30, offset: 0,
        stats: { configuredSourceReports: 4, deliveryFailureReports: 3, deliveryDelayReports: 1, systemNotificationReports: 0, uniqueFailedRecipientAddresses: 2, failuresWithoutKnownRecipient: 1 },
        reports: [
          { messageId: 'failure-1', receivedAt: '2026-10-02T00:30:00.000Z', sourceSender: { address: 'mailer-daemon@example.test' }, deliveryState: 'failure', isFailure: true,
            targets: [{ email: 'client@example.test', status: 'failed', diagnostic: '550 mailbox unavailable' }, { email: 'other@example.test', status: 'failed' }], reason: '收件地址不存在', toJson: [{ address: 'our-own-mailbox@example.test' }], subject: 'private subject', bodyText: 'private body' },
          { messageId: 'failure-2', receivedAt: '2026-10-02T01:00:00.000Z', sourceSender: { address: 'mailer-daemon@example.test' }, deliveryState: 'failure', isFailure: true,
            targets: [{ email: null, status: 'unknown', diagnostic: null }], reason: '退信没有可确认的目标地址', toJson: [{ address: 'our-own-mailbox@example.test' }] },
        ] });
    }
    if (url.endsWith('/mail/system-mail-senders')) return response({ senders: [], total: 0 });
    return response({});
  });
  await h.app.loadPage('delivery-failures');
  assert.equal(reportRequests.length, 1); assert.match(reportRequests[0], /date=\d{4}-\d{2}-\d{2}/);
  assert.match(h.app.content.textContent, /配置发件地址收到报告4/); assert.match(h.app.content.textContent, /投递失败报告3/);
  assert.match(h.app.content.textContent, /去重失败邮箱2/); assert.match(h.app.content.textContent, /失败对象未识别1/);
  assert.match(h.app.content.textContent, /client@example\.test/); assert.match(h.app.content.textContent, /other@example\.test/); assert.match(h.app.content.textContent, /未识别/);
  const unknownTarget = find(h.app.content, node => node.classList.contains('delivery-target') && node.textContent.includes('未识别'));
  assert.equal(unknownTarget.textContent, '未识别');
  assert.match(h.app.content.textContent, /mailer-daemon@example\.test/); assert.match(h.app.content.textContent, /2026/); assert.match(h.app.content.textContent, /09:30/);
  assert.doesNotMatch(h.app.content.textContent, /our-own-mailbox@example\.test|private subject|private body/);
});

test('delivery report date rejects invalid input without another request', async () => {
  let reportCalls = 0;
  const h = harness(url => {
    if (url.includes('/mail/delivery-failures?')) { reportCalls++; return response({ date: '2026-10-02', timezone: 'Asia/Tokyo', total: 0, stats: {}, reports: [] }); }
    return response({ senders: [], total: 0 });
  });
  await h.app.loadPage('delivery-failures');
  const dateInput = find(h.app.content, node => node.type === 'date'); dateInput.value = '2026-02-30';
  await fire(button(h.app.content, '查询日期'));
  assert.equal(reportCalls, 1); assert.match(h.app.content.textContent, /请选择有效的业务日期/);
});

test('delivery reports paginate by the selected date and offset', async () => {
  const requests = [];
  const h = harness(url => {
    if (url.includes('/mail/delivery-failures?')) {
      const query = new URL(url, 'http://test').searchParams; const date = query.get('date'); requests.push({ date, offset: query.get('offset') });
      const offset = Number(query.get('offset'));
      return response({ date, timezone: 'Europe/Rome', total: 31, limit: 30, offset,
        stats: { configuredSourceReports: 31, deliveryFailureReports: 31, uniqueFailedRecipientAddresses: 31, failuresWithoutKnownRecipient: 0 },
        reports: [{ deliveryState: 'failure', receivedAt: `${date}T01:00:00.000Z`, sourceSender: { address: 'mailer-daemon@example.test' }, targets: [{ email: `target-${offset}.invalid`, status: 'failed' }], reason: `page offset ${offset}` }] });
    }
    return response({ senders: [], total: 0 });
  });
  await h.app.loadPage('delivery-failures');
  const dateInput = find(h.app.content, node => node.type === 'date'); dateInput.value = '2026-10-02';
  await fire(button(h.app.content, '查询日期')); await flush();
  await fire(button(h.app.content, '下一页')); await flush();
  const selectedDatePages = requests.slice(-2);
  assert.deepEqual(selectedDatePages.map(item => item.offset), ['0', '30']);
  assert.deepEqual(selectedDatePages.map(item => item.date), ['2026-10-02', '2026-10-02'], 'pagination preserves the explicitly selected report date');
  assert.match(h.app.content.textContent, /page offset 30/);
});

test('delivery reports show empty state and a retry action after API errors', async () => {
  let fail = true;
  const h = harness(url => {
    if (url.includes('/mail/delivery-failures?')) {
      if (fail) throw new Error('temporary report service error');
      return response({ date: '2026-10-02', timezone: 'Europe/Rome', total: 0, limit: 30, offset: 0,
        stats: { configuredSourceReports: 0, deliveryFailureReports: 0, deliveryDelayReports: 0, systemNotificationReports: 0, uniqueFailedRecipientAddresses: 0, failuresWithoutKnownRecipient: 0 }, reports: [] });
    }
    return response({ senders: [], total: 0 });
  });
  await h.app.loadPage('delivery-failures');
  assert.match(h.app.content.textContent, /temporary report service error/);
  fail = false; await fire(button(h.app.content, '重试加载报告')); await flush();
  assert.match(h.app.content.textContent, /这个业务日没有配置发件地址收到的系统投递报告/);
});

test('delivery state badges keep their labels on one line in narrow columns', () => {
  const css = fs.readFileSync(path.join(root, 'apps/dashboard/styles.css'), 'utf8');
  assert.match(css, /\.delivery-failure-table \.badge\s*\{\s*white-space:\s*nowrap\s*\}/);
});

test('a late response for an older report date cannot replace the newest selection', async () => {
  const older = deferred(); const reasons = [];
  const h = harness(url => {
    if (!url.includes('/mail/delivery-failures?')) return response({ senders: [], total: 0 });
    const date = new URL(url, 'http://test').searchParams.get('date');
    if (date === '2026-09-01') return older.promise;
    if (date === '2026-09-02') return response({ date, timezone: 'Asia/Tokyo', total: 1, limit: 30, offset: 0, stats: { configuredSourceReports: 1, deliveryFailureReports: 1, uniqueFailedRecipientAddresses: 1, failuresWithoutKnownRecipient: 0 }, reports: [{ deliveryState: 'failure', receivedAt: '2026-09-02T01:00:00.000Z', sourceSender: { address: 'mailer-daemon@example.test' }, targets: [{ email: 'new@example.test', status: 'failed' }], reason: 'newest selection' }] });
    return response({ date, total: 0, stats: { configuredSourceReports: 0, deliveryFailureReports: 0, uniqueFailedRecipientAddresses: 0, failuresWithoutKnownRecipient: 0 }, reports: [] });
  });
  await h.app.loadPage('delivery-failures');
  const dateInput = find(h.app.content, node => node.type === 'date');
  dateInput.value = '2026-09-01'; const oldRequest = fire(button(h.app.content, '查询日期')); await flush();
  dateInput.value = '2026-09-02'; await fire(button(h.app.content, '查询日期')); await flush();
  assert.match(h.app.content.textContent, /newest selection/);
  older.resolve(response({ date: '2026-09-01', timezone: 'Asia/Tokyo', total: 1, limit: 30, offset: 0, stats: { configuredSourceReports: 1, deliveryFailureReports: 1, uniqueFailedRecipientAddresses: 1, failuresWithoutKnownRecipient: 0 }, reports: [{ deliveryState: 'failure', receivedAt: '2026-09-01T01:00:00.000Z', sourceSender: { address: 'mailer-daemon@example.test' }, targets: [{ email: 'old@example.test', status: 'failed' }], reason: 'stale old response' }] }));
  await oldRequest; assert.match(h.app.content.textContent, /newest selection/); assert.doesNotMatch(h.app.content.textContent, /stale old response/);
});

test('system sender addresses can be added and removed with inline confirmation only', async () => {
  const senders = [
    { id: 'sender-1', email: 'mailer-daemon@googlemail.com', createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'sender-2', email: 'mailer-daemon@zmail.tsnet.it', createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'sender-3', email: 'mailer-daemon@mail.ni8.com', createdAt: '2026-10-01T10:00:00.000Z' },
  ];
  const writes = []; let reportCalls = 0;
  const h = harness((url, options = {}) => {
    if (url.includes('/mail/delivery-failures?')) { reportCalls++; return response({ date: '2026-10-02', total: 0, stats: { configuredSourceReports: 0, deliveryFailureReports: 0, uniqueFailedRecipientAddresses: 0, failuresWithoutKnownRecipient: 0 }, reports: [] }); }
    if (url.endsWith('/mail/system-mail-senders') && options.method === 'PUT') {
      const body = JSON.parse(options.body); writes.push({ method: 'PUT', url, body }); senders.push({ id: 'sender-new', email: body.email, createdAt: '2026-10-02T10:00:00.000Z' }); return response({ id: 'sender-new', email: body.email });
    }
    if (url.endsWith('/mail/system-mail-senders')) return response({ senders: [...senders], total: senders.length });
    if (url.includes('/mail/system-mail-senders/') && options.method === 'DELETE') {
      writes.push({ method: 'DELETE', url, body: JSON.parse(options.body) }); const id = url.split('/').at(-1); const index = senders.findIndex(item => item.id === id); if (index >= 0) senders.splice(index, 1); return response({ id, deleted: true });
    }
    return response({});
  });
  await h.app.loadPage('delivery-failures');
  for (const address of ['mailer-daemon@googlemail.com', 'mailer-daemon@zmail.tsnet.it', 'mailer-daemon@mail.ni8.com']) assert.ok(h.app.content.textContent.includes(address));
  const form = find(h.app.content, node => node.tagName === 'FORM'); const input = find(form, node => node.name === 'email'); input.value = '  MAILER-DAEMON@Example.test ';
  await fire(form, 'submit'); await flush();
  assert.equal(writes[0].method, 'PUT'); assert.equal(writes[0].body.email, 'mailer-daemon@example.test'); assert.ok(writes[0].body.operationId);
  assert.equal(reportCalls, 2, 'adding a source refreshes both the sender list and the report aggregate');
  await fire(button(h.app.content, '移除')); assert.ok(find(h.app.content, node => node.classList.contains('system-sender-confirmation')));
  await fire(button(h.app.content, '确认移除')); await flush();
  assert.equal(writes[1].method, 'DELETE'); assert.match(writes[1].url, /\/mail\/system-mail-senders\/sender-1$/); assert.ok(writes[1].body.operationId);
  assert.equal(reportCalls, 3, 'removing a source refreshes the report aggregate');
  assert.equal(h.confirmCalls(), 0); assert.doesNotMatch(h.app.content.textContent, /mailer-daemon@googlemail\.com/);
});

test('mobile styles keep the named logout control available', () => {
  const html = fs.readFileSync(path.join(root, 'apps/dashboard/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'apps/dashboard/typography.css'), 'utf8');
  assert.match(html, /id="logout"[^>]*aria-label="退出登录"/);
  assert.match(css, /@media\(max-width:680px\)[\s\S]*\.sidebar-bottom\s*\{\s*display:\s*flex/);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(JSON.stringify({ passed: tests.length - failed, failed }));
  if (failed) process.exitCode = 1;
})();
