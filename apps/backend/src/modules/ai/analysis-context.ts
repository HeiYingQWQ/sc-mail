import { createHash } from 'node:crypto';

export type ContextMessage = { id: string; date: string | null; direction: string; from: unknown; subject: string | null; text: string | null };

export function buildAnalysisContext(input: {
  current: ContextMessage;
  recent: ContextMessage[];
  contact: unknown;
  company: unknown;
  projects: unknown[];
  currentProject: unknown;
  currentTopic: unknown;
  relatedTasks?: unknown[];
  relatedRequirements?: unknown[];
  relatedDecisions?: unknown[];
  priorSummaries?: unknown[];
  firstPassClassification?: unknown;
  priorAudits?: unknown[];
  businessTimezone: string;
  maxChars: number;
}) {
  const relatedTasks = input.relatedTasks ?? [];
  const relatedRequirements = input.relatedRequirements ?? [];
  const relatedDecisions = input.relatedDecisions ?? [];
  const priorSummaries = (input.priorSummaries ?? []).map((item: any) => ({ entityType: item.entityType, entityId: item.entityId, version: item.version, summary: typeof item.summary === 'string' ? item.summary.slice(0, 2000) : null }));
  const candidates = [input.current, ...input.recent.filter((item) => item.id !== input.current.id)].slice(0, 5);
  const messages = candidates.map((message, index) => ({
    id: message.id,
    date: message.date,
    direction: message.direction,
    from: message.from,
    subject: message.subject?.slice(0, 500) ?? null,
    text: (message.text ?? '').slice(0, index === 0 ? 6000 : 2500),
  }));
  let trimmed = candidates.some((item, index) => (item.text ?? '').length > (index === 0 ? 6000 : 2500));
  const context = {
    current_message_id: input.current.id,
    messages,
    contact: input.contact,
    company: input.company,
    current_project: input.currentProject,
    current_topic: input.currentTopic,
    known_projects: input.projects,
    open_tasks: relatedTasks,
    requirements: relatedRequirements,
    decisions: relatedDecisions,
    prior_summaries: priorSummaries,
    first_pass_classification: input.firstPassClassification ?? null,
    prior_ai_audits: input.priorAudits ?? [],
    business_timezone: input.businessTimezone,
    unavailable_entities: [],
  };
  const serialized = () => JSON.stringify(context);
  while (serialized().length > input.maxChars) {
    const history = messages.slice(1).filter((message) => message.text.length > 0).sort((a, b) => b.text.length - a.text.length)[0];
    if (history) {
      const excess = serialized().length - input.maxChars;
      history.text = history.text.slice(0, Math.max(0, history.text.length - Math.max(100, excess)));
      trimmed = true;
      continue;
    }
    const body = messages[0];
    if (body.text.length > 0) {
      const excess = serialized().length - input.maxChars;
      body.text = body.text.slice(0, Math.max(0, body.text.length - Math.max(100, excess)));
      trimmed = true;
      continue;
    }
    if (messages.length > 1) {
      messages.pop();
      trimmed = true;
      continue;
    }
    throw new Error('AI_CONTEXT_LIMIT_TOO_SMALL');
  }
  const json = serialized();
  const summary = {
    currentMessageId: input.current.id,
    messageIds: messages.map((message) => message.id),
    contextSha256: createHash('sha256').update(json, 'utf8').digest('hex'),
    contextChars: json.length,
    contextBytes: Buffer.byteLength(json, 'utf8'),
    trimmed,
    relatedEntityIds: {
      contact: (input.contact as any)?.id ?? null,
      company: (input.company as any)?.id ?? null,
      project: (input.currentProject as any)?.id ?? null,
      topic: (input.currentTopic as any)?.id ?? null,
      knownProjects: input.projects.map((project: any) => project.id),
      tasks: relatedTasks.map((task: any) => task.id),
      requirements: relatedRequirements.map((item: any) => item.id),
      decisions: relatedDecisions.map((item: any) => item.id),
    },
    firstPassClassification: input.firstPassClassification ?? null,
    priorAuditRunIds: (input.priorAudits ?? []).map((item: any) => item.analysisRunId).filter((id) => typeof id === 'string'),
    summaryInputVersions: priorSummaries.map(({ entityType, entityId, version }) => ({ entityType, entityId, version })),
    unavailableEntities: [],
  };
  return { context, promptContext: json, summary };
}
