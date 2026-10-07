import { AnalysisOperation, AnalysisResult } from './analysis.schema';

const ALLOWED: Record<AnalysisOperation['entity_type'], Record<AnalysisOperation['action'], string[] | null>> = {
  task: {
    create: ['title', 'description', 'kind', 'owner_type', 'owner_id', 'waiting_on', 'priority', 'deadline_at', 'deadline_date', 'deadline_timezone', 'deadline_text', 'status'],
    update: ['title', 'description', 'kind', 'owner_type', 'owner_id', 'waiting_on', 'priority', 'deadline_at', 'deadline_date', 'deadline_timezone', 'deadline_text', 'status'],
    complete: ['status'], cancel: ['status'],
  },
  requirement: { create: ['text', 'status'], update: ['text', 'status'], complete: null, cancel: null },
  decision: { create: ['text', 'status'], update: null, complete: null, cancel: null },
  project: { create: ['project_name', 'description'], update: ['project_name', 'description', 'stage'], complete: null, cancel: null },
  topic: { create: ['topic_name', 'topic_type', 'topic_description'], update: ['topic_name', 'topic_type', 'topic_description'], complete: null, cancel: null },
};

function normalizeEvidence(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

export function validateClassificationEvidence(evidence: string[], sourceText: string): string[] {
  const source = normalizeEvidence(sourceText);
  return evidence.every((excerpt) => excerpt.length >= 4 && source.includes(normalizeEvidence(excerpt)))
    ? []
    : ['CLASSIFICATION_EVIDENCE_NOT_VERIFIABLE'];
}

function hasConcreteCompletionEvidence(value: string, taskTitle?: string): boolean {
  const relevant = taskTitle ? value.split(/[.;!?\n]+/).filter(part => titleMentioned(taskTitle, part)) : [];
  const normalized = normalizeEvidence(relevant.length ? relevant.join('; ') : value);
  const negated = /\b(?:not|never|yet|isn't|wasn't|weren't|haven't|hasn't|hadn't|didn't|doesn't|can't|cannot|unable to|failed to)\b.{0,45}\b(?:done|complet\w*|deliver\w*|sent|attach\w*|provid\w*|shar\w*|finish\w*|fix\w*|approv\w*|resolv\w*|submitt\w*|ship\w*)\b|\b(?:non|mai|ancora)\b.{0,35}\b(?:completat\w*|consegnat\w*|inviat\w*|allegat\w*|spedit\w*|approvat\w*|risolt\w*)\b|未完成|尚未完成|没有完成|还没完成|未交付|尚未交付|没有发送|尚未发送|还没发/iu.test(normalized);
  const futureIntent = /\b(?:will|shall|going to|plan to|intend to|expect to|aim to)\b.{0,60}\b(?:complete|completed|finish|finished|deliver|delivered|send|sent|attach|attached|provide|provided|share|shared|install|installed|fix|fixed|approve|approved|submit|submitted|ship|shipped|dispatch|dispatched|done)\b|\b(?:tomorrow|later|next week|soon)\b.{0,60}\b(?:complete|completed|finish|finished|deliver|delivered|send|sent|attach|attached|provide|provided|share|shared|install|installed|fix|fixed|approve|approved|submit|submitted|ship|shipped|dispatch|dispatched|done)\b|\b(?:send|sent|deliver|delivered|attach|attached|provide|provided|share|shared|finish|finished|complete|completed|submit|submitted).{0,45}\b(?:tomorrow|later|next week|soon)\b|(?:明天|稍后|下周|以后).{0,20}(?:会|将|准备|打算|计划|发送|交付|处理|完成)|(?:会|将|准备|打算|计划).{0,20}(?:明天|稍后|下周|以后)/iu.test(normalized);
  if (negated || futureIntent) return false;
  // Readiness of a document does not prove that a send/deliver/approve task happened.
  const title = normalizeEvidence(taskTitle ?? '');
  const actions = [
    { title: /\b(?:send|deliver|share|submit|provide|dispatch|ship)\b|\b(?:inviare|invia|consegnare|spedire)\b|发送|交付|提交|寄送/u, done: /\b(?:sent|delivered|shared|submitted|provided|dispatched|shipped|attached)\b|\b(?:inviat[oaie]|consegnat[oaie]|spedit[oaie]|allegat[oaie])\b|已发送|已经发送|已发出|已交付|已提交|已附上/u },
    { title: /\b(?:approve|confirm)\b|approvare|confermare|批准|确认/u, done: /\b(?:approved|confirmed)\b|approvat[oaie]|confermat[oaie]|已批准|已确认/u },
    { title: /\b(?:pay|payment)\b|pagare|付款|支付/u, done: /\bpaid\b|pagat[oaie]|已付款|已支付/u },
  ];
  for (const action of actions) if (action.title.test(title) && !action.done.test(normalized) && !/\b(?:task|work) (?:is |has been )?(?:done|completed)\b|任务已完成/u.test(normalized)) return false;
  if (/\b(?:please|kindly|must|need to|still need to)\b.{0,35}\b(?:send|deliver|submit|approve|pay)\b|\b(?:per favore|devi|bisogna)\b.{0,35}\b(?:inviare|invia|consegnare|approvare)\b|(?:请|需要|还要).{0,15}(?:发送|交付|提交|批准)/u.test(normalized)) return false;
  return /\b(done|completed|delivered|sent|attached|provided|shared|finished|finali[sz]ed|installed|fixed|approved|confirmed|issued|ready|resolved|paid|submitted|shipped|dispatched|created|handed over)\b|\b(completat[oaie]|consegnat[oaie]|inviat[oaie]|allegat[oaie]|spedit[oaie]|approvat[oaie]|risolt[oaie]|pagat[oaie]|pront[oaie])\b|已完成|完成了|已交付|已经交付|交付了|已发送|已经发送|已发出|已经发出|发出去了|已附上|已经附上|已提交|已经提交|提交了|已处理|已修复|做完了|已经完成|已上传|上传完成/iu.test(normalized);
}

function titleMentioned(title: string, evidence: string): boolean {
  const ignored = new Set(['send', 'sent', 'deliver', 'delivered', 'complete', 'completed', 'finish', 'finished', 'task', 'item', 'work', 'please', 'with', 'from', 'that', 'this', 'have', 'been', 'will', 'done', 'client', 'customer', 'the', 'and', 'for', 'our', 'your', 'per', 'con', 'della', 'delle', 'dello', 'dalla', 'dalle', 'sono', 'stato', 'stata', 'fatto', 'task', '要求', '任务', '完成', '客户', 'revised', 'updated', 'new', 'latest', 'project', 'inviare', 'invia', 'consegnare', 'spedire', 'il', 'la', 'lo', 'di', 'del', 'revisionato', 'aggiornato']);
  const titleWords = normalizeEvidence(title).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const evidenceWords = new Set(normalizeEvidence(evidence).match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  const specific = titleWords.filter((word) => !ignored.has(word)).map(word => /[\u3400-\u9fff]/u.test(word)
    ? word.replace(/^(?:(?:请|发送|提交|交付|确认|批准|支付|完成|寄送|处理|更新|修订|最新|新版|修改))+/u, '') : word).filter(Boolean);
  const normalized = normalizeEvidence(evidence);
  return specific.length > 0 && specific.every(word => /[\u3400-\u9fff]/u.test(word) ? normalized.includes(word) : evidenceWords.has(word));
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateAtTimezone(value: string, timezone: string): string | null {
  try {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  } catch { return null; }
}

export function targetIsInKnownScope(
  entityType: string,
  companyId: string | null,
  projectId: string | null,
  target: { id: string; companyId?: string | null; projectId?: string | null; status?: string } | null,
): boolean {
  if (!target || target.status !== 'active') return false;
  if (entityType === 'project') {
    if (companyId) return target.companyId === companyId;
    return Boolean(projectId && target.id === projectId);
  }
  if (entityType === 'topic') return Boolean(projectId && target.projectId === projectId);
  if (target.projectId) {
    if (projectId) return target.projectId === projectId;
    return false;
  }
  return !projectId;
}

export function analysisNeedsReview(result: AnalysisResult, businessErrors: string[]): boolean {
  return businessErrors.length > 0 || result.requires_deep_analysis || result.review_reasons.length > 0 || result.classification === 'UNKNOWN';
}

export async function validateAnalysisBusiness(
  result: AnalysisResult,
  currentMessageId: string,
  currentMessageContent: string,
  targetExists: (entityType: string, targetId: string) => Promise<boolean | { exists: boolean; title?: string }>,
  dateContext: { hasMessageDate: boolean; businessTimezone: string },
): Promise<string[]> {
  const errors: string[] = [];
  const evidenceSource = normalizeEvidence(currentMessageContent);
  const taskTargets = new Set<string>();
  for (let index = 0; index < result.operations.length; index += 1) {
    const operation = result.operations[index];
    let targetTitle: string | undefined;
    const prefix = `operations[${index}]`;
    if (operation.source_message_id !== currentMessageId) errors.push(`${prefix}: SOURCE_NOT_CURRENT_MESSAGE`);
    const evidence = normalizeEvidence(operation.evidence);
    if (evidence.length < 6 || !evidenceSource.includes(evidence)) errors.push(`${prefix}: EVIDENCE_NOT_VERIFIABLE`);
    if (operation.confidence < 0.75) errors.push(`${prefix}: LOW_CONFIDENCE`);
    if (!['none', 'acknowledged', 'planned', 'partial', 'completed', 'unclear'].includes(operation.task_outcome)) errors.push(`${prefix}: TASK_OUTCOME_INVALID`);
    if (operation.entity_type !== 'task' && operation.task_outcome !== 'none') errors.push(`${prefix}: TASK_OUTCOME_NOT_APPLICABLE`);
    const allowedFields = ALLOWED[operation.entity_type]?.[operation.action];
    if (!allowedFields) {
      errors.push(`${prefix}: ENTITY_ACTION_NOT_SUPPORTED`);
      continue;
    }
    const changedFields = Object.entries(operation.changes).filter(([, value]) => value !== null).map(([key]) => key);
    for (const key of changedFields) if (!allowedFields.includes(key)) errors.push(`${prefix}: FIELD_NOT_ALLOWED_${key}`);
    if (!changedFields.length && !(operation.entity_type === 'task' && ['acknowledged', 'planned', 'partial'].includes(operation.task_outcome))) errors.push(`${prefix}: NO_CHANGE_FIELDS`);
    const createRequired: Partial<Record<AnalysisOperation['entity_type'], string>> = {
      task: 'title', requirement: 'text', decision: 'text', project: 'project_name', topic: 'topic_name',
    };
    if (operation.action === 'create') {
      if (operation.target_id !== null) errors.push(`${prefix}: CREATE_TARGET_MUST_BE_NULL`);
      const requiredField = createRequired[operation.entity_type];
      if (requiredField && !operation.changes[requiredField]) errors.push(`${prefix}: CREATE_FIELD_REQUIRED_${requiredField}`);
    } else {
      if (!operation.target_id) errors.push(`${prefix}: TARGET_ID_REQUIRED`);
      else {
        const target = await targetExists(operation.entity_type, operation.target_id);
        const exists = typeof target === 'boolean' ? target : target.exists;
        targetTitle = typeof target === 'boolean' ? undefined : target.title;
        if (!exists) errors.push(`${prefix}: TARGET_NOT_FOUND_OR_UNAVAILABLE`);
        if (operation.entity_type === 'task' && operation.task_outcome === 'completed' && typeof target !== 'boolean' && target.title && !titleMentioned(target.title, operation.evidence)) errors.push(`${prefix}: COMPLETION_TARGET_NOT_SPECIFIC`);
      }
    }
    if (operation.entity_type === 'task') {
      if (operation.target_id && operation.action !== 'create') {
        if (taskTargets.has(operation.target_id)) errors.push(`${prefix}: DUPLICATE_TASK_TARGET`);
        taskTargets.add(operation.target_id);
      }
      if (operation.action === 'create' && !['none', 'unclear'].includes(operation.task_outcome)) errors.push(`${prefix}: TASK_OUTCOME_REQUIRES_EXISTING_TASK`);
      if (operation.task_outcome === 'unclear') errors.push(`${prefix}: TASK_OUTCOME_UNCLEAR`);
      const saysDone = operation.action === 'complete' || operation.changes.status === 'done';
      if (saysDone && operation.task_outcome !== 'completed') errors.push(`${prefix}: TASK_COMPLETION_EVIDENCE_REQUIRED`);
      if (saysDone && operation.changes.status !== 'done') errors.push(`${prefix}: COMPLETE_STATUS_MUST_BE_DONE`);
      if (operation.task_outcome === 'completed' && (!saysDone || !hasConcreteCompletionEvidence(operation.evidence, targetTitle))) errors.push(`${prefix}: COMPLETION_EVIDENCE_NOT_CONCRETE`);
      if (operation.task_outcome !== 'completed' && saysDone) errors.push(`${prefix}: NON_COMPLETED_OUTCOME_CANNOT_CLOSE_TASK`);
      if (operation.task_outcome === 'partial' && operation.changes.status && operation.changes.status !== 'in_progress') errors.push(`${prefix}: PARTIAL_TASK_MUST_REMAIN_OPEN`);
      if (['planned', 'acknowledged', 'partial', 'unclear'].includes(operation.task_outcome) && operation.changes.status === 'done') errors.push(`${prefix}: NON_COMPLETED_OUTCOME_CANNOT_CLOSE_TASK`);
    }
    if (operation.entity_type === 'task' && operation.action === 'cancel' && operation.changes.status !== 'cancelled') errors.push(`${prefix}: CANCEL_STATUS_MUST_BE_CANCELLED`);
    const status = operation.changes.status;
    if (status && operation.entity_type === 'task' && !['open', 'in_progress', 'waiting', 'done', 'cancelled'].includes(status)) errors.push(`${prefix}: TASK_STATUS_INVALID`);
    if (status && operation.entity_type === 'requirement' && !['open', 'accepted', 'rejected'].includes(status)) errors.push(`${prefix}: REQUIREMENT_STATUS_INVALID`);
    if (status && operation.entity_type === 'decision' && !['proposed', 'accepted', 'rejected'].includes(status)) errors.push(`${prefix}: DECISION_STATUS_INVALID`);
    const deadlineAt = operation.changes.deadline_at;
    const deadlineDate = operation.changes.deadline_date;
    const timezone = operation.changes.deadline_timezone;
    if (deadlineAt) {
      if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(deadlineAt) || !Number.isFinite(Date.parse(deadlineAt))) errors.push(`${prefix}: DEADLINE_AT_MUST_BE_ISO_WITH_OFFSET`);
    }
    if (deadlineDate && !validCalendarDate(deadlineDate)) errors.push(`${prefix}: DEADLINE_DATE_INVALID`);
    if (deadlineDate && !timezone) errors.push(`${prefix}: DEADLINE_TIMEZONE_REQUIRED`);
    if (timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
      catch { errors.push(`${prefix}: DEADLINE_TIMEZONE_INVALID`); }
    }
    if (deadlineAt && deadlineDate && timezone && dateAtTimezone(deadlineAt, timezone) !== deadlineDate) errors.push(`${prefix}: DEADLINE_FIELDS_CONFLICT`);
    if (deadlineDate && timezone && timezone !== dateContext.businessTimezone) errors.push(`${prefix}: DEADLINE_TIMEZONE_DIFFERS_BUSINESS`);
    if (operation.changes.deadline_text && !deadlineAt && !deadlineDate) errors.push(`${prefix}: DEADLINE_TEXT_REQUIRES_REVIEW`);
    if (operation.changes.deadline_text && !dateContext.hasMessageDate) errors.push(`${prefix}: DEADLINE_BASELINE_DATE_MISSING`);
  }
  return errors;
}
