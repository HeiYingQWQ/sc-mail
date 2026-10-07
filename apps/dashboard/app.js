(() => {
  'use strict';

  const API = '/api/v1';
  const CLASSIFICATIONS = {
    BUSINESS_HUMAN: '商务邮件', OUTREACH_OUTBOUND: '外发开发邮件', BLACKLISTED: '发送方黑名单', DELIVERY_FAILURE: '发送失败/退信',
    DELIVERY_DELAY: '投递延迟', OUT_OF_OFFICE: '自动休假回复', AUTO_ACKNOWLEDGEMENT: '自动回执',
    TICKET_CONFIRMATION: '工单确认', UNSUBSCRIBE: '退订确认', NEWSLETTER: '订阅邮件',
    MARKETING: '营销广告', SYSTEM_NOTIFICATION: '系统通知', SPAM: '垃圾邮件/疑似诈骗', UNKNOWN: '待判断',
  };
  const LABELS = {
    open: '待处理', in_progress: '处理中', waiting: '等待中', done: '已完成', cancelled: '已取消', active: '进行中',
    lead: '潜在客户', planning: '规划', design: '设计', quotation: '报价', revision: '修改',
    approval: '审批', production: '生产', delivery: '交付', completed: '已完成', on_hold: '暂停',
    customer: '客户', us: '我方', third_party: '第三方', mixed: '双方', none: '未设置',
    confirmed: '已确认', provisional: '待确认', merged: '已合并', pending: '待处理', resolved: '已解决', dismissed: '已忽略',
    failed: '失败', processing: '处理中', completed: '已完成', ignored: '已忽略', not_configured: '未配置', account_not_ready: '账户未就绪',
  };
  const SETTING_LABELS = {
    configured: '服务已配置', workerConfigured: '后台工作进程已配置', enabled: '已启用', status: '运行状态',
    pollIntervalSeconds: '轮询间隔（秒）', queue: '邮件任务队列', queued: '排队中', ready: '待执行', active: '执行中', failed: '失败',
    folders: '邮箱文件夹', mailbox: '文件夹', uidValidity: '文件夹版本', lastUid: '同步到 UID', fromDate: '起始日期', throughDate: '截止日期',
    lastPolledAt: '最近轮询', lastSuccessfulSyncAt: '最近同步成功', lastErrorCode: '最近错误代码', reconciliationRequired: '需要对账',
    scannedCount: '已扫描', importedCount: '已导入', completedAt: '完成时间', updatedAt: '更新时间',
    eventWakeup: 'Agent 事件唤醒', notifications: '通知投递', telegram: 'Telegram 桥接', dailyBrief: '业务日报',
    whatsappSenderConfigured: 'WhatsApp 通知已配置', telegramSenderConfigured: 'Telegram 通知已配置', chatBridgeConfigured: '聊天桥接已配置',
    pollingEnabled: 'Telegram 轮询已启用', allowedChatsConfigured: '允许的聊天已配置', inbox: '聊天消息队列', deliveries: '投递记录',
    allowedChannels: '启用的通知渠道', timezone: '业务时区', language: '日报语言', style: '日报样式', time: '执行时间',
    waitingThresholdDays: '客户等待阈值（天）', followUpWindowDays: '跟进窗口（天）', notifyWhenEmpty: '无内容时也通知',
    checkpoint: '对账检查点', auditFrom: '本轮检查起始', auditThrough: '本轮检查截止', lastAuditStartedAt: '最近开始对账',
    lastAuditCompletedAt: '最近完成对账', processingRecordsCreated: '补建处理记录', crmRepaired: '修复 CRM 关联',
    needsReviewCount: '需人工复核', leaseActive: '正在处理', _count: '数量', _all: '总数',
  };
  const SETTING_VALUES = { telegram: 'Telegram', whatsapp: 'WhatsApp', 'zh-CN': '简体中文', concise: '简洁', detailed: '详细',
    implicit: '隐式 TLS', starttls: 'STARTTLS', matched: '已匹配', completed: '已完成', running: '运行中',
    failed: '失败', idle: '空闲', not_started: '尚未开始', reconciling: '对账中' };
  const state = {
    user: null, page: 'overview', offsets: {}, projects: [], companies: [], contacts: [],
    filters: { inboxClassification: 'BUSINESS_HUMAN', inboxDate: '', sentDate: '', sentTo: '', taskStatus: '', reviewStatus: 'pending', timelineProject: '', contactSearch: '', deliveryFailureDate: '' },
    timezone: null,
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const content = $('#content');
  const dialog = $('#detail-dialog');
  const dialogContent = $('#dialog-content');
  let dialogBusy = false;
  let pageRequest = null;
  let dialogRequest = null;
  let sessionSequence = 0;
  let projectAnalysisTimer = null;

  function requestScope() {
    const controller = new AbortController();
    const check = () => {
      if (controller.signal.aborted) { const error = new Error('请求已取消'); error.name = 'AbortError'; throw error; }
    };
    return {
      abort: () => controller.abort(),
      get active() { return !controller.signal.aborted; },
      async api(path, options = {}) {
        check();
        const readOnly = !options.method || options.method.toUpperCase() === 'GET';
        const result = await api(path, readOnly ? { ...options, signal: controller.signal } : options);
        check();
        return result;
      },
    };
  }

  function setTimezone(value) {
    if (!value) return;
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: value }); } catch { return; }
    state.timezone = value;
    $('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: value, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  }

  async function ensureTimezone(request) {
    if (state.timezone) return;
    const data = await request.api('/mail/integrations/status');
    setTimezone(data.dailyBrief?.timezone);
    if (!state.timezone) throw new Error('未能读取业务时区，请刷新后重试。');
  }

  function el(tag, className = '', text = '') {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }
  function append(parent, ...children) { for (const child of children) if (child !== null && child !== undefined) parent.append(child instanceof Node ? child : document.createTextNode(String(child))); return parent; }
  function button(text, action, cls = 'button secondary', title = '') {
    const item = el('button', cls, text); item.type = 'button'; if (title) item.title = title; item.addEventListener('click', action); return item;
  }
  function requestInlineConfirmation(container, message, confirmLabel, onConfirm, kind = 'inline-confirmation', ariaLabel = '确认操作') {
    [...container.querySelectorAll('div')].find(node => node.classList.contains(kind))?.remove();
    const confirmation = el('div', `notice-inline inline-confirmation ${kind}`);
    confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', ariaLabel);
    const confirmAction = button(confirmLabel, async () => {
      confirmAction.disabled = true;
      try { await onConfirm(); confirmation.remove(); }
      catch { confirmAction.disabled = false; }
    }, 'button primary small');
    append(confirmation, el('p', '', message), button('取消', () => confirmation.remove(), 'button ghost small'), confirmAction);
    container.append(confirmation); confirmAction.focus();
    return confirmation;
  }
  function sourceEmailButton(messageId, deleted = false, label = '查看来源邮件') {
    const control = button(deleted ? '来源邮件已删除' : label, () => messageId && openEmail(messageId), 'button ghost small');
    control.disabled = deleted || !messageId;
    return control;
  }
  function optionSelect(entries, selected, cls = '') {
    const select = el('select', cls);
    for (const [value, label] of entries) { const option = el('option', '', label); option.value = value; option.selected = value === selected; select.append(option); }
    return select;
  }
  function pagedSelect({ path, key, label, emptyLabel = '请选择', filter = () => true, search = false, request = dialogRequest, onChange = () => {} }) {
    const root = el('div', 'entity-picker'); const select = optionSelect([['', emptyLabel]], '');
    const status = el('span', 'small-text'); status.setAttribute('role', 'status');
    const more = button('加载更多', () => load(retryReset), 'button secondary small');
    const controls = el('div', 'picker-controls'); append(controls, status, more); append(root, select, controls);
    let offset = 0; let total = 0; let term = ''; let sequence = 0; let loading = false; let retryReset = true;
    const seen = new Set();
    select.addEventListener('change', () => onChange(select.value));
    async function load(reset) {
      const current = ++sequence; const nextOffset = reset ? 0 : offset;
      retryReset = reset;
      loading = true; more.disabled = true; select.disabled = true; status.textContent = '正在加载…';
      try {
        const data = await request.api(`${path}${path.includes('?') ? '&' : '?'}${query({ limit: 100, offset: nextOffset, search: term })}`);
        if (current !== sequence) return;
        const items = data[key];
        if (!Array.isArray(items)) throw new Error('列表返回格式无效');
        if (reset) { select.replaceChildren(); select.append(optionSelect([['', emptyLabel]], '').firstElementChild); seen.clear(); }
        for (const item of items) {
          if (!filter(item) || seen.has(item.id)) continue;
          seen.add(item.id); const option = el('option', '', label(item)); option.value = item.id; select.append(option);
        }
        offset = nextOffset + items.length; total = data.total ?? offset;
        if (!items.length && offset < total) throw new Error('列表分页未返回记录，请重试');
        status.textContent = `已读取 ${offset} / ${total} 条，可选 ${seen.size} 条`;
        retryReset = false;
        more.textContent = '加载更多'; more.classList.toggle('hidden', offset >= total);
        onChange(select.value);
      } catch (error) {
        if (current !== sequence || error.name === 'AbortError') return;
        status.textContent = `加载失败：${error.message}`; more.textContent = '重试加载'; more.classList.remove('hidden');
      } finally {
        if (current === sequence) { loading = false; more.disabled = false; select.disabled = false; }
      }
    }
    if (search) {
      const searchBox = el('div', 'picker-search'); const input = el('input'); input.type = 'search'; input.placeholder = '搜索联系人姓名或邮箱'; input.setAttribute('aria-label', input.placeholder);
      const runSearch = () => {
        const value = input.value.trim();
        term = value; void load(true);
      };
      append(searchBox, input, button('搜索', runSearch, 'button secondary small')); root.prepend(searchBox);
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); runSearch(); } });
    }
    return { element: root, select, ready: load(true), get loading() { return loading; } };
  }
  const companyPicker = (emptyLabel = '不关联公司') => ({ path: '/mail/crm/companies', key: 'companies', label: company => company.name, emptyLabel });
  function pageIntro(title, description, action, root = content) {
    const wrapper = el('div', 'section-title');
    const head = el('div', 'section-head'); const left = el('div'); append(left, el('h2', '', title), el('p', '', description)); append(head, left, action || null); append(wrapper, head); root.append(wrapper);
  }
  function card(title, description = '') {
    const box = el('section', 'card'); const head = el('div', 'section-head');
    const heading = el('div'); append(heading, el('h2', '', title)); if (description) heading.append(el('p', '', description));
    append(head, heading); box.append(head); return box;
  }
  function metric(label, value, note = '') {
    const item = el('section', 'card metric'); append(item, el('div', 'metric-label', label), el('div', 'metric-value', value ?? '—'), el('div', 'metric-note', note)); return item;
  }
  function badge(text, kind = '') { return el('span', `badge ${kind}`, text); }
  function classifyBadge(code) {
    const kind = code === 'BUSINESS_HUMAN' ? 'green' : ['BLACKLISTED', 'DELIVERY_FAILURE', 'SPAM'].includes(code) ? 'red' : ['UNKNOWN', 'DELIVERY_DELAY'].includes(code) ? 'amber' : 'blue';
    return badge(CLASSIFICATIONS[code] || code || '未分类', kind);
  }
  function statusBadge(status) { return badge(LABELS[status] || status || '未知', status === 'done' || status === 'resolved' ? 'green' : status === 'cancelled' || status === 'dismissed' ? '' : status === 'waiting' || status === 'pending' ? 'amber' : 'blue'); }
  function formatDate(value, withTime = true) {
    if (!value) return '—'; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value);
    if (!state.timezone) return date.toISOString();
    return new Intl.DateTimeFormat('zh-CN', { timeZone: state.timezone, ...(withTime ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' }) }).format(date);
  }
  function formatDateTimeWithYear(value) {
    if (!value) return '—'; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', { timeZone: state.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
  }
  function sender(value) {
    if (Array.isArray(value)) return value.length ? value.map(x => x?.name ? `${x.name} <${x.address || ''}>` : x?.address || '').filter(Boolean).join(', ') || '—' : '—';
    if (value && typeof value === 'object') return value.name ? `${value.name} <${value.address || ''}>` : value.address || '—';
    return typeof value === 'string' && value.trim() ? value : '—';
  }
  function participantSummary(message) {
    return [['发件人', message?.fromJson], ['收件人', message?.toJson], ['抄送', message?.ccJson], ['密送', message?.bccJson]]
      .map(([role, value]) => { const addresses = sender(value); return addresses === '—' ? null : `${role}：${addresses}`; })
      .filter(Boolean).join(' · ') || '—';
  }
  function query(values) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') params.set(key, value); return params.toString(); }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response;
    try { response = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' }); }
    catch (error) {
      if (error instanceof TypeError) throw new Error('无法连接到 SC Mail 服务，请检查服务状态和网络后重试。');
      throw error;
    }
    const type = response.headers.get('content-type') || '';
    const body = type.includes('json') ? await response.json() : await response.text();
    if (options.signal?.aborted) { const error = new Error('请求已取消'); error.name = 'AbortError'; throw error; }
    if (!response.ok) {
      if (response.status === 401) logout();
      throw new Error(formatApiError(body, response.status));
    }
    return body;
  }
  async function authApi(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response;
    try { response = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' }); }
    catch (error) { const networkError = new Error('无法连接到 SC Mail 服务，请检查服务状态和网络后重试。'); networkError.code = 'NETWORK_ERROR'; throw networkError; }
    const type = response.headers.get('content-type') || '';
    const body = type.includes('json') ? await response.json() : await response.text();
    if (!response.ok) { const error = new Error(formatApiError(body, response.status)); error.status = response.status; throw error; }
    return body;
  }
  function formatApiError(body, status) {
    const details = body && typeof body === 'object' ? body.message ?? body : body;
    const code = details && typeof details === 'object' ? details.code : body?.code;
    const known = {
      VERSION_CONFLICT: '记录已被其他操作更新。请关闭详情并重新打开后再修改。',
      CONCURRENT_UPDATE: '记录正在被其他操作更新，请刷新后重试。',
      REVIEW_ALREADY_RESOLVED: '这条复核已被处理。请关闭详情并刷新列表。',
      MANUAL_OVERRIDE_PROTECTED: '这条记录已由人工确认，当前操作不能覆盖它。',
      IDEMPOTENCY_KEY_REUSED: '本次操作编号已用于其他内容。请关闭表单并重新打开后重试。',
      IDEMPOTENCY_CONFLICT: '操作已被其他请求处理，请刷新页面确认结果。',
      TARGET_SCOPE_CHANGED: '记录所属项目已变化，请刷新后重试。',
      PROJECT_ASSIGNMENT_CONFLICT: '邮件归属已被其他操作更新，请刷新邮件详情后重新判断。',
      PROJECT_CONTEXT_STALE: '分析依据已变化；该结果已保留为待确认，刷新项目后可重新处理。',
      PROJECT_ANALYSIS_SCOPE_REQUIRED: '请为项目分析设置明确的日期范围。',
      PROJECT_ANALYSIS_SCOPE_TOO_LARGE: '所选日期范围内的候选邮件超过本次批次上限，请缩小日期范围后再分析。',
      PROJECT_ANALYSIS_LIMIT_EXCEEDED: '本次候选邮件数量超出上限，请缩小日期范围。',
      JOB_NOT_RETRYABLE: '此分析任务当前不能重试。请刷新任务状态后再试。',
      INVALID_DELIVERY_FAILURE_DATE: '业务日期格式无效，请选择 YYYY-MM-DD 日期后重试。',
      SYSTEM_MAIL_SENDER_INVALID_EMAIL: '系统发件地址格式无效，请检查邮箱地址。',
      SYSTEM_MAIL_SENDER_NOT_FOUND: '这个系统发件地址已被其他操作移除，请刷新列表。',
      NOT_FOUND: '记录已不存在，请刷新页面。',
    };
    if (code === 'PROJECT_ANALYSIS_SCOPE_TOO_LARGE') {
      const total = details?.totalCandidateCount ?? body?.totalCandidateCount;
      const limit = details?.limit ?? body?.limit;
      if (Number.isInteger(total) && Number.isInteger(limit)) return `所选日期范围内有 ${total} 封候选邮件，超过本批次上限 ${limit} 封。请缩小日期范围后再分析。`;
    }
    if (typeof code === 'string' && known[code]) return known[code];
    if (Array.isArray(details)) return details.map(String).join('；');
    if (typeof details === 'string' && details.trim()) return details;
    if (details && typeof details === 'object') {
      if (typeof details.message === 'string' && details.message.trim()) return details.message;
      if (typeof details.error === 'string' && details.error.trim()) return details.error;
    }
    if (typeof body === 'string' && body.trim()) return body;
    return ({ 400: '请求内容不完整或格式不正确。', 401: '登录状态已失效，请重新登录。', 403: '当前操作没有权限。', 404: '记录已不存在，请刷新页面。', 409: '数据已发生变化，请刷新页面后重试。', 429: '请求过于频繁，请稍后重试。' })[status]
      || 'SC Mail 暂时无法完成此操作，请稍后重试。';
  }
  function showNotice(message, isError = false) {
    const box = $('#notice'); box.textContent = message; box.className = `notice ${isError ? 'failure' : 'success'}`;
    clearTimeout(showNotice.timer); showNotice.timer = setTimeout(() => box.classList.add('hidden'), 5500);
  }
  function showApp(user) {
    state.user = user;
    $('#auth-loading').classList.add('hidden');
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
  }
  function showLogin() {
    state.user = null;
    state.timezone = null;
    pageRequest?.abort(); dialogRequest?.abort();
    $('#auth-loading').classList.add('hidden');
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
  }
  function showAuthError(error) {
    const card = $('.auth-loading-card');
    card.replaceChildren(el('p', 'auth-title', 'SC Mail Console'), el('p', '', error?.message || '无法恢复登录状态。'), button('重试连接', restoreSession, 'button primary small'));
    $('#auth-loading').classList.remove('hidden'); $('#login').classList.add('hidden'); $('#app').classList.add('hidden');
  }
  function showError(error) { content.replaceChildren(el('div', 'card empty', error?.message || '加载失败')); }
  function empty(message) { return el('div', 'empty', message); }
  function table(headers, rows, renderRow, { click } = {}) {
    if (!rows?.length) return empty('暂无记录');
    const wrap = el('div', 'table-wrap'); const tbl = el('table', 'data-table'); const thead = el('thead'); const hr = el('tr');
    headers.forEach(value => hr.append(el('th', '', value))); thead.append(hr); const tbody = el('tbody');
    rows.forEach((row, index) => {
      const tr = el('tr', click ? 'clickable' : ''); if (click) tr.addEventListener('click', event => { if (!event.target.closest('button,select,a,summary,details')) click(row, index); });
      renderRow(row).forEach(value => { const td = el('td'); append(td, value); tr.append(td); }); tbody.append(tr);
    });
    tbl.append(thead, tbody); wrap.append(tbl); return wrap;
  }
  function cellText(text, cls = '') { return el('span', cls, text ?? '—'); }
  function pagination(total, limit, offset, onPage) {
    const bar = el('div', 'pagination'); const from = total ? offset + 1 : 0; const to = Math.min(offset + limit, total);
    append(bar, el('span', '', `${from}–${to} / ${total}`), button('上一页', () => onPage(Math.max(0, offset - limit)), 'button ghost small'), button('下一页', () => onPage(offset + limit), 'button ghost small'));
    bar.lastElementChild.disabled = offset + limit >= total; bar.children[1].disabled = offset === 0; return bar;
  }
  function setLoading() { content.replaceChildren(el('div', 'card loading', '正在加载…')); }
  function showDialog(title, subtitle = '') {
    clearTimeout(projectAnalysisTimer); projectAnalysisTimer = null;
    dialogRequest?.abort();
    dialog.classList.remove('project-detail-dialog');
    dialog.dataset.activeProjectTab = '';
    dialogRequest = requestScope();
    dialogContent.replaceChildren(); append(dialogContent, el('p', 'eyebrow', subtitle), el('h2', '', title));
    if (!dialog.open) dialog.showModal();
    return dialogRequest;
  }
  function closeDialog() { if (!dialogBusy) { clearTimeout(projectAnalysisTimer); projectAnalysisTimer = null; dialogRequest?.abort(); dialog.classList.remove('project-detail-dialog'); dialog.dataset.activeProjectTab = ''; if (dialog.open) dialog.close(); } }
  function detailMeta(entries) {
    const grid = el('div', 'detail-meta');
    entries.forEach(([label, value]) => { const item = el('div'); append(item, el('span', '', label), el('strong', '', value ?? '—')); grid.append(item); });
    return grid;
  }
  function field(form, label, name, { type = 'text', value = '', options, picker, required = false, wide = false, placeholder = '' } = {}) {
    const wrap = el('label', wide ? 'wide' : '', label); let input;
    let control;
    if (picker) { const selection = pagedSelect(picker); input = selection.select; control = selection.element; }
    else if (options) { input = optionSelect(options, value); }
    else if (type === 'textarea') { input = el('textarea'); input.value = value; }
    else { input = el('input'); input.type = type; input.value = value; input.placeholder = placeholder; }
    input.name = name; if (required) input.required = true; wrap.append(control || input); form.append(wrap); return input;
  }
  function formDialog(title, description, fields, onSubmit, afterSave) {
    showDialog(title, description); const form = el('form', 'form-grid'); const inputs = {};
    fields.forEach(item => { inputs[item.name] = field(form, item.label, item.name, item); });
    const actions = el('div', 'form-actions wide'); const cancelButton = button('取消', closeDialog, 'button ghost'); const saveButton = button('保存', () => {}, 'button primary'); actions.append(cancelButton, saveButton); form.append(actions);
    const operationId = crypto.randomUUID(); let submitting = false;
    form.addEventListener('submit', async event => { event.preventDefault(); const payload = {}; for (const [name, input] of Object.entries(inputs)) payload[name] = input.value.trim();
      if (submitting) return;
      submitting = true; dialogBusy = true; saveButton.disabled = true; cancelButton.disabled = true; saveButton.textContent = '保存中…';
      for (const input of Object.values(inputs)) input.disabled = true;
      try { await onSubmit(payload, operationId); dialogBusy = false; closeDialog(); await loadPage(state.page); if (afterSave) await afterSave(); showNotice('已保存'); }
      catch (error) { showNotice(error.message, true); }
      finally {
        submitting = false; dialogBusy = false;
        if (dialog.open) {
          saveButton.disabled = false; cancelButton.disabled = false; saveButton.textContent = '保存';
          for (const input of Object.values(inputs)) input.disabled = false;
        }
      }
    });
    saveButton.type = 'submit'; dialogContent.append(form);
  }
  function managedFormDialog(title, description, build, onSubmit, afterSave) {
    showDialog(title, description);
    const form = el('form', 'form-grid');
    const fields = build(form) || {};
    const actions = el('div', 'form-actions wide');
    const cancelButton = button('取消', closeDialog, 'button ghost');
    const saveButton = button('保存', () => {}, 'button primary');
    actions.append(cancelButton, saveButton); form.append(actions);
    const operationId = crypto.randomUUID(); let submitting = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submitting) return;
      let payload;
      try { if (fields.ready) await fields.ready; payload = fields.read ? fields.read() : {}; }
      catch (error) { showNotice(error.message, true); return; }
      submitting = true; dialogBusy = true; saveButton.disabled = true; cancelButton.disabled = true; saveButton.textContent = '保存中…';
      form.querySelectorAll('input,select,textarea,button').forEach(control => { control.disabled = true; });
      try {
        const result = await onSubmit(payload, operationId);
        dialogBusy = false; closeDialog(); await loadPage(state.page);
        if (afterSave) await afterSave(result);
        showNotice('已保存');
      } catch (error) { showNotice(error.message, true); }
      finally {
        submitting = false; dialogBusy = false;
        if (dialog.open) {
          saveButton.disabled = false; cancelButton.disabled = false; saveButton.textContent = '保存';
          form.querySelectorAll('input,select,textarea,button').forEach(control => { control.disabled = false; });
        }
      }
    });
    saveButton.type = 'submit'; dialogContent.append(form);
    return { form, fields };
  }
  function inputField(form, label, name, { type = 'text', value = '', required = false, wide = false, placeholder = '', hint = '' } = {}) {
    const wrap = el('label', wide ? 'wide' : '', label); const input = type === 'textarea' ? el('textarea') : el('input');
    if (type !== 'textarea') input.type = type;
    input.name = name; input.value = value ?? ''; input.placeholder = placeholder;
    if (required) input.required = true;
    wrap.append(input);
    if (hint) { const help = el('span', 'field-hint', hint); help.id = `${name}-hint`; input.setAttribute('aria-describedby', help.id); wrap.append(help); }
    form.append(wrap); return input;
  }
  function normalizeEmailInput(value) {
    return [...new Set(String(value || '').split(/[\n,;]+/).map(part => part.trim().toLowerCase()).filter(Boolean))];
  }
  function emailValues(contact) {
    return (contact?.emails || []).map(item => typeof item === 'string' ? item : item?.email).filter(Boolean);
  }
  function lifecycleLabel(project) { return project?.status === 'completed' ? '已结束' : '进行中'; }
  function outcomeLabel(value) {
    return ({ assigned: '已归入项目', non_project: '非项目交流', new_opportunity: '新合作机会', uncertain: '待确认', multi_project: '多个项目待确认' })[value] || value || '待处理';
  }
  function safeWebsite(value) {
    if (!value) return null;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  }
  function freshnessNote(data) {
    const freshness = data?.freshness || data?.syncFreshness || data?.mailboxFreshness;
    if (!freshness) return '';
    if (typeof freshness === 'string') return `同步新鲜度：${freshness}`;
    const parts = [];
    if (freshness.timezone) parts.push(freshness.timezone);
    if (freshness.fromDate || freshness.from) parts.push(`起始 ${freshness.fromDate || freshness.from}`);
    if (freshness.throughDate || freshness.through) parts.push(`截止 ${freshness.throughDate || freshness.through}`);
    if (freshness.lastSuccessfulSyncAt) parts.push(`最近同步 ${formatDate(freshness.lastSuccessfulSyncAt)}`);
    return parts.length ? `同步范围：${parts.join(' · ')}` : '';
  }
  function pagedChecklist({ request, selectedIds = [], selectedItems = [], companyId = '', title = '选择联系人' }) {
    const root = el('fieldset', 'entity-checklist'); const legend = el('legend', '', title);
    const searchLabel = el('label', 'checklist-search-label', '搜索联系人'); const search = el('input'); search.type = 'search'; search.placeholder = '姓名或邮箱'; search.setAttribute('aria-label', '搜索联系人姓名或邮箱'); searchLabel.append(search);
    const list = el('div', 'checklist-options'); const status = el('p', 'small-text'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const loadMore = button('加载更多', () => load(false), 'button secondary small');
    const selectedStatus = el('p', 'small-text');
    root.append(legend, searchLabel, list, selectedStatus, status, loadMore);
    const selected = new Set(selectedIds); const known = new Map((selectedItems || []).map(item => [item.id, item]));
    const seen = new Set(); let offset = 0; let total = 0; let term = ''; let sequence = 0;
    function updateSelected() {
      selectedStatus.textContent = `${selected.size} 位联系人已选择`;
      return [...selected];
    }
    function render(items, reset) {
      if (reset) { list.replaceChildren(); seen.clear(); }
      for (const contact of items) {
        if (!contact?.id || seen.has(contact.id)) continue;
        seen.add(contact.id); known.set(contact.id, contact);
        const label = el('label', 'checklist-option'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = contact.id; checkbox.checked = selected.has(contact.id);
        append(label, checkbox, el('span', '', `${contact.displayName || '未命名联系人'} · ${emailValues(contact).join(', ') || '无邮箱'}`));
        checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(contact.id); else selected.delete(contact.id); updateSelected(); });
        list.append(label);
      }
      updateSelected();
    }
    async function load(reset = true) {
      const current = ++sequence; const nextOffset = reset ? 0 : offset;
      status.textContent = '正在读取联系人…'; loadMore.disabled = true;
      try {
        const data = await request.api(`/mail/crm/contacts?${query({ limit: 50, offset: nextOffset, search: term, companyId })}`);
        if (current !== sequence) return;
        const items = data.contacts || [];
        if (reset) { list.replaceChildren(); seen.clear(); }
        render(items, false); offset = nextOffset + items.length; total = data.total ?? offset;
        status.textContent = items.length ? `已读取 ${offset} / ${total} 位联系人` : (offset ? `已读取 ${offset} / ${total} 位联系人` : '没有匹配的已登记联系人');
        loadMore.classList.toggle('hidden', offset >= total); loadMore.disabled = false;
      } catch (error) {
        if (current !== sequence || error.name === 'AbortError') return;
        status.textContent = `读取失败：${error.message}`; loadMore.textContent = '重试'; loadMore.classList.remove('hidden'); loadMore.disabled = false;
      }
    }
    let searchTimer;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer); searchTimer = setTimeout(() => { term = search.value.trim(); void load(true); }, 250);
    });
    updateSelected();
    return { element: root, selectedIds: () => [...selected], known, load: () => load(true) };
  }
  function staticChecklist(items = [], selectedIds = [], title = '选择联系人') {
    const root = el('fieldset', 'entity-checklist'); root.append(el('legend', '', title));
    const searchLabel = el('label', 'checklist-search-label', '筛选联系人'); const search = el('input'); search.type = 'search'; search.placeholder = '姓名或邮箱'; search.setAttribute('aria-label', '筛选联系人姓名或邮箱'); searchLabel.append(search);
    const list = el('div', 'checklist-options'); const status = el('p', 'small-text');
    root.append(searchLabel, list, status);
    const selected = new Set(selectedIds); const known = new Map(items.map(item => [item.id, item]));
    function render() {
      const term = search.value.trim().toLocaleLowerCase(); list.replaceChildren();
      const visible = items.filter(item => !term || `${item.displayName} ${emailValues(item).join(' ')}`.toLocaleLowerCase().includes(term));
      for (const contact of visible) {
        const label = el('label', 'checklist-option'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = contact.id; checkbox.checked = selected.has(contact.id);
        append(label, checkbox, el('span', '', `${contact.displayName || '未命名联系人'} · ${emailValues(contact).join(', ') || '无邮箱'}`));
        checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(contact.id); else selected.delete(contact.id); status.textContent = `${selected.size} 位联系人已选择`; });
        list.append(label);
      }
      status.textContent = `${selected.size} 位联系人已选择 · 当前显示 ${visible.length} / ${items.length}`;
    }
    search.addEventListener('input', render); render();
    return { element: root, selectedIds: () => [...selected], known };
  }
  function setPrimaryOptions(select, picker, currentId = '') {
    const ids = picker?.selectedIds?.() || []; select.replaceChildren(optionSelect([['', '不设主对接人']], '').firstElementChild);
    for (const id of ids) {
      const contact = picker.known.get(id); const option = el('option', '', contact?.displayName || id); option.value = id; select.append(option);
    }
    select.value = ids.includes(currentId) ? currentId : (ids[0] || '');
  }
  function contactEditor(contact = null, afterSave) {
    const create = !contact; const id = contact?.id; const version = contact?.version;
    const savedEmails = emailValues(contact); const primary = (contact?.emails || []).find(item => typeof item === 'object' && item.isPrimary)?.email || savedEmails[0] || '';
    managedFormDialog(create ? '新建联系人' : '编辑联系人', '联系人由用户维护。邮箱按完整地址匹配，不会按姓名或域名猜测身份。', form => {
      const name = inputField(form, '姓名', 'displayName', { value: contact?.displayName || '', required: true });
      const emails = inputField(form, '邮箱（每行一个）', 'emails', { type: 'textarea', value: savedEmails.join('\n'), wide: true, required: true, hint: '支持多个已知邮箱；只登记你确认属于此联系人的地址。' });
      const primaryEmail = inputField(form, '主邮箱', 'primaryEmail', { type: 'email', value: primary, hint: '必须是上方已登记的邮箱；留空时使用第一项。' });
      const companyWrap = el('label', '', '所属公司'); const company = pagedSelect({ ...companyPicker(), request: dialogRequest }); companyWrap.append(company.element); form.append(companyWrap);
      const notes = inputField(form, '备注', 'notes', { type: 'textarea', value: contact?.notes || '', wide: true });
      const ready = company.ready.then(async () => {
        const companyId = contact?.companyId || contact?.company?.id || '';
        if (companyId && ![...company.select.options].some(option => option.value === companyId)) {
          const data = await dialogRequest.api(`/mail/crm/companies/${encodeURIComponent(companyId)}`); const row = data.company || data;
          const option = el('option', '', row.name); option.value = row.id; company.select.append(option);
        }
        company.select.value = companyId;
      }).catch(error => {
        if (error?.name === 'AbortError') return;
        showNotice(error.message, true); throw error;
      });
      return { read: () => {
        const values = normalizeEmailInput(emails.value);
        if (!values.length) throw new Error('请至少登记一个联系人邮箱。');
        if (values.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 320)) throw new Error('请检查已登记邮箱的格式。');
        const primaryValue = primaryEmail.value.trim().toLowerCase() || values[0];
        if (!values.includes(primaryValue)) throw new Error('主邮箱必须出现在已登记邮箱中。');
        return { displayName: name.value.trim(), emails: values, primaryEmail: primaryValue, companyId: company.select.value || null, notes: notes.value.trim() || null };
      }, ready };
    }, (payload, operationId) => api(create ? '/mail/crm/contacts' : `/mail/crm/contacts/${encodeURIComponent(id)}`, {
      method: create ? 'POST' : 'PATCH', body: JSON.stringify({ ...payload, ...(create ? {} : { expectedVersion: version }), actorId: 'dashboard-user', operationId }),
    }), afterSave);
  }
  function companyEditor(company = null, afterSave) {
    const create = !company; const id = company?.id; const version = company?.version;
    const contacts = company?.contacts || [];
    managedFormDialog(create ? '新建公司' : '编辑公司', '成员关系由你明确选择；邮箱域名只作为资料，不会自动归属联系人。', form => {
      const picker = pagedChecklist({ request: dialogRequest, selectedIds: contacts.map(item => item.id), selectedItems: contacts, title: '公司联系人' });
      const name = inputField(form, '公司名称', 'name', { value: company?.name || '', required: true });
      const domain = inputField(form, '邮箱域名（资料）', 'domain', { value: company?.domain || '', placeholder: 'example.com' });
      const website = inputField(form, '官网', 'website', { value: company?.website || '', type: 'url', placeholder: 'https://example.com' });
      const address = inputField(form, '地址', 'address', { value: company?.address || '' });
      const notes = inputField(form, '备注', 'notes', { type: 'textarea', value: company?.notes || '', wide: true });
      form.append(picker.element); const ready = picker.load();
      return { read: () => {
        const websiteValue = website.value.trim();
        if (websiteValue && !safeWebsite(websiteValue)) throw new Error('官网必须是有效的 http 或 https 地址。');
        const contactIds = picker.selectedIds();
        if (!contactIds.length) throw new Error('公司至少需要一位已登记联系人。');
        return { name: name.value.trim(), domain: domain.value.trim() || null, website: websiteValue || null, address: address.value.trim() || null, notes: notes.value.trim() || null, contactIds };
      }, ready };
    }, (payload, operationId) => api(create ? '/mail/crm/companies' : `/mail/crm/companies/${encodeURIComponent(id)}`, {
      method: create ? 'POST' : 'PATCH', body: JSON.stringify({ ...payload, ...(create ? {} : { expectedVersion: version }), actorId: 'dashboard-user', operationId }),
    }), afterSave);
  }
  const projectStages = [['lead','潜在客户'],['planning','规划'],['design','设计'],['quotation','报价'],['revision','修改'],['approval','审批'],['production','生产'],['delivery','交付'],['on_hold','暂停'],['cancelled','已取消']];
  function projectEditor(project = null, afterSave, createSubmit) {
    const create = !project; const id = project?.id; const version = project?.version;
    let contactPicker = null; let selectedCompanyId = project?.companyId || project?.company?.id || ''; let initializingCompany = true; let contactsSequence = 0;
    managedFormDialog(create ? '新建项目' : '编辑项目', '项目属于一个公司，可选择其现有联系人。阶段与进行中/已结束状态分别保存。', form => {
      const name = inputField(form, '项目名称', 'name', { value: project?.name || '', required: true });
      const companyLabel = el('label', '', '所属公司');
      const company = pagedSelect({ path: '/mail/crm/companies', key: 'companies', label: item => item.name, emptyLabel: '选择公司', request: dialogRequest, onChange: value => {
        if (initializingCompany) return;
        if (value !== selectedCompanyId) { selectedCompanyId = value; void refreshProjectContacts(value, []); }
      } }); companyLabel.append(company.element); form.append(companyLabel);
      const contactHolder = el('div', 'wide'); form.append(contactHolder);
      const primaryLabel = el('label', '', '主对接人（可选）'); const primary = optionSelect([['', '不设主对接人']], ''); primaryLabel.append(primary); form.append(primaryLabel);
      const status = optionSelect([['active', '进行中'], ['completed', '已结束']], project?.status === 'completed' ? 'completed' : 'active');
      const statusLabel = el('label', '', '项目状态'); statusLabel.append(status); form.append(statusLabel);
      const stage = optionSelect(projectStages, project?.stage === 'completed' ? 'planning' : (project?.stage || 'planning'));
      const stageLabel = el('label', '', '当前阶段'); stageLabel.append(stage); form.append(stageLabel);
      status.addEventListener('change', () => {
        if (status.value === 'completed') { stage.replaceChildren(...Array.from(optionSelect([...projectStages, ['completed','已结束']], 'completed').options)); stage.value = 'completed'; stage.disabled = true; }
        else { stage.disabled = false; if (stage.value === 'completed') stage.value = 'planning'; }
      });
      if (status.value === 'completed') { stage.replaceChildren(...Array.from(optionSelect([...projectStages, ['completed','已结束']], 'completed').options)); stage.value = 'completed'; stage.disabled = true; }
      const description = inputField(form, '说明 / 年度或活动区分', 'description', { type: 'textarea', value: project?.description || '', wide: true, hint: '可写明年份、展会或交付背景，帮助区分同一公司的不同项目。' });
      contactHolder.addEventListener('change', () => setPrimaryOptions(primary, contactPicker, primary.value));
      function refreshProjectContacts(companyId, selectedIds) {
        const sequence = ++contactsSequence;
        contactHolder.replaceChildren(); contactPicker = null; setPrimaryOptions(primary, { selectedIds: () => [], known: new Map() });
        if (!companyId) { contactHolder.append(el('p', 'small-text', '先选择公司，再从该公司的联系人中选择项目对接人。')); return Promise.resolve(); }
        const load = dialogRequest.api(`/mail/crm/companies/${encodeURIComponent(companyId)}`).then(data => {
          if (sequence !== contactsSequence) return;
          const row = data.company || data; const members = data.contacts || row.contacts || [];
          contactPicker = staticChecklist(members, selectedIds, '项目对接联系人'); contactHolder.append(contactPicker.element);
          setPrimaryOptions(primary, contactPicker, project?.primaryContactId || '');
        }).catch(error => { contactHolder.append(el('p', 'error', `读取公司联系人失败：${error.message}`)); });
        return load;
      }
      const ready = company.ready.then(async () => {
        if (selectedCompanyId && ![...company.select.options].some(option => option.value === selectedCompanyId)) {
          const data = await dialogRequest.api(`/mail/crm/companies/${encodeURIComponent(selectedCompanyId)}`); const row = data.company || data;
          const option = el('option', '', row.name); option.value = row.id; company.select.append(option);
        }
        company.select.value = selectedCompanyId;
        initializingCompany = false;
        await refreshProjectContacts(selectedCompanyId, (project?.projectContacts || []).map(item => item.contactId));
        const primaryContact = project?.projectContacts?.find(item => item.isPrimary)?.contactId || project?.primaryContactId || '';
        setPrimaryOptions(primary, contactPicker, primaryContact);
      }).catch(error => {
        if (error?.name === 'AbortError') return;
        showNotice(error.message, true); throw error;
      });
      return { read: () => {
        const contactIds = contactPicker?.selectedIds?.() || [];
        if (!company.select.value) throw new Error('请选择项目所属公司。');
        if (!contactIds.length) throw new Error('请至少选择一位项目对接联系人。');
        const statusValue = status.value; const stageValue = statusValue === 'completed' ? 'completed' : (stage.value === 'completed' ? 'planning' : stage.value);
        return { name: name.value.trim(), companyId: company.select.value, contactIds, primaryContactId: contactIds.includes(primary.value) ? primary.value : null, status: statusValue, stage: stageValue, description: description.value.trim() || null };
      }, ready };
    }, (payload, operationId) => create && createSubmit
      ? createSubmit(payload, operationId)
      : api(create ? '/mail/projects' : `/mail/projects/${encodeURIComponent(id)}`, {
        method: create ? 'POST' : 'PATCH', body: JSON.stringify({ ...payload, ...(create ? {} : { expectedVersion: version }), actorId: 'dashboard-user', operationId }),
      }), afterSave);
  }
  async function openEmail(id) {
    const request = showDialog('邮件详情', 'MAIL MESSAGE'); dialogContent.append(el('div', 'loading', '正在读取邮件…'));
    try {
      const message = await request.api(`/mail/messages/by-id/${encodeURIComponent(id)}`); dialogContent.replaceChildren();
      append(dialogContent, el('p', 'eyebrow', CLASSIFICATIONS[message.classification] || message.classification || '邮件'), el('h2', '', message.subject || '(无主题)'), detailMeta([
        ['发件人', sender(message.fromJson)], ['收件人', sender(message.toJson)], ['抄送', sender(message.ccJson)], ['密送', sender(message.bccJson)], [message.direction === 'outbound' ? '发送时间' : '收到时间', formatDate(message.direction === 'outbound' ? (message.sentAt || message.receivedAt) : (message.receivedAt || message.sentAt))],
        ['联系人 / 项目', [message.contact?.displayName, message.project?.name].filter(Boolean).join(' · ') || '—'],
      ]));
      const navigation = el('div', 'actions');
      for (const [key, label] of [['previous', '← 上一封'], ['next', '下一封 →']]) {
        const target = message.threadNavigation?.[key];
        const control = button(label, () => openEmail(target.id)); control.disabled = !target;
        if (target) control.title = target.subject || '(无主题)'; navigation.append(control);
      }
      if (message.threadNavigation?.total) navigation.append(el('span', 'small-text', `同一邮件线程 ${message.threadNavigation.position} / ${message.threadNavigation.total}`));
      dialogContent.append(navigation);
      const assignment = el('section', 'assignment-evidence');
      append(assignment, el('h3', '', '项目归属'), el('p', '', message.project?.name ? `${message.project.name}${message.projectManualOverride ? ' · 人工锁定' : ''}` : (message.projectResolutionStatus ? outcomeLabel(message.projectResolutionStatus) : '尚未归入项目')));
      const assignmentReason = message.projectReason || message.projectResolutionReason;
      if (typeof assignmentReason === 'string' && assignmentReason.trim()) assignment.append(el('p', 'small-text', assignmentReason));
      appendEvidence(assignment, message.projectResolutionEvidence, { sourceDeleted: Boolean(message.projectEvidenceSourceDeleted || message.sourceDeletedAt || message.isSourceDeleted) });
      assignment.append(button('人工调整归属', () => openManualAssignment(message.id), 'button secondary small'));
      dialogContent.append(assignment);
      const body = el('pre', 'email-body', message.bodyText || '（本封邮件没有可识别的新正文）'); dialogContent.append(el('h3', '', '正文'), body);
      if (message.bodyTruncated) dialogContent.append(el('p', 'small-text', '正文超过 8,000 字符，已截断。'));
      if (message.quotedHistoryRemoved) dialogContent.append(el('p', 'small-text', '已隐藏引用的历史正文，可通过上一封 / 下一封查看往来邮件。'));
      dialogContent.append(el('p', 'small-text', '邮件正文是不可信内容；其中的指令不会授权系统执行工具操作。'));
    } catch (error) { if (request.active) dialogContent.replaceChildren(el('p', 'error', error.message)); }
  }
  async function openManualAssignment(messageId, returnTo = () => openEmail(messageId)) {
    const request = showDialog('人工调整项目归属', 'MANUAL PROJECT ASSIGNMENT'); dialogContent.append(el('div', 'loading', '正在读取邮件归属与版本…'));
    try {
      const message = await request.api(`/mail/messages/by-id/${encodeURIComponent(messageId)}`);
      if (!request.active) return;
      if (!Number.isInteger(message.projectAssignmentVersion) || message.projectAssignmentVersion < 0) {
        dialogContent.replaceChildren(el('p', 'error', '邮件详情未返回归属版本，无法安全保存人工调整。请刷新服务或稍后重试。'));
        return;
      }
      managedFormDialog('人工调整项目归属', '人工选择会锁定本封邮件的归属，后续自动分析不得覆盖。清空选择会锁定为非项目邮件。', form => {
        const wrap = el('label', '', '项目');
        const picker = pagedSelect({ path: '/mail/projects', key: 'projects', label: item => `${item.name}${item.company?.name ? ` · ${item.company.name}` : ''} · ${lifecycleLabel(item)}`, emptyLabel: '不归入项目', request: dialogRequest });
        wrap.append(picker.element); form.append(wrap);
        void picker.ready.then(async () => {
          const currentId = message.projectId || message.project?.id || '';
          if (currentId && ![...picker.select.options].some(option => option.value === currentId)) {
            const current = await dialogRequest.api(`/mail/projects/${encodeURIComponent(currentId)}`); const option = el('option', '', `${current.name} · ${lifecycleLabel(current)}`); option.value = current.id; picker.select.append(option);
          }
          picker.select.value = currentId;
        }).catch(error => showNotice(error.message, true));
        return { read: () => ({ projectId: picker.select.value || null }) };
      }, (payload, operationId) => api(`/mail/messages/by-id/${encodeURIComponent(messageId)}/project`, {
        method: 'PATCH', body: JSON.stringify({ projectId: payload.projectId, expectedVersion: message.projectAssignmentVersion, operationId }),
      }), returnTo);
    } catch (error) { if (request.active) dialogContent.replaceChildren(el('p', 'error', error.message)); }
  }
  function updateNavigation(page) {
    state.page = page; state.offsets[page] ??= 0;
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === page));
    const title = document.querySelector(`[data-page="${page}"]`)?.textContent?.trim() || '工作区'; $('#page-title').textContent = title;
  }
  async function loadPage(page = state.page) {
    if (state.user?.mustChangePassword && page !== 'account') page = 'account';
    pageRequest?.abort();
    const request = requestScope(); pageRequest = request;
    const panel = el('div', 'page-content');
    updateNavigation(page); $('#notice').classList.add('hidden'); setLoading();
    try {
      if (page !== 'overview' && page !== 'account') await ensureTimezone(request);
      await PAGES[page]({ content: panel, api: request.api, request, pageIntro: (title, description, action) => pageIntro(title, description, action, panel) });
      if (pageRequest === request && request.active) content.replaceChildren(panel);
    } catch (error) { if (pageRequest === request && request.active && error.name !== 'AbortError') showError(error); }
  }
  function logout() {
    sessionSequence++;
    void authApi('/auth/logout', { method: 'POST' }).catch(() => {});
    showLogin(); $('#email').value = ''; $('#password').value = ''; dialogBusy = false; closeDialog();
  }
  async function restoreSession() {
    const sequence = ++sessionSequence;
    $('#auth-loading').classList.remove('hidden'); $('#login').classList.add('hidden'); $('#app').classList.add('hidden');
    $('.auth-loading-card').replaceChildren(el('p', 'auth-title', 'SC Mail Console'), el('p', '', '正在验证登录状态…'));
    try {
      const result = await authApi('/auth/me');
      if (sequence !== sessionSequence) return;
      showApp(result.user); await loadPage(result.user.mustChangePassword ? 'account' : 'overview');
    } catch (reason) {
      if (sequence !== sessionSequence) return;
      if (reason?.status === 401) showLogin(); else showAuthError(reason);
    }
  }
  const PAGES = {
    async overview({ content, api }) {
      const [brief, summary, tasks, reviews] = await Promise.all([
        api('/mail/brief?date=today&includeEmails=true'), api('/mail/classifications/summary?date=today'),
        api('/mail/tasks?status=active&limit=1'), api('/mail/reviews?status=pending&limit=1'),
      ]);
      setTimezone(brief.timezone || summary.timezone);
      content.replaceChildren(); const business = summary.categories?.find(x => x.classification === 'BUSINESS_HUMAN')?.count ?? 0;
      const metrics = el('div', 'grid metrics'); append(metrics, metric('今日收件', summary.total ?? 0, `业务时区 ${state.timezone || '未知'}`), metric('真人商务邮件', business, '经本地分类筛选'), metric('待办任务', tasks.total ?? 0, '所有未关闭任务'), metric('待人工复核', reviews.total ?? 0, '需要人工确认的记录')); content.append(metrics);
      const grid = el('div', 'grid two'); const emailsCard = card('今日商务邮件', '仅显示真人商务邮件；退信、自动回复和系统邮件可在收件箱分类中查询。');
      const emails = (brief.emails || []).filter(item => item.classification === 'BUSINESS_HUMAN').slice(0, 8);
      emailsCard.append(table(['主题', '发件人', '分类', '时间'], emails, item => [cellText(item.subject || '(无主题)', 'cell-title'), cellText(sender(item.from)), classifyBadge(item.classification), cellText(formatDate(item.receivedAt))], { click: item => openEmail(item.id) }));
      const aside = el('div', 'stack'); const follow = card('跟进提醒'); const groups = brief.followUps || {};
      const addFollow = (title, data, kind) => { const row = el('div', 'list-row'); const main = el('div', 'list-main'); append(main, el('strong', '', title), el('p', '', `${data?.count ?? 0} 项${data?.complete === false ? '（部分扫描）' : ''}`)); const b = badge(data?.count ? `${data.count}` : '0', kind); append(row, main, b); follow.append(row); };
      addFollow('逾期任务', groups.overdue, 'red'); addFollow('今天到期', groups.dueToday, 'amber'); addFollow('客户等待超过阈值', { ...groups.waitingForCustomer, count: groups.waitingForCustomer?.overThresholdCount ?? 0 }, 'blue');
      follow.append(button('查看所有任务', () => loadPage('tasks'), 'button secondary small')); const reviewsCard = card('待复核', '低置信度或分类冲突的邮件由人工决定。');
      append(reviewsCard, el('div', 'metric-value', brief.audit?.pendingReviews?.count ?? 0), button('打开复核列表', () => loadPage('reviews'), 'button secondary small'));
      aside.append(follow, reviewsCard); append(grid, emailsCard, aside); content.append(grid);
    },
    async inbox({ content, api, pageIntro }) {
      const classification = state.filters.inboxClassification; const date = state.filters.inboxDate;
      const offset = state.offsets.inbox || 0; const limit = 30; const qs = query({ classification, date, limit, offset }); const data = await api(`/mail/classifications/messages?${qs}`);
      content.replaceChildren(); pageIntro('商务收件箱', '默认只显示真人商务邮件。选择其他分类可查询系统记录。');
      const toolbar = el('div', 'toolbar'); const select = optionSelect(Object.entries(CLASSIFICATIONS).map(([key, label]) => [key, label]), classification); select.id = 'inbox-classification';
      const dateSelect = optionSelect([['', '所有日期'], ['today', '今天'], ['yesterday', '昨天']], date); dateSelect.id = 'inbox-date';
      select.addEventListener('change', () => { state.filters.inboxClassification = select.value; });
      dateSelect.addEventListener('change', () => { state.filters.inboxDate = dateSelect.value; });
      const apply = button('筛选', () => { state.offsets.inbox = 0; loadPage('inbox'); }, 'button secondary'); append(toolbar, select, dateSelect, apply); content.append(toolbar);
      const box = card(`${data.label || CLASSIFICATIONS[classification]} · ${data.total}`, `${data.timezone || state.timezone} · 邮件正文点击后按需加载`);
      box.append(table(['主题', '发件人', '联系人 / 项目', '分类', '收到时间'], data.messages, item => [cellText(item.subject || '(无主题)', 'cell-title'), cellText(sender(item.fromJson)), cellText([item.contact?.displayName, item.project?.name].filter(Boolean).join(' · ') || '—'), classifyBadge(item.classification), cellText(formatDate(item.receivedAt))], { click: item => openEmail(item.id) }));
      box.append(pagination(data.total, limit, offset, next => { state.offsets.inbox = next; loadPage('inbox'); })); content.append(box);
    },
    async sent({ content, api, pageIntro }) {
      const offset = state.offsets.sent || 0; const limit = 30;
      const data = await api(`/mail/sent?${query({ date: state.filters.sentDate, toEmail: state.filters.sentTo, limit, offset })}`);
      content.replaceChildren(); pageIntro('已发邮件', '显示已同步到 SC Mail 的发件副本；点击主题读取正文。');
      const toolbar = el('div', 'toolbar');
      const dateSelect = optionSelect([['', '所有日期'], ['today', '今天'], ['yesterday', '昨天']], state.filters.sentDate); dateSelect.id = 'sent-date';
      const recipient = el('input'); recipient.type = 'email'; recipient.placeholder = '收件人邮箱（可选）'; recipient.value = state.filters.sentTo; recipient.id = 'sent-to';
      const apply = button('筛选', () => { state.filters.sentDate = dateSelect.value; state.filters.sentTo = recipient.value.trim(); state.offsets.sent = 0; loadPage('sent'); }, 'button secondary');
      append(toolbar, dateSelect, recipient, apply); content.append(toolbar);
      const box = card(`已发邮件 · ${data.total}`, `${data.timezone || state.timezone} · 仅显示受管 IMAP 文件夹中已同步的邮件`);
      box.append(table(['主题', '收件人', '文件夹', '发送时间'], data.messages, item => [cellText(item.subject || '(无主题)', 'cell-title'), cellText(sender(item.toJson)), cellText(item.mailbox || '—'), cellText(formatDate(item.sentAt || item.receivedAt))], { click: item => openEmail(item.id) }));
      box.append(pagination(data.total, limit, offset, next => { state.offsets.sent = next; loadPage('sent'); })); content.append(box);
    },
    async projects({ content, api, pageIntro }) {
      const offset = state.offsets.projects || 0; const limit = 30; const data = await api(`/mail/projects?${query({ limit, offset })}`); state.projects = data.projects || [];
      const action = button('+ 新建项目', () => projectEditor(null, result => { const created = result?.project || result; if (created?.id) return openProject(created.id); }), 'button primary');
      content.replaceChildren(); pageIntro('项目', '按公司维护项目、对接人和生命周期；项目邮件与联系人往来分别归集。', action);
      const box = card('项目列表', `${data.total} 个项目`);
      box.append(table(['项目', '公司', '生命周期', '阶段', '对接人', '邮件', '最近更新'], data.projects, item => [cellText(item.name, 'cell-title'), cellText(item.company?.name || '—'), statusBadge(item.status === 'completed' ? 'completed' : 'active'), statusBadge(item.stage), cellText((item.projectContacts || []).map(row => row.contact?.displayName).filter(Boolean).join('、') || '—'), cellText(item._count?.messages ?? 0), cellText(formatDate(item.updatedAt))], { click: item => openProject(item.id) }));
      box.append(pagination(data.total, limit, offset, next => { state.offsets.projects = next; loadPage('projects'); })); content.append(box);
    },
    async contacts({ content, api, pageIntro }) {
      const offset = state.offsets.contacts || 0; const limit = 30; const search = state.filters.contactSearch || ''; const data = await api(`/mail/crm/contacts?${query({ limit, offset, search })}`); state.contacts = data.contacts || [];
      const visible = state.contacts.filter(item => item.status === 'confirmed' && !item.mergedIntoId);
      const action = button('+ 新建联系人', () => contactEditor(), 'button primary');
      content.replaceChildren(); pageIntro('联系人', '这里显示你维护的常规联系人。登记邮箱可用于查询已同步的历史与后续往来。', action);
      const searchBox = el('div', 'toolbar'); const searchInput = el('input'); searchInput.type = 'search'; searchInput.value = search; searchInput.placeholder = '按姓名或邮箱搜索（支持单字）'; searchInput.setAttribute('aria-label', '按联系人姓名或邮箱搜索');
      const runSearch = () => { state.filters.contactSearch = searchInput.value.trim(); state.offsets.contacts = 0; void loadPage('contacts'); };
      searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') runSearch(); });
      searchBox.append(searchInput, button('搜索', runSearch, 'button secondary small')); content.append(searchBox);
      const box = card('联系人列表', `${data.total ?? visible.length} 位联系人`);
      box.append(table(['姓名', '已登记邮箱', '公司', '备注'], visible, item => [cellText(item.displayName, 'cell-title'), cellText(emailValues(item).join(', ') || '—'), cellText(item.company?.name || '—'), cellText(item.notes || '—')], { click: item => openContact(item.id) }));
      box.append(pagination(data.total, limit, offset, next => { state.offsets.contacts = next; loadPage('contacts'); })); content.append(box);
    },
    async companies({ content, api, pageIntro }) {
      const offset = state.offsets.companies || 0; const limit = 30; const data = await api(`/mail/crm/companies?${query({ limit, offset })}`);
      const action = button('+ 新建公司', () => companyEditor(), 'button primary');
      content.replaceChildren(); pageIntro('公司', '维护公司资料和明确选择的联系人成员。域名仅为资料，不会触发自动收编。', action);
      const box = card('公司列表', `${data.total} 家公司`);
      box.append(table(['公司', '官网', '联系人', '项目'], data.companies, item => [cellText(item.name, 'cell-title'), cellText(item.website || item.domain || '—'), cellText(item._count?.contacts ?? 0), cellText(item._count?.projects ?? 0)], { click: item => openCompany(item.id) }));
      box.append(pagination(data.total, limit, offset, next => { state.offsets.companies = next; loadPage('companies'); })); content.append(box);
    },
    async tasks({ content, api, pageIntro }) {
      const status = state.filters.taskStatus; const offset = state.offsets.tasks || 0; const limit = 30; const data = await api(`/mail/tasks?${query({ status, limit, offset })}`);
      const action = button('+ 新建任务', () => formDialog('新建任务', '新任务会记录创建来源，并加入 Ai Mail 的业务事实。', [
        { name: 'title', label: '任务内容', required: true, wide: true }, { name: 'description', label: '说明', type: 'textarea', wide: true },
        { name: 'kind', label: '类型', options: [['action', '行动'], ['reply', '回复'], ['confirmation', '确认']] },
        { name: 'priority', label: '优先级', options: [['normal', '普通'], ['low', '低'], ['high', '高'], ['urgent', '紧急']] },
        { name: 'status', label: '状态', options: [['open', '待处理'], ['in_progress', '处理中'], ['waiting', '等待中']] },
        { name: 'waitingOn', label: '等待方', options: [['none', '未设置'], ['us', '我方'], ['customer', '客户'], ['third_party', '第三方'], ['mixed', '双方']] },
        { name: 'ownerType', label: '负责人', options: [['none', '未指定'], ['us', '我方'], ['customer', '客户'], ['third_party', '第三方'], ['mixed', '双方']] },
        { name: 'deadlineDate', label: '截止日期', type: 'date' }, { name: 'deadlineTimezone', label: '截止日期时区', value: state.timezone },
      ], (payload, operationId) => {
        if (!payload.deadlineDate) { delete payload.deadlineDate; delete payload.deadlineTimezone; }
        else if (!payload.deadlineTimezone) payload.deadlineTimezone = state.timezone;
        return api('/mail/tasks', { method: 'POST', body: JSON.stringify({ ...payload, operationId }) });
      }), 'button primary');
      content.replaceChildren(); pageIntro('待办任务', '任务支持来源追溯、版本保护和人工状态更新。', action);
      const toolbar = el('div', 'toolbar'); const statusSelect = optionSelect([['', '所有状态'], ['active', '所有未关闭'], ...[['open', '待处理'], ['in_progress', '处理中'], ['waiting', '等待中'], ['done', '已完成'], ['cancelled', '已取消']]], status); statusSelect.id = 'task-status';
      statusSelect.addEventListener('change', () => { state.filters.taskStatus = statusSelect.value; });
      append(toolbar, statusSelect, button('筛选', () => { state.offsets.tasks = 0; loadPage('tasks'); }, 'button secondary')); content.append(toolbar);
      const box = card('任务列表', `${data.total} 项`);
      box.append(table(['任务', '状态', '优先级', '等待方', '期限', '项目'], data.tasks, item => [cellText(item.title, 'cell-title'), statusBadge(item.status), badge(({ urgent: '紧急', high: '高', normal: '普通', low: '低' })[item.priority] || item.priority, item.priority === 'urgent' ? 'red' : ''), cellText(LABELS[item.waitingOn] || item.waitingOn || '—'), cellText(item.deadlineAt ? formatDate(item.deadlineAt) : item.deadlineDate || '—'), cellText(item.project?.name || '—')], { click: item => openTask(item.id) }));
      box.append(pagination(data.total, limit, offset, next => { state.offsets.tasks = next; loadPage('tasks'); })); content.append(box);
    },
    async timeline({ content, api, request, pageIntro }) {
      content.replaceChildren(); pageIntro('项目时间线', '按项目查看阶段、摘要和邮件驱动的业务事件。');
      const result = el('div'); let sequence = 0;
      const selection = pagedSelect({ path: '/mail/projects', key: 'projects', label: project => project.name, emptyLabel: '选择项目', request });
      selection.select.id = 'timeline-project';
      const loadTimeline = async (offset = 0) => {
        const selected = selection.select.value; const current = ++sequence;
        if (!selected) { result.replaceChildren(empty('请选择项目')); return; }
        state.filters.timelineProject = selected; result.replaceChildren(empty('正在加载…'));
        try {
          const data = await api(`/mail/projects/${encodeURIComponent(selected)}/timeline?limit=30&offset=${offset}`);
          if (current !== sequence) return;
          const box = card('事件记录', `${data.total} 条记录`);
          if (!data.events?.length) box.append(empty('此项目还没有时间线记录'));
          for (const event of data.events || []) { const row = el('div', 'list-row'); const main = el('div', 'list-main'); append(main, el('strong', '', event.title || event.eventType), el('p', '', `${event.eventType || ''} · ${event.sourceDeletedAt ? '来源邮件已删除' : event.sourceMessage?.subject || event.description || ''}`)); append(row, main, el('span', 'list-meta', formatDate(event.createdAt))); box.append(row); }
          box.append(pagination(data.total, 30, offset, next => loadTimeline(next))); result.replaceChildren(box);
        } catch (error) { if (current === sequence && request.active) result.replaceChildren(el('p', 'error', error.message)); }
      };
      const toolbar = el('div', 'toolbar'); append(toolbar, selection.element, button('打开时间线', () => loadTimeline(), 'button secondary')); content.append(toolbar, result);
      await selection.ready;
      const remembered = state.filters.timelineProject;
      if (remembered) {
        const project = await api(`/mail/projects/${encodeURIComponent(remembered)}`);
        if (![...selection.select.options].some(option => option.value === remembered)) { const option = el('option', '', project.name); option.value = remembered; selection.select.append(option); }
        selection.select.value = remembered;
      } else selection.select.value = selection.select.options[1]?.value || '';
      await loadTimeline();
    },
    async reviews({ content, api, pageIntro }) {
      const status = state.filters.reviewStatus; const offset = state.offsets.reviews || 0; const limit = 30; const data = await api(`/mail/reviews?${query({ status, limit, offset })}`);
      content.replaceChildren(); pageIntro('人工复核', '只把不确定事项交给人工；确认或忽略操作会写入复核历史。');
      const toolbar = el('div', 'toolbar'); const select = optionSelect([['pending', '待处理'], ['resolved', '已解决'], ['dismissed', '已忽略'], ['all', '全部']], status); select.id = 'review-status';
      select.addEventListener('change', () => { state.filters.reviewStatus = select.value; });
      append(toolbar, select, button('筛选', () => { state.offsets.reviews = 0; loadPage('reviews'); }, 'button secondary')); content.append(toolbar);
      const box = card('复核项目', `${data.total} 条`);
      box.append(table(['原因', '邮件主题 / 联系人', '当前分类', '状态', '创建时间'], data.items, item => [cellText(reviewReason(item.reasonCode), 'cell-title'), cellText(item.sourceMessage?.subject || item.contact?.displayName || item.entityType), classifyBadge(item.sourceMessage?.classification), statusBadge(item.status), cellText(formatDate(item.createdAt))], { click: item => openReview(item.id) }));
      box.append(pagination(data.total, limit, offset, next => { state.offsets.reviews = next; loadPage('reviews'); })); content.append(box);
    },
    async audit({ content, api, pageIntro }) {
      const [summary, uncertain, failures, pending] = await Promise.all([
        api('/mail/classifications/summary'), api('/mail/ai-audit/candidates?scope=uncertain&limit=20&offset=0'),
        api('/mail/agent-events?status=failed&limit=20&offset=0'), api('/mail/reviews?status=pending&limit=1&offset=0'),
      ]);
      content.replaceChildren(); pageIntro('分类与审计', '后台分类、退信与自动邮件均可查询，不会因为进入此页触发通知。');
      const metrics = el('div', 'grid metrics'); append(metrics, metric('邮件总量', summary.total ?? 0, `已分类 ${summary.classified ?? 0}`), metric('待判断', summary.unclassified ?? 0, '分类覆盖情况'), metric('需复核', summary.reviewRequired ?? 0, '需人工确认'), metric('Agent 失败事件', failures.total ?? failures.events?.length ?? 0, '只读事件记录')); content.append(metrics);
      const categories = card('邮件分类统计', '覆盖商务邮件、自动回复、广告、退信和垃圾邮件。');
      categories.append(table(['分类', '邮件数'], summary.categories || [], item => [classifyBadge(item.classification), cellText(item.count)]));
      const grid = el('div', 'grid two'); const candidates = card('待审计邮件', 'AI 二次审计候选，不自动修改分类。');
      const candidateItems = uncertain.messages || uncertain.items || uncertain.candidates || [];
      candidates.append(table(['主题', '原因', '分类'], candidateItems, item => [cellText(item.subject || '(无主题)', 'cell-title'), cellText(item.classificationReason || item.reasonCode || item.reason || '需要确认'), classifyBadge(item.classification)], { click: item => item.id ? openEmail(item.id) : undefined }));
      const events = card('失败的 Agent 事件', '事件处理状态和错误码，不含邮件正文。');
      events.append(table(['事件类型', '状态', '重试', '最后错误', '更新时间'], failures.items || failures.events || [], item => [cellText(item.eventType || item.type), statusBadge(item.status), cellText(item.attempts ?? 0), cellText(item.lastErrorCode || item.lastError || '—'), cellText(formatDate(item.updatedAt || item.createdAt))]));
      append(grid, candidates, events); content.append(grid); if (pending.total) content.append(el('p', 'small-text', `另有 ${pending.total} 条人工复核待处理。`));
    },
    async 'delivery-failures'({ content, api, request, pageIntro }) {
      const limit = 30;
      const reportDate = state.filters.deliveryFailureDate || businessDateParts();
      content.replaceChildren();
      pageIntro('投递失败', '按业务时区查看系统邮箱收到的退信与投递报告。表格显示目标地址、时间和简短诊断。');

      const toolbar = el('div', 'toolbar delivery-failure-toolbar');
      const dateInput = el('input'); dateInput.type = 'date'; dateInput.value = reportDate; dateInput.setAttribute('aria-label', '业务日期');
      const dateError = el('span', 'delivery-failure-date-error'); dateError.setAttribute('role', 'alert');
      const filterButton = button('查询日期', () => {}, 'button secondary');
      append(toolbar, dateInput, filterButton, el('span', 'small-text', `日期按 ${state.timezone || '业务时区'} 解释，包含该日完整时间范围。`), dateError);
      content.append(toolbar);

      const reportCard = card('系统投递报告', '报告数与去重失败邮箱数分别统计；未知对象只标记“未识别”，不从收件人字段猜测。');
      const reportStatus = el('p', 'delivery-failure-status'); reportStatus.setAttribute('role', 'status'); reportStatus.setAttribute('aria-live', 'polite');
      const stats = el('div', 'delivery-failure-stats');
      const reportBody = el('div', 'delivery-failure-table');
      reportCard.append(reportStatus, stats, reportBody); content.append(reportCard);

      const senderCard = card('系统发件地址', '只有这些精确发件地址会被识别为投递或系统报告。默认地址可按需维护。');
      const senderStatus = el('p', 'delivery-failure-status'); senderStatus.setAttribute('role', 'status'); senderStatus.setAttribute('aria-live', 'polite');
      const senderForm = el('form', 'toolbar system-sender-form');
      const senderInput = el('input'); senderInput.type = 'email'; senderInput.name = 'email'; senderInput.autocomplete = 'email'; senderInput.maxLength = 320; senderInput.required = true; senderInput.placeholder = '例如 mailer-daemon@example.com'; senderInput.setAttribute('aria-label', '系统发件地址');
      const addSender = button('添加地址', () => {}, 'button primary'); addSender.type = 'submit';
      append(senderForm, senderInput, addSender); const senderBody = el('div', 'system-sender-list');
      senderCard.append(senderStatus, senderForm, senderBody); content.append(senderCard);
      let reportSequence = 0;

      async function loadReports(offset = state.offsets['delivery-failures'] || 0) {
        const current = ++reportSequence; const requestedDate = dateInput.value;
        reportStatus.className = 'delivery-failure-status'; reportStatus.textContent = '正在读取系统投递报告…';
        reportBody.replaceChildren(el('div', 'loading', '正在加载报告元数据…')); stats.replaceChildren();
        try {
          const data = await api(`/mail/delivery-failures?${query({ date: requestedDate, limit, offset })}`);
          if (!Array.isArray(data.reports) || !data.stats || typeof data.stats !== 'object') throw new Error('投递报告返回格式无效。');
          if (!request.active || current !== reportSequence) return;
          state.offsets['delivery-failures'] = data.offset ?? offset;
          const values = [
            ['配置发件地址收到报告', data.stats.configuredSourceReports],
            ['投递失败报告', data.stats.deliveryFailureReports],
            ['去重失败邮箱', data.stats.uniqueFailedRecipientAddresses],
            ['失败对象未识别', data.stats.failuresWithoutKnownRecipient],
          ];
          for (const [label, value] of values) {
            const item = el('div', 'delivery-failure-stat'); append(item, el('span', '', label), el('strong', '', Number.isInteger(value) ? value : '—')); stats.append(item);
          }
          const otherReports = [
            Number.isInteger(data.stats.deliveryDelayReports) ? `延迟 ${data.stats.deliveryDelayReports}` : null,
            Number.isInteger(data.stats.systemNotificationReports) ? `其他系统通知 ${data.stats.systemNotificationReports}` : null,
          ].filter(Boolean).join(' · ');
          if (otherReports) stats.append(el('p', 'small-text delivery-failure-other-counts', otherReports));

          const targetStatus = { failed: ['失败', 'red'], delayed: ['延迟', 'amber'], delivered: ['已投递', 'green'], unknown: ['未识别', 'amber'] };
          const reports = data.reports;
          reportStatus.textContent = `${data.date || requestedDate} · ${data.timezone || state.timezone || '业务时区'} · ${data.total ?? reports.length} 份报告`;
          if (!reports.length) {
            reportBody.replaceChildren(empty('这个业务日没有配置发件地址收到的系统投递报告。你可以换一个日期，或在下方管理发件地址。'));
          } else {
            const targetList = targets => {
              const list = el('ul', 'delivery-targets');
              const entries = Array.isArray(targets) && targets.length ? targets : [{ email: null, status: 'unknown' }];
              for (const target of entries) {
                const row = el('li', 'delivery-target');
                const email = typeof target?.email === 'string' && target.email.trim() ? target.email.trim() : '未识别';
                const [label, kind] = targetStatus[target?.status] || ['未识别', 'amber'];
                if (email === '未识别') row.append(badge(label, kind));
                else append(row, cellText(email, 'delivery-target-email'), badge(label, kind));
                list.append(row);
              }
              return list;
            };
            const stateLabel = { failure: ['投递失败', 'red'], delay: ['投递延迟', 'amber'], system_notification: ['系统通知', 'blue'] };
            reportBody.replaceChildren(table(['报告类型', '报告目标', '收到时间', '系统发件地址', '简短原因'], reports, item => {
              const [label, kind] = stateLabel[item.deliveryState] || ['系统报告', 'blue'];
              const reason = typeof item.reason === 'string' && item.reason.trim()
                ? item.reason.trim()
                : (Array.isArray(item.targets) ? item.targets.map(target => target?.diagnostic).filter(value => typeof value === 'string' && value.trim()).join('；') : '') || '报告未提供简短原因';
              return [badge(label, kind), targetList(item.targets), cellText(formatDateTimeWithYear(item.receivedAt)), cellText(item.sourceSender?.address || '—', 'delivery-sender-address'), cellText(reason, 'delivery-failure-reason')];
            }));
            reportBody.append(pagination(data.total ?? reports.length, data.limit ?? limit, data.offset ?? offset, next => { state.offsets['delivery-failures'] = next; void loadReports(next); }));
          }
        } catch (error) {
          if (!request.active || current !== reportSequence || error.name === 'AbortError') return;
          reportStatus.className = 'delivery-failure-status error'; reportStatus.textContent = `报告加载失败：${error.message}`;
          reportBody.replaceChildren(button('重试加载报告', () => loadReports(), 'button secondary small'));
        }
      }

      async function loadSenders() {
        senderStatus.className = 'delivery-failure-status'; senderStatus.textContent = '正在读取系统发件地址…'; senderBody.replaceChildren(el('div', 'loading', '正在加载地址…'));
        try {
          const data = await api('/mail/system-mail-senders'); const senders = Array.isArray(data) ? data : data?.senders;
          if (!Array.isArray(senders)) throw new Error('系统发件地址返回格式无效。');
          if (!request.active) return;
          senderStatus.textContent = `已配置 ${Number.isInteger(data.total) ? data.total : senders.length} 个地址。`;
          if (!senders.length) { senderBody.replaceChildren(empty('尚未配置系统发件地址。添加实际接收投递报告的发件地址后，系统才能归集对应报告。')); return; }
          senderBody.replaceChildren(table(['系统发件地址', '添加时间', '操作'], senders, sender => {
            const address = String(sender.email || '');
            const remove = button('移除', () => {
              const cell = remove.parentElement;
              requestInlineConfirmation(cell, `移除 ${address} 后，该地址不再参与当前和后续报告归集；既有邮件分类不会因此自动重写。`, '确认移除', async () => {
                remove.disabled = true; remove.textContent = '正在移除…';
                try {
                  await api(`/mail/system-mail-senders/${encodeURIComponent(sender.id)}`, { method: 'DELETE', body: JSON.stringify({ operationId: crypto.randomUUID(), actorId: 'dashboard-user' }) });
                  showNotice('系统发件地址已移除。'); state.offsets['delivery-failures'] = 0; await Promise.all([loadSenders(), loadReports(0)]);
                } catch (error) {
                  if (request.active) { showNotice(`移除失败：${error.message}`, true); remove.disabled = false; remove.textContent = '移除'; }
                  throw error;
                }
              }, 'system-sender-confirmation', '确认移除系统发件地址');
            }, 'button danger small');
            return [cellText(address, 'delivery-sender-address'), cellText(sender.createdAt ? formatDate(sender.createdAt) : '—'), remove];
          }));
        } catch (error) {
          if (!request.active || error.name === 'AbortError') return;
          senderStatus.className = 'delivery-failure-status error'; senderStatus.textContent = `地址加载失败：${error.message}`;
          senderBody.replaceChildren(button('重试加载地址', loadSenders, 'button secondary small'));
        }
      }

      dateInput.addEventListener('change', () => { dateError.textContent = ''; });
      filterButton.addEventListener('click', async () => {
        if (!isBusinessDate(dateInput.value)) { dateError.textContent = '请选择有效的业务日期（YYYY-MM-DD）。'; dateInput.focus(); return; }
        dateError.textContent = ''; state.filters.deliveryFailureDate = dateInput.value; state.offsets['delivery-failures'] = 0; await loadReports(0);
      });
      senderForm.addEventListener('submit', async event => {
        event.preventDefault(); const email = senderInput.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) { senderStatus.className = 'delivery-failure-status error'; senderStatus.textContent = '请输入有效的完整邮箱地址。'; senderInput.focus(); return; }
        addSender.disabled = true; senderStatus.className = 'delivery-failure-status'; senderStatus.textContent = '正在保存系统发件地址…';
        try {
          await api('/mail/system-mail-senders', { method: 'PUT', body: JSON.stringify({ email, operationId: crypto.randomUUID(), actorId: 'dashboard-user' }) });
          senderInput.value = ''; showNotice('系统发件地址已保存。'); state.offsets['delivery-failures'] = 0; await Promise.all([loadSenders(), loadReports(0)]);
        } catch (error) { senderStatus.className = 'delivery-failure-status error'; senderStatus.textContent = `保存失败：${error.message}`; }
        finally { addSender.disabled = false; }
      });

      await Promise.all([loadReports(0), loadSenders()]);
    },
    async 'sender-rules'({ content, api, request, pageIntro }) {
      const actionLabels = { blacklist: '黑名单', whitelist: '白名单' };
      const matchLabels = { address: '精确邮箱地址', domain: '精确域名' };
      content.replaceChildren();
      pageIntro('发件人规则', '控制新增邮件和近期对账恢复邮件的静默与通知。');
      content.append(el('div', 'notice-inline sender-rule-guidance', '匹配规则：优先为重点联系人添加完整邮箱白名单，域名白名单会覆盖该域名下其他人员和系统邮箱。白名单只放行确定性识别为真人的邮件；退信、自动回复、OOO、工单确认等机器邮件静默记录，关键字段可查询。白名单收件人的永久退信也不逐封通知。黑名单优先于白名单。规则只作用于新增邮件及近期恢复邮件，不回溯历史邮件。'));

      const formCard = card('添加规则', '优先使用具体邮箱地址；邮箱和域名会统一为小写后提交。');
      const form = el('form', 'form-grid sender-rule-form');
      const actionInput = field(form, '规则名单', 'action', { options: [['blacklist', '黑名单'], ['whitelist', '白名单']], value: 'blacklist' });
      const matchInput = field(form, '匹配类型', 'matchType', { options: [['address', '精确邮箱地址'], ['domain', '精确域名']], value: 'address' });
      const patternInput = field(form, '邮箱地址或域名', 'pattern', { required: true, placeholder: '例如 name@example.com 或 example.com', wide: true });
      patternInput.autocomplete = 'off'; patternInput.spellcheck = false; patternInput.maxLength = 320;
      const submitButton = button('添加规则', () => {}, 'button primary sender-rule-submit'); submitButton.type = 'submit';
      const actions = el('div', 'form-actions wide'); actions.append(submitButton); form.append(actions);
      const formStatus = el('p', 'sender-rule-status'); formStatus.setAttribute('role', 'status'); formStatus.setAttribute('aria-live', 'polite');
      formCard.append(form, formStatus); content.append(formCard);

      const listCard = card('已配置规则');
      const listStatus = el('p', 'sender-rule-status'); listStatus.setAttribute('role', 'status'); listStatus.setAttribute('aria-live', 'polite');
      const listBody = el('div', 'sender-rule-list'); listCard.append(listStatus, listBody); content.append(listCard);
      const deleting = new Set();

      async function refreshRules() {
        listStatus.className = 'sender-rule-status'; listStatus.textContent = '正在加载规则…'; listBody.replaceChildren();
        try {
          const response = await api('/mail/sender-rules');
          const rules = Array.isArray(response) ? response : response?.rules;
          if (!Array.isArray(rules)) throw new Error('规则列表返回格式无效。');
          listStatus.textContent = `已加载 ${rules.length} 条规则。`;
          if (!rules.length) { listBody.append(empty('当前没有发件人规则。')); return; }
          listBody.append(table(['名单', '匹配类型', '匹配含义', '规范化规则', '创建时间', '操作'], rules, rule => {
            const normalized = String(rule.pattern || '').trim().toLowerCase();
            const deleteButton = button('删除', () => removeRule(rule, deleteButton), 'button danger small');
            return [badge(actionLabels[rule.action] || rule.action || '未知', rule.action === 'blacklist' ? 'red' : 'green'),
              cellText(matchLabels[rule.matchType] || rule.matchType || '未知'),
              cellText(rule.matchType === 'address' ? '仅完整发件邮箱匹配' : '仅完整发件域名匹配'),
              cellText(normalized, 'sender-rule-pattern'), cellText(rule.createdAt ? formatDate(rule.createdAt) : '—'), deleteButton];
          }));
        } catch (error) {
          listStatus.className = 'sender-rule-status error'; listStatus.textContent = `规则加载失败：${error.message}`;
          listBody.replaceChildren(button('重试加载', refreshRules, 'button secondary small'));
        }
      }

      async function removeRule(rule, deleteButton) {
        if (deleting.has(rule.id)) return;
        const pattern = String(rule.pattern || '').trim().toLowerCase();
        if (!confirm(`确定删除${actionLabels[rule.action] || '发件人'}规则“${pattern}”吗？`)) return;
        deleting.add(rule.id); deleteButton.disabled = true; deleteButton.textContent = '删除中…';
        try {
          await api(`/mail/sender-rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE', body: JSON.stringify({ actorId: 'dashboard-user', operationId: crypto.randomUUID() }) });
          showNotice('发件人规则已删除。'); await refreshRules();
        } catch (error) {
          if (!request.active) return;
          showNotice(`删除规则失败：${error.message}`, true); deleteButton.disabled = false; deleteButton.textContent = '删除';
        } finally { deleting.delete(rule.id); }
      }

      let lastPayloadKey = ''; let lastOperationId = ''; let submitting = false;
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (submitting) return;
        const action = actionInput.value; const matchType = matchInput.value; const pattern = patternInput.value.trim().toLowerCase();
        if (!pattern) { formStatus.className = 'sender-rule-status error'; formStatus.textContent = '请输入邮箱地址或域名。'; patternInput.focus(); return; }
        if (matchType === 'address' && (pattern.split('@').length !== 2 || /[\s<>*?]/.test(pattern) || pattern.startsWith('@') || pattern.endsWith('@'))) {
          formStatus.className = 'sender-rule-status error'; formStatus.textContent = '请输入完整邮箱地址，不支持空格或通配符。'; patternInput.focus(); return;
        }
        if (matchType === 'domain' && (/[\s@/*?\\]/.test(pattern) || pattern.startsWith('.') || pattern.endsWith('.') || pattern.includes('..'))) {
          formStatus.className = 'sender-rule-status error'; formStatus.textContent = '请输入不带 @、路径或通配符的完整域名。'; patternInput.focus(); return;
        }
        patternInput.value = pattern;
        const payloadKey = JSON.stringify({ action, matchType, pattern });
        if (payloadKey !== lastPayloadKey) { lastPayloadKey = payloadKey; lastOperationId = crypto.randomUUID(); }
        const body = { action, matchType, pattern, actorId: 'dashboard-user', operationId: lastOperationId };
        submitting = true; formStatus.className = 'sender-rule-status'; formStatus.textContent = '正在保存规则…';
        for (const control of [actionInput, matchInput, patternInput, submitButton]) control.disabled = true;
        try {
          await api('/mail/sender-rules', { method: 'PUT', body: JSON.stringify(body) });
          patternInput.value = ''; lastPayloadKey = ''; lastOperationId = '';
          formStatus.className = 'sender-rule-status success'; formStatus.textContent = '规则已添加。';
          showNotice('发件人规则已添加。'); await refreshRules();
        } catch (error) {
          formStatus.className = 'sender-rule-status error'; formStatus.textContent = `添加规则失败：${error.message}`;
        } finally {
          submitting = false;
          for (const control of [actionInput, matchInput, patternInput, submitButton]) control.disabled = false;
        }
      });

      await refreshRules();
    },
    async account({ content, pageIntro }) {
      content.replaceChildren();
      pageIntro('账户与密码', '修改当前 SC Mail Dashboard 账户密码。修改成功后需要重新登录。');
      const accountCard = card('当前账户');
      append(accountCard, detailMeta([
        ['登录邮箱', state.user?.email || '—'],
        ['账户状态', state.user?.mustChangePassword ? '首次登录，必须修改密码' : '正常'],
      ]));
      const form = el('form', 'form-grid');
      const current = field(form, '当前密码', 'currentPassword', { type: 'password', required: true, wide: true });
      const next = field(form, '新密码', 'newPassword', { type: 'password', required: true, wide: true, placeholder: '至少 8 个字符' });
      const confirm = field(form, '确认新密码', 'confirmPassword', { type: 'password', required: true, wide: true });
      const actions = el('div', 'form-actions wide'); const save = button('修改密码', () => {}, 'button primary'); save.type = 'submit'; actions.append(save); form.append(actions);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (next.value !== confirm.value) { showNotice('两次输入的新密码不一致', true); return; }
        if (next.value.length < 8) { showNotice('新密码至少需要 8 个字符', true); return; }
        save.disabled = true; save.textContent = '修改中…';
        try { await authApi('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: current.value, newPassword: next.value }) }); showNotice('密码已修改，请重新登录'); setTimeout(logout, 700); }
        catch (error) { showNotice(error.message, true); }
        finally { save.disabled = false; save.textContent = '修改密码'; }
      });
      accountCard.append(form);
      const note = card('登录说明', 'Dashboard 使用 HttpOnly 会话 Cookie 保存登录状态，不会把密码或会话令牌写入 localStorage。');
      content.append(accountCard, note);
    },
    async settings({ content, api, pageIntro }) {
      const [integrations, sync, reconciliation, initial] = await Promise.all([api('/mail/integrations/status'), api('/mail/sync/status'), api('/mail/reconciliation/status'), api('/mail/sync/initial')]);
      setTimezone(integrations.dailyBrief?.timezone);
      content.replaceChildren(); pageIntro('系统状态', '只显示连接状态和运行指标。敏感凭据不会通过此页面返回。');
      const cards = [
        ['Agent 与通知', integrations], ['实时同步', sync], ['历史同步', initial], ['邮件对账', reconciliation],
      ];
      const grid = el('div', 'grid equal');
      for (const [title, value] of cards) { const box = card(title); renderSettings(box, value); grid.append(box); }
      content.append(grid, el('p', 'small-text', '修改服务器环境变量请在部署机的 .env 中进行，再按项目部署方式重启服务。Dashboard 不读取或显示 .env 内容。'));
    },
  };

  function reviewReason(code) {
    return ({ FACT_REANALYSIS_REVIEW_REQUIRED: '重分析事项需要确认是否重复', CLASSIFICATION_UNCERTAIN: '邮件分类不确定', AI_CLASSIFICATION_DISAGREEMENT: 'AI 分类意见不一致', PROJECT_UNRESOLVED: '无法匹配项目', PROJECT_AMBIGUOUS: '项目匹配有歧义', PROJECT_ANALYSIS_UNCERTAIN: '项目归属待确认', PROJECT_ANALYSIS_MULTI_PROJECT: '多个项目候选待确认', PROJECT_ANALYSIS_NEW_OPPORTUNITY: '新合作机会待确认', TOPIC_UNRESOLVED: '无法匹配 Topic', CONTACT_PROVISIONAL: '联系人待确认', CONTACT_AMBIGUOUS: '联系人匹配有歧义' })[code] || code || '待复核';
  }
  function settingLabel(key) { return SETTING_LABELS[key] || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' '); }
  function settingValue(key, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (Array.isArray(value)) return value.map(entry => SETTING_VALUES[entry] || LABELS[entry] || String(entry)).join('、') || '无';
    if (/At$/.test(key) && typeof value === 'string') return formatDate(value);
    if (key === 'status') return LABELS[value] || SETTING_VALUES[value] || String(value);
    if (typeof value === 'string') return SETTING_VALUES[value] || LABELS[value] || value;
    return String(value);
  }
  function renderSettings(container, data) {
    const addRecord = (parent, object, title = '') => {
      const record = el('div', title ? 'status-record' : 'status-root');
      if (title) record.append(el('h3', '', title));
      for (const [key, value] of Object.entries(object || {})) {
        if (/token|password|secret|api.?key|recipient/i.test(key)) continue;
        const label = settingLabel(key);
        if (Array.isArray(value)) {
          const group = el('section', 'status-group'); group.append(el('h3', '', label));
          if (!value.length) group.append(el('p', 'small-text', '无记录'));
          value.slice(0, 30).forEach((entry, index) => {
            if (entry && typeof entry === 'object') {
              const name = entry.mailbox || entry.eventType || LABELS[entry.status] || `${label} ${index + 1}`;
              addRecord(group, entry, String(name));
            } else group.append(el('p', 'small-text', settingValue(key, entry)));
          });
          record.append(group);
        } else if (value && typeof value === 'object') {
          const group = el('section', 'status-group'); group.append(el('h3', '', label)); addRecord(group, value); record.append(group);
        } else {
          const row = el('div', 'status-item'); append(row, el('span', 'status-label', label), el('strong', 'status-value', settingValue(key, value))); record.append(row);
        }
      }
      parent.append(record);
    };
    addRecord(container, data);
  }
  function topicFields() {
    return [{ name: 'name', label: 'Topic 名称', required: true }, { name: 'type', label: 'Topic 类型', options: [['custom', '自定义'], ['design', '设计'], ['quotation', '报价'], ['technical', '技术'], ['logistics', '物流'], ['contract', '合同']] }, { name: 'description', label: '说明', type: 'textarea', wide: true }];
  }
  function createTopicDialog(projectId, reviewId) {
    let createdTopic = null;
    let createdPayload = '';
    const resolveOperationId = crypto.randomUUID();
    formDialog(reviewId ? '新建 Topic 并分配' : '新建 Topic', reviewId ? '创建 Topic 后，将当前复核邮件分配到该 Topic。' : '为项目创建可用于邮件归属的 Topic。', topicFields(), async (payload, operationId) => {
      if (createdTopic && createdPayload !== JSON.stringify(payload)) throw new Error('Topic 已创建。请关闭表单后重新打开复核，选择刚创建的 Topic。');
      if (!createdTopic) {
        createdTopic = await api(`/mail/projects/${encodeURIComponent(projectId)}/topics`, { method: 'POST', body: JSON.stringify({ ...payload, actorId: 'dashboard-user', operationId }) });
        createdPayload = JSON.stringify(payload);
      }
      if (reviewId) await api(`/mail/reviews/${encodeURIComponent(reviewId)}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'assign_topic', topicId: createdTopic.id, actorId: 'dashboard-user', operationId: resolveOperationId }) });
    }, reviewId ? undefined : () => openProject(projectId));
  }
  function businessDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: state.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const values = Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
  function isBusinessDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }
  function shiftDate(value, days) {
    const [year, month, day] = value.split('-').map(Number); const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }
  function projectAnalysisDialog(projectId, afterSave) {
    const today = businessDateParts(); const fromDefault = shiftDate(today, -180);
    managedFormDialog('分析项目邮件', '选择联系人往来的日期范围。默认最近 180 天，结束日期包含当天；候选数量和实际进度会在任务创建后显示。', form => {
      const from = inputField(form, '开始日期（包含）', 'from', { type: 'date', value: fromDefault, required: true });
      const through = inputField(form, '结束日期（包含）', 'through', { type: 'date', value: today, required: true });
      const limit = inputField(form, '最多候选邮件', 'limit', { type: 'number', value: '500', required: true, hint: '每次最多 500 封；超出范围可分段分析。' }); limit.min = '1'; limit.max = '500';
      return { read: () => {
        if (!from.value || !through.value || from.value > through.value) throw new Error('请设置有效的日期范围，结束日期不能早于开始日期。');
        const number = Number(limit.value); if (!Number.isInteger(number) || number < 1 || number > 500) throw new Error('候选邮件数量必须在 1 到 500 之间。');
        return { from: from.value, to: through.value, limit: number };
      } };
    }, (payload, operationId) => api(`/mail/projects/${encodeURIComponent(projectId)}/analysis`, {
      method: 'POST', body: JSON.stringify({ ...payload, operationId }),
    }), afterSave || (() => openProject(projectId, 0, {}, 'analysis')));
  }
  async function readProjectAnalysisJob(request, jobId, includeAll = true) {
    const path = `/mail/project-analysis/${encodeURIComponent(jobId)}`;
    const first = await request.api(`${path}?limit=100&offset=0`); const job = first.job || first;
    const items = [...(first.items || [])]; const total = first.totalItems ?? job.totalItems ?? items.length;
    if (!includeAll) return { job, items, totalItems: total };
    for (let offset = items.length; offset < total; offset += 100) {
      const page = await request.api(`${path}?limit=100&offset=${offset}`); items.push(...(page.items || []));
      if (!page.items?.length) break;
    }
    return { job, items, totalItems: total };
  }
  function summaryCoverageLabel(value) {
    let coverage = value;
    if (typeof coverage === 'string') {
      try { coverage = JSON.parse(coverage); } catch { return coverage; }
    }
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return '覆盖范围已记录';
    const parts = [];
    if (Number.isFinite(coverage.includedCount) && Number.isFinite(coverage.totalProjectMessageCount)) parts.push(`邮件 ${coverage.includedCount}/${coverage.totalProjectMessageCount} 封`);
    else if (Number.isFinite(coverage.includedCount)) parts.push(`纳入 ${coverage.includedCount} 封邮件`);
    if (Number.isFinite(coverage.omittedCount) && coverage.omittedCount > 0) parts.push(`另有 ${coverage.omittedCount} 封未纳入`);
    if (coverage.contextTruncated) parts.push('部分正文已截短');
    if (coverage.stale) parts.push('覆盖范围已过期');
    return parts.join('，') || '覆盖范围已记录';
  }
  function evidenceEntries(value) {
    if (typeof value === 'string') {
      try { return evidenceEntries(JSON.parse(value)); } catch { return []; }
    }
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value.evidence)) return value.evidence;
    if (value.source_message_id || value.sourceMessageId || value.messageId || value.sourceId) return [value];
    const ids = value.sourceMessageIds || value.sourceIds;
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string').map(sourceMessageId => ({ sourceMessageId })) : [];
  }
  function appendEvidence(container, value, { sourceDeleted = false } = {}) {
    const entries = evidenceEntries(value);
    if (typeof value === 'string' && !entries.length && value.trim() && !/^\s*[\[{]/.test(value)) container.append(el('p', 'small-text', value));
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.reason === 'string') container.append(el('p', 'small-text', value.reason));
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const excerpt = typeof entry.excerpt === 'string' ? entry.excerpt : typeof entry.text === 'string' ? entry.text : '';
      const sourceId = entry.source_message_id || entry.sourceMessageId || entry.messageId || entry.sourceId;
      const deleted = sourceDeleted || Boolean(entry.sourceDeletedAt || entry.isSourceDeleted);
      const row = el('div', 'assignment-evidence-source');
      if (excerpt) row.append(el('blockquote', 'review-evidence', excerpt));
      if (sourceId || deleted) row.append(sourceEmailButton(sourceId, deleted));
      if (row.childElementCount) container.append(row);
    }
  }
  function analysisItemDescription(item) {
    return [item.reason, item.errorCode && `错误：${item.errorCode}`].filter(value => typeof value === 'string' && value.trim()).join(' · ');
  }
  function analysisProjectCell(item) {
    const candidates = Array.isArray(item.candidateProjects) ? item.candidateProjects : [];
    const chosenId = item.projectId || item.chosenProject?.id || null;
    const chosen = item.chosenProject?.name ? item.chosenProject : candidates.find(project => project?.id === chosenId);
    const others = candidates.filter(project => project?.name && project.id !== (chosen?.id || chosenId)).map(project => project.name);
    const cell = el('div', 'analysis-projects');
    if (chosen?.name) cell.append(el('p', '', `已归属：${chosen.name}`));
    else if (chosenId && item.outcome === 'assigned') cell.append(el('p', '', '已归入项目'));
    const candidateNames = candidates.filter(project => project?.name).map(project => project.name);
    if (others.length) cell.append(el('p', 'small-text', `其他候选：${others.join('、')}`));
    else if (!chosen && candidateNames.length) cell.append(el('p', 'small-text', `候选项目：${candidateNames.join('、')}`));
    else if (!chosen && item.candidateProjectIds?.length) cell.append(el('p', 'small-text', `候选项目 ${item.candidateProjectIds.length} 个`));
    else if (!chosen && item.outcome === 'non_project') cell.append(el('p', 'small-text', '未归入项目'));
    if (!cell.childElementCount) cell.append(el('span', 'small-text', '—'));
    return cell;
  }
  function analysisEvidenceCell(item, { collapsible = false } = {}) {
    const cell = el('div', 'analysis-evidence-cell');
    const description = analysisItemDescription(item);
    const deleted = Boolean(item.sourceDeletedAt || item.isSourceDeleted);
    const entries = evidenceEntries(item.evidence);
    if (collapsible && (description || entries.length || typeof item.evidence === 'string')) {
      if (deleted) cell.append(el('p', 'small-text', '来源邮件已删除'));
      else if (item.errorCode) cell.append(el('p', 'small-text', '需要复核'));
      const details = el('details', 'analysis-evidence-details');
      details.append(el('summary', '', '查看判断依据'));
      if (description) details.append(el('p', 'small-text', description));
      appendEvidence(details, item.evidence, { sourceDeleted: deleted });
      cell.append(details);
    } else {
      if (description) cell.append(el('p', 'small-text', description));
      appendEvidence(cell, item.evidence, { sourceDeleted: deleted });
    }
    if (deleted && !cell.querySelector('button')) cell.append(sourceEmailButton(null, true));
    return cell;
  }
  function summaryStatusLabel(status) {
    return ({ pending: '等待更新', processing: '生成中', completed: '已更新', failed: '更新失败', not_requested: '未请求更新' })[status] || status || '—';
  }
  function analysisCounts(job) {
    const counts = job.counts || job;
    return [
      ['候选', counts.candidateCount], ['已处理', counts.processedCount], ['已归类', counts.assignedCount],
      ['非项目', counts.nonProjectCount], ['新机会', counts.newOpportunityCount], ['待确认', counts.needsReviewCount], ['失败', counts.failedCount],
    ].filter(([, value]) => value !== undefined && value !== null);
  }
  function appendAnalysisJob(section, job, items, projectId, request, totalItems, messageOffset, filters, selectedTab = 'analysis') {
    section.replaceChildren();
    const statusLabel = ({ pending: '排队中', queued: '排队中', processing: '处理中', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' })[job.status] || job.status || '未知';
    section.append(el('h3', '', `最近分析 · ${statusLabel}`));
    const range = job.range || {}; const rangeFrom = range.from || job.from; const rangeThrough = range.through || job.through || job.to;
    const endDate = rangeThrough && (typeof rangeThrough === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rangeThrough) ? rangeThrough : new Date(new Date(rangeThrough).getTime() - 1));
    const rangeText = [rangeFrom && formatDate(rangeFrom, false), endDate && `至 ${formatDate(endDate, false)}`].filter(Boolean).join(' ');
    const meta = detailMeta([['分析范围', rangeText || '—'], ['摘要状态', summaryStatusLabel(job.summaryStatus)], ['开始时间', formatDate(job.createdAt)], ['完成时间', formatDate(job.completedAt)]]);
    section.append(meta);
    const chips = el('div', 'analysis-counts');
    for (const [label, value] of analysisCounts(job)) { const item = el('div', 'analysis-count'); append(item, el('span', '', label), el('strong', '', value)); chips.append(item); }
    section.append(chips);
    const errors = [(job.errorCode || job.lastErrorCode) && `最近错误：${job.errorCode || job.lastErrorCode}`, job.summaryErrorCode && `摘要错误：${job.summaryErrorCode}`].filter(Boolean);
    if (errors.length) section.append(el('p', 'error', errors.join(' · ')));
    if (job.summaryStatus === 'failed') section.append(el('p', 'small-text', '归类与摘要分别处理；当前摘要未完成，可重试摘要。'));
    const active = ['pending', 'processing'].includes(job.status);
    const actions = el('div', 'action-row');
    if (active) actions.append(button('取消未开始部分', () => requestInlineConfirmation(
      actions, '取消后将停止尚未领取的邮件；已完成的结果会保留。', '确认取消分析',
      () => mutateAnalysisJob(job.id || job.jobId, 'cancel', projectId, messageOffset, filters),
      'analysis-cancel-confirmation', '确认取消项目分析',
    ), 'button danger small'));
    const failedItems = (job.failedCount ?? job.counts?.failedCount ?? 0) > 0;
    const failedSummary = job.summaryStatus === 'failed';
    if (['partial', 'failed'].includes(job.status) && (failedItems || failedSummary)) actions.append(button(failedItems && failedSummary ? '重试失败项与摘要' : failedSummary ? '重试项目摘要' : '重试失败项', () => mutateAnalysisJob(job.jobId || job.id, 'retry', projectId, messageOffset, filters), 'button secondary small'));
    if (actions.childElementCount) section.append(actions);
    if (!items.length) { section.append(empty(totalItems ? '任务还没有可显示的分析结果。' : '此任务没有候选邮件。')); return; }
    section.append(el('h3', '', `归类结果与依据 · 已显示 ${items.length} / ${totalItems}`));
    if (items.length < totalItems) section.append(el('p', 'small-text', '任务运行期间暂显示首 100 条结果；完成后会载入完整结果列表。'));
    const rows = items.map(item => ({ ...item, _item: item }));
    section.append(table(['邮件主题', '判断', '归属与候选', '依据 / 状态', '操作'], rows, item => {
      const deleted = Boolean(item.sourceDeletedAt || item.isSourceDeleted);
      const title = item.subject || '(无主题)';
      const open = button(deleted ? `${title} · 来源已删除` : title, () => openEmail(item.messageId), 'button ghost small'); open.disabled = deleted;
      const assignment = button('人工确定', () => openManualAssignment(item.messageId, () => openProject(projectId, messageOffset, filters, selectedTab)), 'button secondary small'); assignment.disabled = deleted;
      return [open, badge(outcomeLabel(item.outcome || item.status)), analysisProjectCell(item), analysisEvidenceCell(item, { collapsible: true }), append(el('div', 'action-row'), assignment)];
    }));
  }
  async function mutateAnalysisJob(jobId, action, projectId, offset, filters, selectedTab = 'analysis') {
    try {
      await api(`/mail/project-analysis/${encodeURIComponent(jobId)}/${action}`, { method: 'POST', body: JSON.stringify({ operationId: crypto.randomUUID() }) });
      await openProject(projectId, offset, filters, selectedTab);
    } catch (error) { showNotice(error.message, true); }
  }
  async function adoptSummarySuggestion(projectId, summaryId, summaryVersion, suggestion, offset, filters, control, selectedTab = 'analysis') {
    if (!summaryId || !Number.isInteger(summaryVersion) || !Number.isInteger(suggestion?.version)) {
      showNotice('摘要建议缺少版本信息，无法安全采用。', true); return;
    }
    const operationId = control.dataset.operationId || crypto.randomUUID(); control.dataset.operationId = operationId;
    control.disabled = true; control.textContent = '采用中…';
    try {
      await api('/mail/summaries/rollback', { method: 'POST', body: JSON.stringify({
        operationId, summaryId, expectedVersion: summaryVersion, targetVersion: suggestion.version,
      }) });
      await openProject(projectId, offset, filters, selectedTab); showNotice('已采用摘要建议并保存新版本。');
    } catch (error) { showNotice(error.message, true); }
    finally { if (control.isConnected) { control.disabled = false; control.textContent = '采用此建议'; } }
  }
  async function openProject(id, messageOffset = 0, filters = {}, selectedTab = 'overview') {
    const request = showDialog('项目详情', 'PROJECT');
    dialog.classList.add('project-detail-dialog');
    dialogContent.append(el('div', 'loading', '正在加载项目资料与邮件…'));
    try {
      const params = { limit: 20, offset: messageOffset, contactId: filters.contactId, fromDate: filters.fromDate, throughDate: filters.throughDate, direction: filters.direction };
      const [projectResult, summary, timeline, messagePage, analysisResult] = await Promise.all([
        request.api(`/mail/projects/${encodeURIComponent(id)}`),
        request.api(`/mail/projects/${encodeURIComponent(id)}/summary`),
        request.api(`/mail/projects/${encodeURIComponent(id)}/timeline?limit=15&offset=0`),
        request.api(`/mail/projects/${encodeURIComponent(id)}/messages?${query(params)}`),
        request.api(`/mail/projects/${encodeURIComponent(id)}/analysis`),
      ]);
      const project = projectResult.project || projectResult;
      dialogContent.replaceChildren();
      const companyId = project.company?.id || project.companyId;
      const projectContacts = (project.projectContacts || []).map(row => row.contact).filter(Boolean);
      const header = el('header', 'project-detail-header');
      const titleBlock = el('div', 'project-detail-title');
      titleBlock.append(el('h2', '', project.name));
      const projectActions = el('div', 'project-header-actions');
      const companyButton = button(project.company?.name || '查看所属公司', () => companyId && openCompany(companyId), 'button ghost small');
      companyButton.disabled = !companyId;
      append(projectActions, companyButton, button('编辑项目', () => projectEditor(project, () => openProject(id, messageOffset, filters, activeTab)), 'button secondary small'));
      header.append(titleBlock, projectActions);
      dialogContent.append(header, detailMeta([
        ['生命周期', lifecycleLabel(project)], ['阶段', LABELS[project.stage] || project.stage],
        ['项目邮件', messagePage.total ?? 0], ['更新时间', formatDate(project.updatedAt)],
      ]));

      const tabList = el('div', 'project-tabs');
      tabList.setAttribute('role', 'tablist'); tabList.setAttribute('aria-label', '项目详情分区');
      const workspace = el('div', 'project-workspace');
      const main = el('div', 'project-workspace-main');
      const overviewPanel = el('section', 'project-tabpanel project-overview-panel');
      const mailPanel = el('section', 'project-tabpanel project-mail-panel');
      const analysisPanel = el('section', 'project-tabpanel project-analysis-panel');
      const tabDefinitions = [['overview', '概览', overviewPanel], ['mail', '邮件往来', mailPanel], ['analysis', '分析记录', analysisPanel]];
      let activeTab = tabDefinitions.some(([key]) => key === selectedTab) ? selectedTab : 'overview';
      const tabButtons = new Map();
      for (const [key, label, panel] of tabDefinitions) {
        const tab = button(label, () => activateTab(key), 'project-tab');
        tab.id = `project-tab-${key}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `project-panel-${key}`);
        panel.id = `project-panel-${key}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
        tabButtons.set(key, tab); tabList.append(tab); main.append(panel);
      }
      const aside = el('aside', 'project-sidebar');
      const activateTab = (key, focus = false) => {
        activeTab = key;
        dialog.dataset.activeProjectTab = key;
        for (const [tabKey, , panel] of tabDefinitions) {
          const tab = tabButtons.get(tabKey); const selected = tabKey === key;
          tab.setAttribute('aria-selected', selected ? 'true' : 'false'); tab.tabIndex = selected ? 0 : -1;
          tab.classList.toggle('active', selected); panel.hidden = !selected;
        }
        const overview = key === 'overview'; aside.hidden = !overview;
        main.classList.toggle('project-workspace-main-wide', !overview);
        if (focus) tabButtons.get(key)?.focus();
      };
      tabList.addEventListener('keydown', event => {
        const keys = tabDefinitions.map(([key]) => key); const current = keys.indexOf(activeTab); let next = current;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % keys.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current + keys.length - 1) % keys.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = keys.length - 1;
        else return;
        event.preventDefault(); activateTab(keys[next], true);
      });
      const companyCard = card('所属公司');
      append(companyCard, button(project.company?.name || '查看所属公司', () => companyId && openCompany(companyId), 'button ghost small'));
      const website = safeWebsite(project.company?.website);
      if (website) {
        const link = el('a', '', project.company.website); link.href = website; link.target = '_blank'; link.rel = 'noopener noreferrer';
        companyCard.append(el('p', 'project-sidebar-copy', '官网：'), link);
      }
      for (const value of [project.company?.address, project.company?.notes].filter(Boolean)) companyCard.append(el('p', 'project-sidebar-copy', value));
      aside.append(companyCard);
      const contactCard = card(`项目联系人 · ${projectContacts.length}`);
      if (projectContacts.length) {
        const members = el('div', 'project-members');
        for (const row of project.projectContacts || []) {
          const contact = row.contact; if (!contact) continue;
          const item = el('div', 'list-row'); const member = el('div', 'list-main');
          append(member, button(`${contact.displayName}${row.isPrimary ? ' · 主对接人' : ''}`, () => openContact(contact.id), 'button ghost small'));
          const details = [emailValues(contact).join(', ') || '未登记邮箱', contact.notes].filter(Boolean).join(' · ');
          if (details) member.append(el('p', '', details));
          item.append(member); members.append(item);
        }
        contactCard.append(members);
      } else contactCard.append(empty('此项目尚未设置对接人。'));
      aside.append(contactCard);
      workspace.append(main, aside);
      dialogContent.append(tabList, workspace);

      const summaryVersion = summary?.versions?.find(version => version.id === summary.currentVersionId) || null;
      const summaryRecord = summaryVersion || summary?.current || summary?.summaryVersion || summary;
      const summaryText = typeof summary?.summary === 'string' ? summary.summary : summaryRecord?.newSummary || summaryRecord?.summaryText || '';
      if (project.description) overviewPanel.append(card('项目说明', project.description));
      const summaryBox = card('项目进度总结');
      if (summaryText) summaryBox.append(el('p', 'notice-inline', summaryText));
      else summaryBox.append(empty('暂无项目总结。可在分析记录中选择范围，根据已归属本项目的邮件生成有来源的总结。'));
      const staleSummary = summary?.stale === true || summary?.isOutdated === true || summary?.isStale === true || summary?.outOfDate === true || summary?.refreshStatus === 'pending' || project.summaryOutdated === true;
      if (staleSummary) summaryBox.append(el('p', 'notice-inline warning', '项目邮件或归属已变化；当前总结需要更新。'));
      const summaryCoverage = summary?.coverage || summary?.coverageJson || summaryRecord?.coverage;
      const summaryMeta = [summaryRecord?.createdAt || summaryRecord?.updatedAt ? `更新时间：${formatDate(summaryRecord.createdAt || summaryRecord.updatedAt)}` : null, summary?.manualOverride && '当前总结由人工维护，自动分析不会覆盖', summary?.isDerived && '由邮件分析生成', summaryCoverage && `覆盖范围：${summaryCoverageLabel(summaryCoverage)}`].filter(Boolean);
      if (summaryMeta.length) summaryBox.append(el('p', 'small-text', summaryMeta.join(' · ')));
      if (summaryRecord?.triggerMessageId) summaryBox.append(sourceEmailButton(summaryRecord.triggerMessageId, Boolean(summaryRecord.sourceDeletedAt), '查看总结来源邮件'));
      overviewPanel.append(summaryBox);

      const activeTasks = (project.tasks || []).filter(task => ['open', 'in_progress', 'waiting'].includes(task.status));
      const taskBox = card(`开放待办与等待事项 · ${activeTasks.length}`);
      if (activeTasks.length) taskBox.append(table(['事项', '状态', '负责人', '等待方', '期限'], activeTasks, task => [button(task.title, () => openTask(task.id), 'button ghost small'), statusBadge(task.status), cellText(LABELS[task.ownerType] || task.ownerType || '—'), cellText(LABELS[task.waitingOn] || task.waitingOn || '—'), cellText(task.deadlineAt ? formatDate(task.deadlineAt) : task.deadlineDate || '—')]));
      else taskBox.append(empty('没有开放待办或等待事项。'));
      overviewPanel.append(taskBox);

      const topicBox = card('项目 Topic');
      topicBox.firstElementChild.append(button('新建 Topic', () => createTopicDialog(id), 'button secondary small'));
      topicBox.append(table(['名称', '类型', '状态'], project.topics || [], topic => [cellText(topic.name), cellText(topic.type), cellText(topic.status === 'active' ? '启用' : topic.status)]));
      overviewPanel.append(topicBox);

      for (const [title, facts] of [['需求', project.requirements], ['决策', project.decisions]]) {
        if (!Array.isArray(facts) || !facts.length) continue;
        const factBox = card(`${title} · ${facts.length}`); const list = el('div', 'project-facts');
        for (const fact of facts) {
          const row = el('div', 'list-row'); const item = el('div', 'list-main');
          append(item, el('strong', '', fact.title || fact.description || fact.statement || fact.status || title));
          if (fact.description && fact.title) item.append(el('p', '', fact.description));
          const source = fact.sourceMessage?.id || fact.sourceMessageId;
          if (source) item.append(sourceEmailButton(source, Boolean(fact.sourceDeletedAt), '查看来源邮件'));
          append(row, item, el('span', 'list-meta', LABELS[fact.status] || fact.status || '')); list.append(row);
        }
        factBox.append(list); overviewPanel.append(factBox);
      }

      const timelineBox = card(`最近动态 · ${(timeline.events || []).length}`);
      const recent = el('details', 'project-timeline-details'); recent.append(el('summary', '', '查看最近动态'));
      for (const event of (timeline.events || []).slice(0, 8)) {
        const row = el('div', 'list-row'); const item = el('div', 'list-main');
        append(item, el('strong', '', event.title || event.eventType), el('p', '', event.sourceDeletedAt ? '来源邮件已删除' : event.sourceMessage?.subject || event.description || event.eventType));
        if (event.sourceMessage?.id) item.append(sourceEmailButton(event.sourceMessage.id, Boolean(event.sourceDeletedAt), '查看来源邮件'));
        append(row, item, el('span', 'list-meta', formatDate(event.createdAt))); recent.append(row);
      }
      if (!timeline.events?.length) recent.append(el('p', 'small-text', '暂无时间线事件.'));
      timelineBox.append(recent); overviewPanel.append(timelineBox);

      const mailHeading = el('div', 'section-head');
      append(mailHeading, el('h3', '', `项目邮件往来 · ${messagePage.total ?? 0}`), freshnessNote(messagePage) ? el('p', '', freshnessNote(messagePage)) : el('span'));
      mailPanel.append(mailHeading);
      const toolbar = el('div', 'toolbar project-mail-toolbar');
      const contactSelect = optionSelect([['', '所有项目联系人'], ...projectContacts.map(contact => [contact.id, contact.displayName])], filters.contactId || '');
      const fromDate = el('input'); fromDate.type = 'date'; fromDate.setAttribute('aria-label', '邮件开始日期'); fromDate.value = filters.fromDate || '';
      const throughDate = el('input'); throughDate.type = 'date'; throughDate.setAttribute('aria-label', '邮件结束日期'); throughDate.value = filters.throughDate || '';
      const direction = optionSelect([['', '收件与发件'], ['inbound', '收到'], ['outbound', '发出']], filters.direction || '');
      const currentFilters = () => ({ contactId: contactSelect.value, fromDate: fromDate.value, throughDate: throughDate.value, direction: direction.value });
      append(toolbar, contactSelect, fromDate, throughDate, direction, button('筛选邮件', () => openProject(id, 0, currentFilters(), 'mail'), 'button secondary small'));
      mailPanel.append(toolbar);
      const mailBox = el('div', 'project-mail-results'); const messageRows = messagePage.messages || [];
      mailBox.append(table(['主题', '方向', '参与人', '归类依据', '时间', '操作'], messageRows, message => {
        const override = message.projectManualOverride ? ' · 人工锁定' : '';
        const reason = typeof message.projectReason === 'string' ? message.projectReason : message.projectResolutionStatus ? outcomeLabel(message.projectResolutionStatus) : '已归入项目';
        const reasonCell = analysisEvidenceCell({ reason: `${reason}${override}`, evidence: message.projectResolutionEvidence, sourceDeletedAt: message.projectEvidenceSourceDeleted || message.sourceDeletedAt, isSourceDeleted: message.isSourceDeleted }, { collapsible: true });
        const assign = button('调整归属', () => openManualAssignment(message.id, () => openProject(id, messageOffset, currentFilters(), 'mail')), 'button secondary small');
        const participants = [message.contact?.displayName || message.contactName, participantSummary(message)].filter(Boolean).join(' · ');
        return [cellText(message.subject || '(无主题)', 'cell-title'), cellText(message.direction === 'inbound' ? '收到' : '发出'), cellText(participants || '—'), reasonCell, cellText(formatDate(message.direction === 'outbound' ? message.sentAt || message.receivedAt : message.receivedAt || message.sentAt)), assign];
      }, { click: message => openEmail(message.id) }));
      if (!messageRows.length) mailBox.append(empty('此范围没有已归入项目的邮件。'));
      mailBox.append(pagination(messagePage.total || 0, 20, messageOffset, next => openProject(id, next, currentFilters(), 'mail')));
      mailPanel.append(mailBox);

      const analysisIntro = card('项目分析记录');
      const analysisHeader = analysisIntro.firstElementChild;
      analysisHeader.classList.add('project-analysis-heading');
      analysisHeader.append(button('分析邮件', () => projectAnalysisDialog(id, () => openProject(id, messageOffset, filters, 'analysis')), 'button primary small'));
      append(analysisIntro, analysisHeader, el('p', 'small-text', '只分析已登记项目联系人往来的所选时间范围；历史批次不产生来信通知。分析会保留项目候选、非项目交流、新合作机会与待确认判断。'));
      const suggestions = (summary?.versions || []).filter(version => version.isSuggestion).sort((a, b) => b.version - a.version);
      if (suggestions.length) {
        const suggestionList = el('div', 'project-suggestions');
        for (const suggestion of suggestions.slice(0, 5)) {
          const suggestionBox = el('section', 'summary-suggestion');
          append(suggestionBox, el('h3', '', `AI 建议总结 · 版本 ${suggestion.version}`), el('p', 'notice-inline', suggestion.newSummary || ''));
          const suggestionMeta = [suggestion.createdAt && `生成时间：${formatDate(suggestion.createdAt)}`, suggestion.model, suggestion.confidence !== null && suggestion.confidence !== undefined && `置信度 ${suggestion.confidence}`, suggestion.sourceDeletedAt && '来源邮件已删除', suggestion.coverage && `覆盖范围：${summaryCoverageLabel(suggestion.coverage)}`].filter(Boolean);
          if (suggestionMeta.length) suggestionBox.append(el('p', 'small-text', suggestionMeta.join(' · ')));
          if (suggestion.triggerMessageId) suggestionBox.append(sourceEmailButton(suggestion.triggerMessageId, Boolean(suggestion.sourceDeletedAt), '查看建议来源邮件'));
          const alreadyCurrent = summaryText === suggestion.newSummary; const staleSuggestion = summary?.stale === true || summary?.coverage?.stale === true;
          const unavailable = !summary?.summaryId || !Number.isInteger(summary.version) || !Number.isInteger(suggestion.version) || Boolean(suggestion.sourceDeletedAt) || alreadyCurrent || staleSuggestion;
          const adopt = button(alreadyCurrent ? '此建议已采用' : '采用此建议', () => adoptSummarySuggestion(id, summary.summaryId, summary.version, suggestion, messageOffset, filters, adopt, activeTab), 'button primary small');
          adopt.disabled = unavailable;
          if (!summary?.summaryId) adopt.title = '服务端未返回摘要记录 ID';
          if (suggestion.sourceDeletedAt) adopt.title = '来源邮件已删除，不能采用此建议';
          if (staleSuggestion) adopt.title = '摘要覆盖范围已过期，请先重新分析';
          suggestionBox.append(adopt); suggestionList.append(suggestionBox);
        }
        analysisIntro.append(suggestionList);
      }
      const analysisContent = el('section', 'analysis-section project-analysis-job');
      const job = analysisResult?.job || null;
      if (!job) analysisContent.append(empty('尚无分析任务。'));
      else {
        const jobId = job.jobId || job.id;
        try {
          const startedActive = ['pending', 'processing'].includes(job.status);
          const details = await readProjectAnalysisJob(request, jobId, !startedActive);
          if (startedActive && !['pending', 'processing'].includes(details.job.status)) { await openProject(id, messageOffset, filters, activeTab); return; }
          appendAnalysisJob(analysisContent, details.job, details.items, id, request, details.totalItems, messageOffset, filters, 'analysis');
          if (['pending', 'processing'].includes(details.job.status) && request.active) {
            const refresh = async () => {
              if (!request.active || !dialog.open) return;
              try {
                const next = await readProjectAnalysisJob(request, jobId, false);
                if (!request.active || !dialog.open) return;
                if (!['pending', 'processing'].includes(next.job.status)) { await openProject(id, messageOffset, filters, activeTab); return; }
                appendAnalysisJob(analysisContent, next.job, next.items, id, request, next.totalItems, messageOffset, filters, 'analysis');
                projectAnalysisTimer = setTimeout(() => void refresh(), 2500);
              } catch (error) { if (request.active) analysisContent.append(el('p', 'error', `刷新分析进度失败：${error.message}`)); }
            };
            projectAnalysisTimer = setTimeout(() => void refresh(), 2500);
          }
        } catch (error) { analysisContent.append(el('p', 'error', `无法读取分析结果：${error.message}`), button('重试读取', () => openProject(id, messageOffset, filters, activeTab), 'button secondary small')); }
      }
      analysisPanel.append(analysisIntro, analysisContent);
      activateTab(activeTab);
    } catch (error) {
      if (request.active) dialogContent.replaceChildren(el('p', 'error', error.message));
    }
  }
  async function openContact(id, offset = 0, filters = {}) {
    const request = showDialog('联系人详情', 'CONTACT'); dialogContent.append(el('div', 'loading', '正在加载联系人资料与往来…'));
    try {
      const [contactResult, data] = await Promise.all([
        request.api(`/mail/crm/contacts/${encodeURIComponent(id)}`),
        request.api(`/mail/crm/contacts/${encodeURIComponent(id)}/messages?${query({ limit: 20, offset, projectId: filters.projectId, fromDate: filters.fromDate, throughDate: filters.throughDate, direction: filters.direction })}`),
      ]);
      const contact = contactResult.contact || contactResult;
      dialogContent.replaceChildren();
      const actions = el('div', 'project-header-actions'); actions.append(button('编辑联系人', () => contactEditor(contact, () => openContact(id, offset, filters)), 'button secondary small'));
      append(dialogContent, el('p', 'eyebrow', contact.company?.name || '未关联公司'), el('h2', '', contact.displayName), actions, detailMeta([
        ['已登记邮箱', emailValues(contact).join(', ') || '—'], ['主邮箱', (contact.emails || []).find(item => item?.isPrimary)?.email || emailValues(contact)[0] || '—'],
        ['公司', contact.company?.name || '—'], ['版本', contact.version ?? contactResult.version ?? '—'],
      ]));
      if (contact.notes) { dialogContent.append(el('h3', '', '备注'), el('p', 'notice-inline', contact.notes)); }
      const toolbar = el('div', 'toolbar');
      const projectFilter = pagedSelect({ path: '/mail/projects', key: 'projects', label: project => project.name, emptyLabel: '所有项目', request });
      await projectFilter.ready;
      if (filters.projectId && ![...projectFilter.select.options].some(option => option.value === filters.projectId)) {
        const project = await request.api(`/mail/projects/${encodeURIComponent(filters.projectId)}`); const option = el('option', '', project.name); option.value = project.id; projectFilter.select.append(option);
      }
      projectFilter.select.value = filters.projectId || '';
      const fromDate = el('input'); fromDate.type = 'date'; fromDate.value = filters.fromDate || ''; fromDate.setAttribute('aria-label', '邮件开始日期');
      const throughDate = el('input'); throughDate.type = 'date'; throughDate.value = filters.throughDate || ''; throughDate.setAttribute('aria-label', '邮件结束日期');
      const direction = optionSelect([['', '收件与发件'], ['inbound', '收到'], ['outbound', '发出']], filters.direction || '');
      append(toolbar, projectFilter.element, fromDate, throughDate, direction, button('筛选往来', () => openContact(id, 0, { projectId: projectFilter.select.value, fromDate: fromDate.value, throughDate: throughDate.value, direction: direction.value }), 'button secondary small'));
      dialogContent.append(toolbar);
      const roleNames = { from: '发件人', to: '收件人', cc: '抄送', bcc: '密送' };
      const box = card(`邮件往来 · ${data.total ?? 0}`, freshnessNote(data) || '显示所有已登记邮箱在受管 IMAP 文件夹中已同步的收件和发件副本。');
      box.append(table(['主题', '方向', '联系人参与方式', '匹配邮箱', '项目', '时间'], data.messages, item => [
        cellText(item.subject || '(无主题)', 'cell-title'), cellText(item.direction === 'inbound' ? '收到' : '发出'),
        cellText((item.participantRoles || []).map(role => roleNames[role] || role).join('、') || '—'), cellText((item.matchedEmails || []).join(', ') || '—'),
        cellText(item.project?.name || '—'), cellText(formatDate(item.direction === 'inbound' ? item.receivedAt || item.sentAt : item.sentAt || item.receivedAt)),
      ], { click: item => openEmail(item.id) }));
      if (!data.messages?.length) box.append(empty('此范围没有与已登记邮箱匹配的往来邮件。'));
      box.append(pagination(data.total || 0, 20, offset, next => openContact(id, next, filters))); dialogContent.append(box);
    } catch (error) { if (request.active) dialogContent.replaceChildren(el('p', 'error', error.message)); }
  }
  async function openCompany(id) {
    const request = showDialog('公司详情', 'COMPANY'); dialogContent.append(el('div', 'loading', '正在加载公司资料…'));
    try {
      const result = await request.api(`/mail/crm/companies/${encodeURIComponent(id)}`); const company = result.company || result;
      const contacts = result.contacts || company.contacts || []; const projects = result.projects || company.projects || [];
      dialogContent.replaceChildren();
      const actions = el('div', 'project-header-actions'); actions.append(button('编辑公司', () => companyEditor({ ...company, contacts }, () => openCompany(id)), 'button secondary small'));
      append(dialogContent, el('p', 'eyebrow', '公司资料'), el('h2', '', company.name), actions, detailMeta([
        ['域名（资料）', company.domain || '—'], ['联系人', contacts.length], ['项目', projects.length], ['版本', company.version ?? result.version ?? '—'],
      ]));
      const website = safeWebsite(company.website);
      const details = el('div', 'company-profile');
      if (website) { const anchor = el('a', '', company.website); anchor.href = website; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; details.append(anchor); }
      else if (company.website) details.append(el('p', 'small-text', `官网地址未显示为链接：${company.website}`));
      if (company.address) details.append(el('p', '', company.address));
      if (company.notes) details.append(el('p', 'notice-inline', company.notes));
      if (details.childElementCount) dialogContent.append(details);
      dialogContent.append(el('h3', '', '公司联系人'));
      if (contacts.length) dialogContent.append(table(['联系人', '邮箱', '备注'], contacts, contact => [button(contact.displayName, () => openContact(contact.id), 'button ghost small'), cellText(emailValues(contact).join(', ') || '—'), cellText(contact.notes || '—')]));
      else dialogContent.append(empty('尚未添加公司联系人。'));
      dialogContent.append(el('h3', '', '公司项目'));
      if (projects.length) dialogContent.append(table(['项目', '生命周期', '阶段', '对接人', '更新时间'], projects, project => [button(project.name, () => openProject(project.id), 'button ghost small'), statusBadge(project.status === 'completed' ? 'completed' : 'active'), statusBadge(project.stage), cellText((project.projectContacts || []).map(row => row.contact?.displayName).filter(Boolean).join('、') || '—'), cellText(formatDate(project.updatedAt))]));
      else dialogContent.append(empty('此公司还没有项目。'));
    } catch (error) { if (request.active) dialogContent.replaceChildren(el('p', 'error', error.message)); }
  }
  async function openTask(id) {
    const request = showDialog('任务详情', 'TASK'); dialogContent.append(el('div', 'loading', '正在加载任务…'));
    try {
      const task = await request.api(`/mail/tasks/${encodeURIComponent(id)}`); dialogContent.replaceChildren();
      append(dialogContent, el('p', 'eyebrow', `${task.project?.name || '未关联项目'}${task.topic?.name ? ` · ${task.topic.name}` : ''}`), el('h2', '', task.title), detailMeta([['状态', LABELS[task.status] || task.status], ['优先级', task.priority], ['负责人', LABELS[task.ownerType] || task.ownerType || '—'], ['等待方', LABELS[task.waitingOn] || task.waitingOn], ['期限', task.deadlineAt ? formatDate(task.deadlineAt) : task.deadlineDate || '—'], ['版本', task.version]]));
      dialogContent.append(el('h3', '', '任务说明'), el('p', 'notice-inline', task.description || '暂无说明'), el('h3', '', '来源与证据'));
      const source = (label, message, deletedAt) => {
        if (deletedAt) dialogContent.append(el('p', 'notice-inline', `${label}：来源邮件已删除（${formatDate(deletedAt)}），业务记录保留。`));
        else if (message?.id) dialogContent.append(button(`${label}：${message.subject || '(无主题)'}`, () => openEmail(message.id), 'button secondary small'));
      };
      source('创建来源', task.createdFromMessage, task.createdSourceDeletedAt);
      source('完成来源', task.completedFromMessage, task.completedSourceDeletedAt);
      for (const evidence of task.evidence || []) {
        const row = el('div', 'list-row'); const main = el('div', 'list-main');
        append(main, el('strong', '', ({ acknowledged: '已确认', planned: '计划执行', partial: '部分完成', completed: '已完成' })[evidence.evidenceType] || evidence.evidenceType || '证据'), el('p', 'evidence-excerpt', evidence.excerpt || '没有证据摘录'));
        if (evidence.sourceMessage?.id) main.append(button(evidence.sourceMessage.subject || '查看来源邮件', () => openEmail(evidence.sourceMessage.id), 'button secondary small'));
        append(row, main, el('span', 'list-meta', formatDate(evidence.createdAt))); dialogContent.append(row);
      }
      if (!task.evidence?.length && !task.createdFromMessage && !task.createdSourceDeletedAt) dialogContent.append(el('p', 'small-text', task.origin === 'user' ? '该任务由人工创建。' : '暂无可用来源证据。'));
      dialogContent.append(button('编辑任务', () => formDialog('编辑任务', '更新任务内容时使用版本检查；若邮件处理中已改变任务，保存会提示冲突。', [
        { name: 'title', label: '任务内容', value: task.title, required: true, wide: true },
        { name: 'description', label: '说明', type: 'textarea', value: task.description || '', wide: true },
        { name: 'kind', label: '类型', value: task.kind, options: [['action', '行动'], ['reply', '回复'], ['confirmation', '确认']] },
        { name: 'status', label: '状态', value: task.status, options: [['open', '待处理'], ['in_progress', '处理中'], ['waiting', '等待中'], ['done', '已完成'], ['cancelled', '已取消']] },
        { name: 'priority', label: '优先级', value: task.priority, options: [['low', '低'], ['normal', '普通'], ['high', '高'], ['urgent', '紧急']] },
        { name: 'waitingOn', label: '等待方', value: task.waitingOn, options: [['none', '未设置'], ['us', '我方'], ['customer', '客户'], ['third_party', '第三方'], ['mixed', '双方']] },
        { name: 'ownerType', label: '负责人', value: task.ownerType || 'none', options: [['none', '未指定'], ['us', '我方'], ['customer', '客户'], ['third_party', '第三方'], ['mixed', '双方']] },
      ], (payload, operationId) => api(`/mail/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...payload, expectedVersion: task.version, operationId }) })), 'button primary small'));
    } catch (error) { if (request.active) dialogContent.replaceChildren(el('p', 'error', error.message)); }
  }
  async function openReview(id) {
    const request = showDialog('复核详情', 'HUMAN REVIEW'); dialogContent.append(el('div', 'loading', '正在加载复核记录…'));
    try {
      const review = await request.api(`/mail/reviews/${encodeURIComponent(id)}`); const message = review.sourceMessage; const proposal = review.proposedChangeJson || {};
      const analysisReview = ['PROJECT_ANALYSIS_UNCERTAIN', 'PROJECT_ANALYSIS_MULTI_PROJECT', 'PROJECT_ANALYSIS_NEW_OPPORTUNITY'].includes(review.reasonCode);
      let assignmentMessage = message; let sourceUnavailable = Boolean(message?.sourceDeletedAt || message?.isSourceDeleted);
      if (analysisReview && message?.id && !sourceUnavailable) {
        try { assignmentMessage = await request.api(`/mail/messages/by-id/${encodeURIComponent(message.id)}`); }
        catch (error) { if (/不存在|not found|404/i.test(error.message)) sourceUnavailable = true; else throw error; }
      }
      dialogContent.replaceChildren();
      append(dialogContent, el('p', 'eyebrow', reviewReason(review.reasonCode)), el('h2', '', message?.subject || review.contact?.displayName || review.entityType), detailMeta([['状态', LABELS[review.status] || review.status], ['置信度', review.confidence ?? '—'], ['当前分类', CLASSIFICATIONS[message?.classification] || message?.classification || '—'], ['收到时间', formatDate(message?.receivedAt || review.createdAt)]]));
      if (review.reasonCode === 'FACT_REANALYSIS_REVIEW_REQUIRED') dialogContent.append(el('p', 'small-text', '请对照来源邮件与已有事项；确认后可在任务或业务记录中手动更正，重复提案可忽略。'));
      if (analysisReview) {
        const candidates = proposal.candidates || proposal.candidateProjects || review.candidateProjects || [];
        if (proposal.reason) dialogContent.append(el('p', 'small-text', proposal.reason));
        if (candidates.length) dialogContent.append(el('p', 'small-text', `候选项目：${candidates.map(item => item.name).filter(Boolean).join('、') || '无可读项目名称'}`));
        appendEvidence(dialogContent, proposal.evidence, { sourceDeleted: sourceUnavailable });
        if (sourceUnavailable) dialogContent.append(el('p', 'notice-inline', '来源邮件已删除或不可读取；不能打开或更改它的项目归属。'));
      } else {
        const proposalBlock = el('pre', 'json-block', JSON.stringify(proposal, null, 2)); dialogContent.append(el('h3', '', '建议与证据'), proposalBlock);
      }
      if (message?.id) dialogContent.append(sourceEmailButton(message.id, sourceUnavailable, '查看源邮件'));
      if (review.status !== 'pending') { dialogContent.append(el('p', 'small-text', `处理人：${review.resolvedBy || '—'} · ${formatDate(review.resolvedAt)}`)); return; }
      const actions = el('div', 'action-row'); const operationIds = new Map(); let resolving = false;
      const operationFor = (action, extra) => { const key = JSON.stringify([action, extra]); if (!operationIds.has(key)) operationIds.set(key, crypto.randomUUID()); return operationIds.get(key); };
      const resolve = async (action, extra = {}, confirmed = false) => {
        if (resolving) return;
        if (!confirmed) {
          const message = action === 'merge_contact'
            ? '合并会转移来源联系人的邮箱和邮件关联，并保留审计记录。此操作没有一键撤销。'
            : action === 'dismiss' ? '忽略后会将这条复核记录标记为已处理。'
              : '该操作会更新邮件或 CRM 事实并记录审计来源。';
          const label = action === 'merge_contact' ? '确认合并联系人' : action === 'dismiss' ? '确认忽略' : '确认并保存';
          requestInlineConfirmation(actions, message, label, () => resolve(action, extra, true), 'review-action-confirmation', '确认复核操作');
          return;
        }
        resolving = true; dialogBusy = true; const controls = [...actions.querySelectorAll('button, select')]; controls.forEach(control => { control.disabled = true; });
        try { await api(`/mail/reviews/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ action, actorId: 'dashboard-user', operationId: operationFor(action, extra), ...extra }) }); dialogBusy = false; closeDialog(); await loadPage('reviews'); showNotice('复核已处理'); }
        catch (error) { showNotice(error.message, true); }
        finally { resolving = false; dialogBusy = false; if (dialog.open) controls.forEach(control => { control.disabled = false; }); }
      };
      const assignAnalysisReview = async projectId => {
        if (!message?.id || sourceUnavailable || assignmentMessage?.projectManualOverride) {
          showNotice(sourceUnavailable ? '来源邮件已删除或不可读取，无法更改归属。' : '这封邮件已被人工锁定，请刷新后查看最新复核状态。', true); return;
        }
        if (!Number.isInteger(assignmentMessage?.projectAssignmentVersion)) {
          showNotice('服务端未返回邮件归属版本，无法安全更新。请刷新复核后重试。', true); return;
        }
        resolving = true; dialogBusy = true; const controls = [...actions.querySelectorAll('button, select')]; controls.forEach(control => { control.disabled = true; });
        try {
          await request.api(`/mail/messages/by-id/${encodeURIComponent(message.id)}/project`, { method: 'PATCH', body: JSON.stringify({ projectId: projectId?.id ?? null, expectedVersion: assignmentMessage.projectAssignmentVersion, operationId: operationFor('project_assignment', projectId?.id ?? null) }) });
          dialogBusy = false; closeDialog(); await loadPage('reviews'); showNotice('项目归属已人工确认并锁定。');
        } catch (error) { showNotice(error.message, true); }
        finally { resolving = false; dialogBusy = false; if (dialog.open) controls.forEach(control => { control.disabled = false; }); }
      };
      const confirmAnalysisAssignment = project => {
        const choice = project ? `归入“${project.name}”` : '确认为非项目邮件';
        requestInlineConfirmation(actions, `将此邮件${choice}并记录为人工锁定？`, project ? '确认归入并锁定' : '确认非项目并锁定',
          () => assignAnalysisReview(project), 'project-assignment-confirmation', '确认项目归属变更');
      };
      actions.append(button('忽略此项', () => resolve('dismiss'), 'button danger small'));
      if (review.entityType === 'contact' && review.contact?.status === 'provisional') actions.append(button('确认联系人', () => resolve('confirm_contact'), 'button primary small'));
      if (review.entityType === 'contact') {
        const picker = pagedSelect({ path: '/mail/crm/contacts', key: 'contacts', label: contact => `${contact.displayName} · ${(contact.emails || []).map(item => item.email).join(', ')}`, emptyLabel: '选择合并目标', filter: contact => contact.id !== review.entityId && contact.status !== 'merged' && !contact.mergedIntoId, search: true, request });
        const targetLabel = el('label', 'review-merge-target', '合并目标'); targetLabel.append(picker.element);
        actions.append(targetLabel, button('合并到所选联系人', () => {
          if (!picker.select.value) { showNotice('请选择合并目标联系人。', true); return; }
          resolve('merge_contact', { targetContactId: picker.select.value });
        }, 'button danger small'));
      }
      if (['CLASSIFICATION_UNCERTAIN', 'AI_CLASSIFICATION_DISAGREEMENT'].includes(review.reasonCode) && message?.id) {
        const select = optionSelect(Object.entries(CLASSIFICATIONS).map(([key, label]) => [key, label]), message.classification); actions.append(select, button('确认分类', () => resolve('confirm_classification', { classification: select.value, evidence: '在 Ai Mail Dashboard 中人工确认' }), 'button primary small'));
      }
      if (review.reasonCode?.startsWith('PROJECT_') && message?.id) {
        if (analysisReview) {
          const projectPicker = pagedSelect({ path: '/mail/projects', key: 'projects', label: project => `${project.name}${project.company?.name ? ` · ${project.company.name}` : ''}${project.status === 'completed' ? ' · 已结束' : ''}`, emptyLabel: '选择已有项目', request });
          actions.append(projectPicker.element, button('分配到所选项目', () => {
            const selected = projectPicker.known.get(projectPicker.select.value);
            if (!selected) { showNotice('请选择一个已有项目。', true); return; }
            confirmAnalysisAssignment({ id: selected.id, name: selected.name });
          }, 'button primary small'), button('确认非项目并锁定', () => confirmAnalysisAssignment(null), 'button secondary small'));
          if (assignmentMessage?.projectManualOverride) actions.append(el('p', 'small-text', '该邮件的项目归属已由人工锁定；请刷新或查看人工决定记录。'));
          if (sourceUnavailable) actions.querySelectorAll('button,select').forEach(control => { control.disabled = true; });
        } else {
          const projectPicker = pagedSelect({ path: '/mail/projects', key: 'projects', label: project => `${project.name}${project.company?.name ? ` · ${project.company.name}` : ''}`, emptyLabel: '选择项目', request });
          actions.append(projectPicker.element, button('分配到项目', () => {
            if (!projectPicker.select.value) { showNotice('请选择目标项目。', true); return; }
            resolve('assign_project', { projectId: projectPicker.select.value });
          }, 'button primary small'));
          actions.append(button('新建项目并分配', () => projectEditor(null, undefined, (payload, operationId) => api(`/mail/reviews/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'create_project', projectName: payload.name, companyId: payload.companyId, description: payload.description, contactIds: payload.contactIds, primaryContactId: payload.primaryContactId, status: payload.status, stage: payload.stage, actorId: 'dashboard-user', operationId }) })), 'button secondary small'));
        }
      }
      if (review.reasonCode === 'TOPIC_UNRESOLVED' && message?.projectId) {
        const project = await request.api(`/mail/projects/${encodeURIComponent(message.projectId)}`); const topics = (project.topics || []).filter(topic => topic.status === 'active');
        const topicSelect = optionSelect([['', '选择 Topic'], ...topics.map(t => [t.id, t.name])], '');
        actions.append(topicSelect, button('分配 Topic', () => {
          if (!topicSelect.value) { showNotice('请选择 Topic，或新建 Topic。', true); return; }
          resolve('assign_topic', { topicId: topicSelect.value });
        }, 'button primary small'), button('新建 Topic 并分配', () => createTopicDialog(message.projectId, id), 'button secondary small'));
      }
      dialogContent.append(el('h3', '', '处理操作'), actions);
    } catch (error) { if (request.active) dialogContent.replaceChildren(el('p', 'error', error.message)); }
  }

  document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => loadPage(item.dataset.page)));
  $('#refresh').addEventListener('click', () => loadPage(state.page));
  $('#logout').addEventListener('click', logout);
  $('.dialog-close').addEventListener('click', closeDialog);
  dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const error = $('#login-error'); error.textContent = '';
    const email = $('#email').value.trim(); const password = $('#password').value;
    try {
      const result = await authApi('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      sessionSequence++;
      showApp(result.user); $('#password').value = '';
      await loadPage(result.user.mustChangePassword ? 'account' : 'overview');
    } catch (reason) { error.textContent = reason.message; }
  });
  void restoreSession();
})();
