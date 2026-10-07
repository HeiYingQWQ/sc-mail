import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { deriveProjectState } from './project-state.policy';
import { ProjectEmailAnalysisService } from './project-email-analysis.service';
import { lockProjectsForWrite } from './project-lifecycle.guard';
import { isConcurrentWriteError } from './business-operation';

const STAGES = ['lead', 'planning', 'design', 'quotation', 'revision', 'approval', 'production', 'delivery', 'completed', 'on_hold', 'cancelled'];

@Injectable()
export class SummaryTimelineService {
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService, @Optional() private readonly projectAnalysis?: ProjectEmailAnalysisService) {}

  async projectTimeline(projectId: string, limit: number, offset: number) {
    const account = await this.account();
    const where: Prisma.TimelineEventWhereInput = { projectId, project: { status: { not: 'deleted' } }, OR: [{ project: { messages: { some: { mailAccountId: account.id } } } }, { project: { messages: { none: {} } } }] };
    const [total, events] = await this.prisma.$transaction([
      this.prisma.timelineEvent.count({ where }),
      this.prisma.timelineEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset, include: { sourceMessage: { select: { id: true, subject: true, sentAt: true, receivedAt: true } } } }),
    ]);
    return { projectId, total, limit, offset, events };
  }

  async projectSummary(projectId: string) {
    const account = await this.account();
    const project = await this.prisma.project.findFirst({ where: { id: projectId, status: { not: 'deleted' }, OR: [{ messages: { some: { mailAccountId: account.id } } }, { messages: { none: {} } }] }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found');
    return this.readSummary('project', projectId);
  }

  async entitySummary(entityType: string, entityId: string) {
    if (!['project', 'topic', 'thread'].includes(entityType)) throw new BadRequestException('Unsupported summary entity type');
    const account = await this.account();
    await this.assertSummaryEntity(this.prisma, entityType, entityId, account.id);
    return this.readSummary(entityType, entityId);
  }

  async applyAnalysisSummary(runId: string, body: Record<string, unknown>) {
    this.rejectExtra(body, ['operationId', 'entityType', 'entityId', 'expectedVersion']);
    const operationId = this.text(body.operationId, 'operationId', 200);
    const entityType = this.text(body.entityType, 'entityType', 20);
    if (!['project', 'topic', 'thread'].includes(entityType)) throw new BadRequestException('entityType must be project, topic, or thread');
    const entityId = this.text(body.entityId, 'entityId', 100);
    const expectedVersion = this.integer(body.expectedVersion, 'expectedVersion', 0, 2_147_483_647);
    const account = await this.account();
    const run = await this.prisma.analysisRun.findFirst({ where: { id: runId, mailAccountId: account.id }, include: { sourceMessage: true } });
    if (!run || run.status !== 'completed' || run.validationStatus !== 'valid' || !run.resultJson) throw new NotFoundException('Validated analysis run not found');
    const summaryText = (run.resultJson as { summary?: unknown }).summary;
    if (typeof summaryText !== 'string' || !summaryText.trim()) throw new ConflictException({ code: 'SUMMARY_MISSING' });
    const message = run.sourceMessage;
    const timestamp = message.sentAt ?? message.receivedAt;
    if (!timestamp) throw new ConflictException({ code: 'SOURCE_DATE_MISSING' });
    if (entityType === 'project' && message.projectId !== entityId) throw new ConflictException({ code: 'SOURCE_SCOPE_MISMATCH' });
    if (entityType === 'topic' && message.topicId !== entityId) throw new ConflictException({ code: 'SOURCE_SCOPE_MISMATCH' });
    if (entityType === 'thread' && (!message.threadId || message.threadId !== entityId)) throw new ConflictException({ code: 'SOURCE_SCOPE_MISMATCH' });
    const operationHash = this.hash({ runId, entityType, entityId, expectedVersion, summaryText });
    return this.serializable(async (tx) => {
      const replay = await tx.businessOperation.findUnique({ where: { operationId } });
      if (replay) {
        if (replay.inputHash !== operationHash || replay.entityType !== 'summary') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return this.readSummaryTx(tx, entityType, entityId);
      }
      const snapshot = (run.inputSummaryJson as any)?.summaryInputVersions;
      const inputVersion = Array.isArray(snapshot) ? snapshot.find((item: any) => item.entityType === entityType && item.entityId === entityId)?.version : undefined;
      if (!Number.isInteger(inputVersion) || inputVersion !== expectedVersion) throw new ConflictException({ code: 'SUMMARY_INPUT_STALE', message: 'Reanalyze using the current summary before applying it' });
      await this.assertSummaryEntity(tx, entityType, entityId, account.id);
      await this.lockSummaryProject(tx, entityType, entityId);
      const newer = await tx.emailMessage.findFirst({ where: this.entityMessageFilter(entityType, entityId, account.id, timestamp), select: { id: true } });
      if (newer) throw new ConflictException({ code: 'STALE_SOURCE', message: 'A newer email exists for this summary scope' });
      const key = { entityType_entityId: { entityType, entityId } };
      let summary = await tx.summary.findUnique({ where: { entityType_entityId: key.entityType_entityId } });
      if (!summary && expectedVersion !== 0) throw new ConflictException({ code: 'SUMMARY_VERSION_CONFLICT', currentVersion: 0 });
      if (!summary) summary = await tx.summary.create({ data: { entityType, entityId } });
      if (summary.version !== expectedVersion) throw new ConflictException({ code: 'SUMMARY_VERSION_CONFLICT', currentVersion: summary.version });
      const latestVersion = await tx.summaryVersion.aggregate({ where: { summaryId: summary.id }, _max: { version: true } });
      const version = (latestVersion._max.version ?? 0) + 1;
      const prior = summary.currentVersionId ? await tx.summaryVersion.findUnique({ where: { id: summary.currentVersionId } }) : null;
      const saved = await tx.summaryVersion.create({ data: { summaryId: summary.id, version, previousSummary: prior?.newSummary ?? null, newSummary: summaryText.trim(), triggerMessageId: message.id, model: `${run.provider}/${run.model}` } });
      const updated = await tx.summary.updateMany({ where: { id: summary.id, version: expectedVersion }, data: { version, currentVersionId: saved.id, manualOverride: true, isDerived: false, inputHash: null, coverageJson: { stale: false, source: 'manual_analysis_apply' } } });
      if (!updated.count) throw new ConflictException({ code: 'SUMMARY_VERSION_CONFLICT' });
      if (entityType !== 'thread') await tx.timelineEvent.create({ data: { ...(entityType === 'project' ? { projectId: entityId } : { topicId: entityId }), eventType: 'SUMMARY_UPDATED', title: 'Summary updated', sourceMessageId: message.id, metadataJson: { summaryVersion: version } } });
      await tx.businessOperation.create({ data: { operationId, inputHash: operationHash, entityType: 'summary', entityId: summary.id, action: 'update', actorId: 'api-token-client', sourceMessageId: message.id, afterJson: { version, summaryVersionId: saved.id } } });
      return { id: summary.id, entityType, entityId, version, summary: saved.newSummary, triggerMessageId: saved.triggerMessageId, updatedAt: new Date() };
    });
  }

  async rollback(body: Record<string, unknown>) {
    this.rejectExtra(body, ['operationId', 'summaryId', 'expectedVersion', 'targetVersion']);
    const operationId = this.text(body.operationId, 'operationId', 200);
    const summaryId = this.text(body.summaryId, 'summaryId', 100);
    const expectedVersion = this.integer(body.expectedVersion, 'expectedVersion', 1, 2_147_483_647);
    const targetVersion = this.integer(body.targetVersion, 'targetVersion', 1, 2_147_483_647);
    const hash = this.hash({ action: 'rollback', summaryId, expectedVersion, targetVersion });
    return this.serializable(async (tx) => {
      const replay = await tx.businessOperation.findUnique({ where: { operationId } });
      if (replay) {
        if (replay.inputHash !== hash || replay.entityType !== 'summary') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return this.readSummaryByIdTx(tx, summaryId);
      }
      const summary = await tx.summary.findUnique({ where: { id: summaryId } });
      if (!summary) throw new NotFoundException('Summary not found');
      if (summary.version !== expectedVersion) throw new ConflictException({ code: 'SUMMARY_VERSION_CONFLICT', currentVersion: summary.version });
      await this.lockSummaryProject(tx, summary.entityType, summary.entityId);
      const target = await tx.summaryVersion.findUnique({ where: { summaryId_version: { summaryId, version: targetVersion } } });
      if (!target) throw new NotFoundException('Target summary version not found');
      const current = summary.currentVersionId ? await tx.summaryVersion.findUnique({ where: { id: summary.currentVersionId } }) : null;
      if (target.isSuggestion && summary.entityType === 'project') {
        if (!target.triggerMessageId || target.sourceDeletedAt) throw new ConflictException({ code: 'SUMMARY_SUGGESTION_SOURCE_DELETED' });
        const coverage = summary.coverageJson && typeof summary.coverageJson === 'object' && !Array.isArray(summary.coverageJson) ? summary.coverageJson as Record<string, unknown> : {};
        if (coverage.stale === true || coverage.suggestionVersion !== target.version || typeof coverage.suggestionInputHash !== 'string') throw new ConflictException({ code: 'SUMMARY_SUGGESTION_INPUT_STALE' });
        const suggestionCoverage = coverage.suggestionCoverage && typeof coverage.suggestionCoverage === 'object' && !Array.isArray(coverage.suggestionCoverage) ? coverage.suggestionCoverage as Record<string, unknown> : {};
        const sourceIds = Array.isArray(suggestionCoverage.sourceMessageIds) ? suggestionCoverage.sourceMessageIds.filter((value): value is string => typeof value === 'string') : [];
        if (!sourceIds.includes(target.triggerMessageId)) throw new ConflictException({ code: 'SUMMARY_SUGGESTION_SOURCE_STALE' });
        const sourceRows = sourceIds.length ? await tx.emailMessage.findMany({ where: { id: { in: sourceIds } }, select: { id: true, projectId: true } }) : [];
        if (sourceRows.length !== sourceIds.length || sourceRows.some((source) => source.projectId !== summary.entityId)) throw new ConflictException({ code: 'SUMMARY_SUGGESTION_SOURCE_STALE' });
        if (!this.projectAnalysis || !await this.projectAnalysis.isSummarySuggestionCurrent(tx, summary.entityId, coverage.suggestionInputHash)) throw new ConflictException({ code: 'SUMMARY_SUGGESTION_INPUT_STALE' });
      }
      const latestVersion = await tx.summaryVersion.aggregate({ where: { summaryId }, _max: { version: true } });
      const version = (latestVersion._max.version ?? 0) + 1;
      const saved = await tx.summaryVersion.create({ data: { summaryId, version, previousSummary: current?.newSummary ?? null, newSummary: target.newSummary, triggerMessageId: null, model: 'manual-rollback' } });
      const changed = await tx.summary.updateMany({ where: { id: summaryId, version: expectedVersion }, data: { version, currentVersionId: saved.id, manualOverride: true, isDerived: false, inputHash: null, coverageJson: { stale: false, source: 'manual_rollback' } } });
      if (!changed.count) throw new ConflictException({ code: 'SUMMARY_VERSION_CONFLICT' });
      const entityField = summary.entityType === 'topic' ? { topicId: summary.entityId } : summary.entityType === 'project' ? { projectId: summary.entityId } : {};
      if (Object.keys(entityField).length) await tx.timelineEvent.create({ data: { ...entityField, eventType: 'SUMMARY_ROLLED_BACK', title: 'Summary rolled back', metadataJson: { fromVersion: expectedVersion, targetVersion, newVersion: version } } });
      await tx.businessOperation.create({ data: { operationId, inputHash: hash, entityType: 'summary', entityId: summaryId, action: 'rollback', actorId: 'api-token-client', afterJson: { version, targetVersion } } });
      return { id: summaryId, entityType: summary.entityType, entityId: summary.entityId, version, summary: saved.newSummary, updatedAt: new Date() };
    });
  }

  async changeProjectStage(projectId: string, body: Record<string, unknown>) {
    this.rejectExtra(body, ['operationId', 'expectedVersion', 'stage', 'status']);
    const operationId = this.text(body.operationId, 'operationId', 200);
    const expectedVersion = this.integer(body.expectedVersion, 'expectedVersion', 1, 2_147_483_647);
    const stage = this.text(body.stage, 'stage', 30);
    if (!STAGES.includes(stage)) throw new BadRequestException('Invalid project stage');
    const requestedStatus = body.status === undefined ? null : this.text(body.status, 'status', 20);
    if (requestedStatus !== null && !['active', 'completed'].includes(requestedStatus)) throw new BadRequestException('Project status must be active or completed');
    if (requestedStatus !== null && ((stage === 'completed') !== (requestedStatus === 'completed'))) throw new BadRequestException({ code: 'PROJECT_STAGE_STATUS_MISMATCH', message: 'stage=completed and status=completed must be selected together' });
    const account = await this.account();
    const hash = this.hash({ projectId, expectedVersion, stage, status: requestedStatus });
    return this.serializable(async (tx) => {
      const replay = await tx.businessOperation.findUnique({ where: { operationId } });
      if (replay) {
        if (replay.inputHash !== hash || replay.entityType !== 'project') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return tx.project.findUniqueOrThrow({ where: { id: projectId } });
      }
      const project = await tx.project.findFirst({ where: { id: projectId, OR: [{ messages: { some: { mailAccountId: account.id } } }, { messages: { none: {} } }] } });
      if (!project) throw new NotFoundException('Project not found');
      await lockProjectsForWrite(tx, [projectId]);
      const currentProject = await tx.project.findUnique({ where: { id: projectId } });
      if (!currentProject || currentProject.status === 'deleted') throw new NotFoundException('Project not found');
      if (currentProject.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: currentProject.version });
      if (requestedStatus === null && currentProject.status === 'completed' && stage !== 'completed') {
        throw new BadRequestException({ code: 'PROJECT_REOPEN_REQUIRES_STATUS', message: 'Reopening a completed project requires status=active explicitly.' });
      }
      const status = requestedStatus ?? (stage === 'completed' ? 'completed' : 'active');
      const updated = await tx.project.updateMany({ where: { id: projectId, version: expectedVersion, status: { not: 'deleted' } }, data: { stage, status, version: { increment: 1 }, manualOverride: true } });
      if (!updated.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      const after = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
      await tx.timelineEvent.create({ data: { projectId, eventType: 'PROJECT_STAGE_CHANGED', title: `Stage changed to ${stage}`, metadataJson: { from: currentProject.stage, to: stage, operationId } } });
      const agentEvent = await tx.agentEvent.create({ data: { eventKey: `project-stage:${operationId}`, eventType: 'PROJECT_STAGE_CHANGED', entityType: 'project', entityId: projectId, priority: 5, notificationPolicy: 'REVIEW', payloadJson: { eventType: 'PROJECT_STAGE_CHANGED', entityType: 'project', entityId: projectId, from: currentProject.stage, to: stage } } });
      await tx.agentWakeupDelivery.create({ data: { eventId: agentEvent.id } });
      await tx.businessOperation.create({ data: { operationId, inputHash: hash, entityType: 'project', entityId: projectId, action: 'change_stage', actorId: 'api-token-client', beforeJson: { stage: currentProject.stage, version: currentProject.version }, afterJson: { stage: after.stage, version: after.version } } });
      return after;
    });
  }

  async recordBusinessMutation(tx: Prisma.TransactionClient, entityType: string, action: string, entity: Record<string, unknown>, sourceMessageId: string | null, operationId: string, taskOutcome?: string, before?: unknown) {
    const projectId = typeof entity.projectId === 'string' ? entity.projectId : null;
    const topicId = typeof entity.topicId === 'string' ? entity.topicId : null;
    const prior = before && typeof before === 'object' ? before as Record<string, unknown> : {};
    const oldProjectId = typeof prior.projectId === 'string' ? prior.projectId : null;
    const oldTopicId = typeof prior.topicId === 'string' ? prior.topicId : null;
    await this.lockMutationProjects(tx, [projectId, oldProjectId], [topicId, oldTopicId]);
    const eventType = entityType === 'task' ? (action === 'create' ? 'TASK_CREATED' : taskOutcome === 'partial' ? 'TASK_PROGRESS_REPORTED' : taskOutcome === 'planned' ? 'TASK_ACTION_PLANNED' : taskOutcome === 'acknowledged' ? 'TASK_ACKNOWLEDGED' : action === 'complete' || entity.status === 'done' ? 'TASK_COMPLETED' : 'TASK_UPDATED')
      : entityType === 'requirement' ? (action === 'create' ? 'REQUIREMENT_ADDED' : 'REQUIREMENT_UPDATED')
      : action === 'create' ? 'DECISION_ADDED' : 'DECISION_UPDATED';
    if (projectId || topicId) await tx.timelineEvent.create({ data: { projectId, topicId, eventType, title: `${entityType} ${taskOutcome ?? action}`, description: typeof entity.title === 'string' ? entity.title : typeof entity.text === 'string' ? entity.text.slice(0, 500) : null, sourceMessageId, metadataJson: { entityType, entityId: String(entity.id), operationId, ...(taskOutcome ? { taskOutcome } : {}) } } });
    if (projectId && entityType === 'task') await this.recomputeProject(tx, projectId);
    if (entityType === 'task' && oldProjectId && oldProjectId !== projectId) {
      await this.recomputeProject(tx, oldProjectId);
      await tx.timelineEvent.create({ data: { projectId: oldProjectId, eventType: 'TASK_MOVED', title: 'Task moved out of project', sourceMessageId, metadataJson: { entityId: String(entity.id), operationId, projectId } } });
    }
  }

  private async recomputeProject(tx: Prisma.TransactionClient, projectId: string) {
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { status: true, version: true, waitingOn: true, waitingParties: true, replyRequired: true, followUpAt: true } });
    if (!project) return;
    if (project.status === 'deleted') throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
    const tasks = await tx.task.findMany({ where: { projectId, status: { notIn: ['done', 'cancelled'] } }, select: { status: true, kind: true, ownerType: true, waitingOn: true, deadlineAt: true } });
    const { waitingOn, waitingParties, replyRequired, followUpAt } = deriveProjectState(tasks);
    if (project.waitingOn === waitingOn && JSON.stringify(project.waitingParties) === JSON.stringify(waitingParties) && project.replyRequired === replyRequired && project.followUpAt?.getTime() === followUpAt?.getTime()) return;
    const changed = await tx.project.updateMany({ where: { id: projectId, version: project.version }, data: { waitingOn, waitingParties, replyRequired, followUpAt, version: { increment: 1 } } });
    if (!changed.count) throw new ConflictException({ code: 'PROJECT_STATE_CONFLICT', message: 'Retry the business operation' });
    await tx.timelineEvent.create({ data: { projectId, eventType: 'PROJECT_STATE_UPDATED', title: 'Project waiting state updated', metadataJson: { waitingOn, waitingParties, replyRequired, followUpAt: followUpAt?.toISOString() ?? null } } });
  }

  private async readSummary(entityType: string, entityId: string) { return this.readSummaryTx(this.prisma, entityType, entityId); }
  private async readSummaryTx(tx: Prisma.TransactionClient | PrismaService, entityType: string, entityId: string) {
    const summary = await tx.summary.findUnique({ where: { entityType_entityId: { entityType, entityId } }, include: { versions: { orderBy: { version: 'desc' }, take: 20 } } });
    const current = summary?.currentVersionId ? summary.versions.find((version) => version.id === summary.currentVersionId) ?? await tx.summaryVersion.findUnique({ where: { id: summary.currentVersionId } }) : null;
    const coverage = summary?.coverageJson && typeof summary.coverageJson === 'object' && !Array.isArray(summary.coverageJson) ? summary.coverageJson as Record<string, unknown> : null;
    return { summaryId: summary?.id ?? null, entityType, entityId, version: summary?.version ?? 0, summary: current?.newSummary ?? null, currentVersionId: summary?.currentVersionId ?? null, isDerived: summary?.isDerived ?? false, manualOverride: summary?.manualOverride ?? false, inputHash: summary?.inputHash ?? null, coverage, stale: coverage?.stale === true, versions: summary?.versions ?? [] };
  }
  private async readSummaryByIdTx(tx: Prisma.TransactionClient, id: string) {
    const summary = await tx.summary.findUnique({ where: { id } });
    if (!summary) throw new NotFoundException('Summary not found');
    return this.readSummaryTx(tx, summary.entityType, summary.entityId);
  }
  private async assertSummaryEntity(tx: Prisma.TransactionClient | PrismaService, type: string, id: string, accountId: string) {
    let where: { id: string } | null;
    if (type === 'project') {
      where = await tx.project.findFirst({ where: { id, status: { not: 'deleted' }, OR: [{ messages: { some: { mailAccountId: accountId } } }, { messages: { none: {} } }] }, select: { id: true } });
    } else if (type === 'topic') {
      where = await tx.topic.findFirst({ where: { id, project: { status: { not: 'deleted' } }, OR: [{ project: { messages: { some: { mailAccountId: accountId } } } }, { project: { messages: { none: {} } } }] }, select: { id: true } });
    } else {
      where = await tx.emailMessage.findFirst({ where: { mailAccountId: accountId, threadId: id }, select: { id: true } });
    }
    if (!where) throw new NotFoundException('Summary entity not found in mailbox scope');
  }
  private async lockSummaryProject(tx: Prisma.TransactionClient, type: string, id: string) {
    if (type === 'project') return lockProjectsForWrite(tx, [id]);
    if (type !== 'topic') return;
    const topic = await tx.topic.findUnique({ where: { id }, select: { projectId: true } });
    if (!topic) throw new NotFoundException('Summary entity not found');
    await lockProjectsForWrite(tx, [topic.projectId]);
  }
  private async lockMutationProjects(tx: Prisma.TransactionClient, projectIds: Array<string | null>, topicIds: Array<string | null>) {
    const ids = projectIds.filter((id): id is string => Boolean(id));
    const uniqueTopicIds = [...new Set(topicIds.filter((id): id is string => Boolean(id)))];
    if (uniqueTopicIds.length) {
      const topics = await tx.topic.findMany({ where: { id: { in: uniqueTopicIds } }, select: { projectId: true } });
      ids.push(...topics.map((topic) => topic.projectId));
    }
    await lockProjectsForWrite(tx, ids);
  }
  private entityMessageFilter(type: string, id: string, accountId: string, date: Date): Prisma.EmailMessageWhereInput {
    const scope = type === 'project' ? { projectId: id } : type === 'topic' ? { topicId: id } : { threadId: id };
    return { ...scope, mailAccountId: accountId, OR: [{ sentAt: { gt: date } }, { sentAt: null, receivedAt: { gt: date } }] };
  }
  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY' });
    return account;
  }
  private rejectExtra(body: Record<string, unknown>, allowed: string[]) { for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new BadRequestException(`Unsupported field ${key}`); }
  private text(value: unknown, name: string, max: number) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new BadRequestException(`${name} is required`); return value.trim(); }
  private integer(value: unknown, name: string, min: number, max: number) { if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new BadRequestException(`Invalid ${name}`); return value; }
  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (isConcurrentWriteError(error)) throw new ConflictException({ code: 'CONCURRENT_UPDATE', message: 'Concurrent update detected; reload the latest version and retry' });
      throw error;
    }
  }
}
