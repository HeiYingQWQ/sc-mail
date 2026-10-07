import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Task } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { ContactResolverService } from './contact-resolver.service';
import { ProjectReviewService } from './project-review.service';
import { SummaryTimelineService } from './summary-timeline.service';
import { ANALYSIS_SCHEMA_VERSION } from '../ai/analysis.schema';
import { nextWaitingSince } from './task-waiting.policy';
import { lockProjectsForWrite } from './project-lifecycle.guard';
import { isConcurrentWriteError } from './business-operation';

const TASK_STATUSES = ['open', 'in_progress', 'waiting', 'done', 'cancelled'];
const TASK_KINDS = ['action', 'reply', 'confirmation'];
const WAITING_ON = ['us', 'customer', 'third_party', 'mixed', 'none'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const REQUIREMENT_STATUSES = ['open', 'accepted', 'rejected'];
const DECISION_STATUSES = ['proposed', 'accepted', 'rejected'];

type MutationInput = {
  operationId: string;
  sourceOperationId?: string;
  actorId: string;
  entityType: 'task' | 'requirement' | 'decision' | 'email_message';
  entityId: string;
  action: string;
  sourceMessageId: string | null;
  before: unknown;
  after: unknown;
  hashValue: unknown;
  analysisRunId?: string;
  taskOutcome?: string;
  evidence?: string;
};

@Injectable()
export class BusinessRecordsService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly contacts: ContactResolverService,
    private readonly projects: ProjectReviewService,
    private readonly summaries: SummaryTimelineService,
  ) {}

  async listTasks(limit: number, offset: number, filters: { status?: string; projectId?: string; topicId?: string }) {
    if (filters.status && filters.status !== 'active' && !TASK_STATUSES.includes(filters.status)) throw new BadRequestException('Invalid task status filter');
    const account = await this.account();
    const where: Prisma.TaskWhereInput = {
      ...(filters.status ? { status: filters.status === 'active' ? { in: ['open', 'in_progress', 'waiting'] } : filters.status } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.topicId ? { topicId: filters.topicId } : {}),
      OR: [
        { createdFromMessage: { mailAccountId: account.id } },
        { project: { messages: { some: { mailAccountId: account.id } } } },
        { project: { messages: { none: {} } } },
        { projectId: null, topicId: null, createdFromMessageId: null },
      ],
    };
    const [total, tasks] = await this.prisma.$transaction([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({ where, orderBy: [{ deadlineAt: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset, include: { project: { select: { id: true, name: true } }, evidence: { orderBy: { createdAt: 'desc' }, take: 3, include: { sourceMessage: { select: { id: true, subject: true, sentAt: true, receivedAt: true } } } } } }),
    ]);
    return { total, offset, limit, tasks };
  }

  async getTask(id: string) {
    const account = await this.account();
    const task = await this.prisma.task.findFirst({
      where: { id, OR: [{ createdFromMessage: { mailAccountId: account.id } }, { project: { messages: { some: { mailAccountId: account.id } } } }, { project: { messages: { none: {} } } }, { projectId: null, topicId: null, createdFromMessageId: null }] },
      include: { project: { select: { id: true, name: true } }, topic: { select: { id: true, name: true } }, createdFromMessage: { select: { id: true, subject: true, receivedAt: true, sentAt: true } }, completedFromMessage: { select: { id: true, subject: true } }, evidence: { orderBy: { createdAt: 'desc' }, take: 20, include: { sourceMessage: { select: { id: true, subject: true, sentAt: true, receivedAt: true } } } } },
    });
    if (!task) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Task not found' });
    return task;
  }

  async createTask(body: Record<string, unknown>) {
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const actorId = 'api-token-client';
    const data = this.manualTaskData(body, true);
    const account = await this.account();
    await this.assertScope(data.projectId, data.topicId, null, account.id);
    const hashValue = { action: 'create', ...data };
    return this.mutate({ operationId, actorId, entityType: 'task', entityId: '', action: 'create', sourceMessageId: null, before: null, after: hashValue, hashValue }, async (tx, sourceOperationId) => {
      await this.lockScopeForWrite(tx, [{ projectId: data.projectId as string | null, topicId: data.topicId as string | null }]);
      await this.assertScope(data.projectId, data.topicId, null, account.id, tx);
      const waitingSince = nextWaitingSince({ status: 'open', waitingOn: 'none', waitingSince: null }, data);
      const task = await tx.task.create({ data: { ...data, waitingSince, origin: 'user', createdBy: actorId, sourceOperationId, ...(data.status === 'done' ? { completedAt: new Date() } : {}) } });
      return task;
    });
  }

  async updateTask(id: string, body: Record<string, unknown>) {
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const expectedVersion = this.integer(body.expectedVersion, 'expectedVersion', 1, 2_147_483_647);
    const data = this.manualTaskData(body, false);
    if (!Object.keys(data).length) throw new BadRequestException('At least one task field must be updated');
    const hashValue = { action: 'update', id, expectedVersion, data };
    const replay = await this.replay<Task>(operationId, hashValue, 'task');
    if (replay) return replay;
    const account = await this.account();
    const current = await this.taskInAccount(id, account.id);
    if (current.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: current.version });
    const merged = { ...current, ...data };
    this.validateTaskState(merged);
    await this.assertScope(merged.projectId, merged.topicId, null, account.id);
    const waitingSince = nextWaitingSince(current, data);
    return this.mutate({ operationId, actorId: 'api-token-client', entityType: 'task', entityId: id, action: 'update', sourceMessageId: null, before: current, after: data, hashValue }, async (tx) => {
      await this.lockScopeForWrite(tx, [
        { projectId: current.projectId, topicId: current.topicId },
        { projectId: merged.projectId, topicId: merged.topicId },
      ]);
      await this.assertScope(merged.projectId, merged.topicId, null, account.id, tx);
      const changed = await tx.task.updateMany({
        where: { id, version: expectedVersion },
        data: { ...data, waitingSince, version: { increment: 1 }, manualOverride: true, ...(data.status === 'done' ? { completedAt: new Date(), completedFromMessageId: null } : data.status && data.status !== 'done' ? { completedAt: null, completedFromMessageId: null } : {}) },
      });
      if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      return tx.task.findUniqueOrThrow({ where: { id } });
    });
  }

  async listRequirements(limit: number, offset: number, projectId?: string, topicId?: string) {
    const account = await this.account();
    const where: Prisma.RequirementWhereInput = {
      ...(projectId ? { projectId } : {}), ...(topicId ? { topicId } : {}),
      OR: [{ sourceMessage: { mailAccountId: account.id } }, { project: { messages: { some: { mailAccountId: account.id } } } }, { project: { messages: { none: {} } } }, { projectId: null, topicId: null, sourceMessageId: null }],
    };
    const [total, requirements] = await this.prisma.$transaction([this.prisma.requirement.count({ where }), this.prisma.requirement.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset })]);
    return { total, offset, limit, requirements };
  }

  async listDecisions(limit: number, offset: number, projectId?: string, topicId?: string) {
    const account = await this.account();
    const where: Prisma.DecisionWhereInput = {
      ...(projectId ? { projectId } : {}), ...(topicId ? { topicId } : {}),
      OR: [{ sourceMessage: { mailAccountId: account.id } }, { project: { messages: { some: { mailAccountId: account.id } } } }, { project: { messages: { none: {} } } }, { projectId: null, topicId: null, sourceMessageId: null }],
    };
    const [total, decisions] = await this.prisma.$transaction([this.prisma.decision.count({ where }), this.prisma.decision.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset })]);
    return { total, offset, limit, decisions };
  }

  async createRequirement(body: Record<string, unknown>) {
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const data = this.simpleFactData(body, 'requirement');
    const account = await this.account();
    await this.assertScope(data.projectId, data.topicId, data.sourceMessageId, account.id);
    const hashValue = { action: 'create', ...data };
    return this.mutate({ operationId, actorId: 'api-token-client', entityType: 'requirement', entityId: '', action: 'create', sourceMessageId: data.sourceMessageId, before: null, after: hashValue, hashValue }, async (tx, sourceOperationId) => {
      await this.lockScopeForWrite(tx, [{ projectId: data.projectId as string | null, topicId: data.topicId as string | null }]);
      await this.assertScope(data.projectId, data.topicId, data.sourceMessageId, account.id, tx);
      return tx.requirement.create({ data: { ...data, createdBy: 'api-token-client', sourceOperationId } });
    });
  }

  async updateRequirement(id: string, body: Record<string, unknown>) {
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const expectedVersion = this.integer(body.expectedVersion, 'expectedVersion', 1, 2_147_483_647);
    const data = this.factUpdateData(body, 'requirement');
    const hashValue = { action: 'update', id, expectedVersion, data };
    const replay = await this.replay(operationId, hashValue, 'requirement');
    if (replay) return replay;
    const current = await this.requirementInAccount(id);
    if (current.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: current.version });
    return this.mutate({ operationId, actorId: 'api-token-client', entityType: 'requirement', entityId: id, action: 'update', sourceMessageId: null, before: current, after: data, hashValue }, async (tx) => {
      await this.lockScopeForWrite(tx, [{ projectId: current.projectId, topicId: current.topicId }, { projectId: Object.hasOwn(data, 'projectId') ? data.projectId as string | null : current.projectId, topicId: Object.hasOwn(data, 'topicId') ? data.topicId as string | null : current.topicId }]);
      const changed = await tx.requirement.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 }, manualOverride: true } });
      if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      return tx.requirement.findUniqueOrThrow({ where: { id } });
    });
  }

  async createDecision(body: Record<string, unknown>) {
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const data = this.simpleFactData(body, 'decision');
    const account = await this.account();
    await this.assertScope(data.projectId, data.topicId, data.sourceMessageId, account.id);
    const hashValue = { action: 'create', ...data };
    return this.mutate({ operationId, actorId: 'api-token-client', entityType: 'decision', entityId: '', action: 'create', sourceMessageId: data.sourceMessageId, before: null, after: hashValue, hashValue }, async (tx, sourceOperationId) => {
      await this.lockScopeForWrite(tx, [{ projectId: data.projectId as string | null, topicId: data.topicId as string | null }]);
      await this.assertScope(data.projectId, data.topicId, data.sourceMessageId, account.id, tx);
      return tx.decision.create({ data: { ...data, createdBy: 'api-token-client', sourceOperationId, decidedAt: ['accepted', 'rejected'].includes(data.status) ? new Date() : null } });
    });
  }

  async updateDecision(id: string, body: Record<string, unknown>) {
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const expectedVersion = this.integer(body.expectedVersion, 'expectedVersion', 1, 2_147_483_647);
    const data = this.factUpdateData(body, 'decision');
    const hashValue = { action: 'update', id, expectedVersion, data };
    const replay = await this.replay(operationId, hashValue, 'decision');
    if (replay) return replay;
    const current = await this.decisionInAccount(id);
    if (current.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: current.version });
    return this.mutate({ operationId, actorId: 'api-token-client', entityType: 'decision', entityId: id, action: 'update', sourceMessageId: null, before: current, after: data, hashValue }, async (tx) => {
      await this.lockScopeForWrite(tx, [{ projectId: current.projectId, topicId: current.topicId }, { projectId: Object.hasOwn(data, 'projectId') ? data.projectId as string | null : current.projectId, topicId: Object.hasOwn(data, 'topicId') ? data.topicId as string | null : current.topicId }]);
      const changed = await tx.decision.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 }, manualOverride: true, ...(data.status ? { decidedAt: ['accepted', 'rejected'].includes(String(data.status)) ? new Date() : null } : {}) } });
      if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      return tx.decision.findUniqueOrThrow({ where: { id } });
    });
  }

  async applyAnalysis(runId: string, body: Record<string, unknown>) {
    for (const field of Object.keys(body)) if (!['operationId', 'operationIndexes'].includes(field)) throw new BadRequestException(`Unsupported analysis apply field ${field}`);
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    if (!Array.isArray(body.operationIndexes) || body.operationIndexes.length === 0 || body.operationIndexes.length > 20 || body.operationIndexes.some((index) => !Number.isInteger(index) || (index as number) < 0)) {
      throw new BadRequestException('operationIndexes must be a non-empty array of operation indexes');
    }
    const account = await this.account();
    const run = await this.prisma.analysisRun.findFirst({ where: { id: runId, mailAccountId: account.id }, include: { sourceMessage: true } });
    if (!run) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Analysis run not found' });
    if (run.status !== 'completed' || run.schemaVersion !== ANALYSIS_SCHEMA_VERSION || run.validationStatus !== 'valid' || !run.resultJson || run.errorCode) {
      throw new ConflictException({ code: 'ANALYSIS_NOT_APPLICABLE', message: 'Only fully validated successful analysis can be applied' });
    }
    const result = run.resultJson as unknown as { operations?: Array<Record<string, unknown>> };
    const indices = [...new Set(body.operationIndexes as number[])].sort((a, b) => a - b);
    const selected = indices.map((index) => ({ index, operation: result.operations?.[index] })).filter(({ operation }) => operation);
    if (selected.length !== indices.length || selected.some(({ operation }) => !['task', 'requirement', 'decision'].includes(String(operation?.entity_type)))) {
      throw new BadRequestException('Select existing task, requirement, or decision operations only');
    }
    const records = [];
    for (const { index, operation } of selected) {
      const opId = `analysis:${run.sourceMessageId}:${this.hash(operation).slice(0, 32)}`;
      const data = this.analysisOperationData(operation!, run.sourceMessage);
      const hashValue = { sourceMessageId: run.sourceMessageId, operation };
      const input: MutationInput = {
        operationId: `${operationId}:${index}`, sourceOperationId: opId, actorId: 'ai-analysis', entityType: operation!.entity_type as MutationInput['entityType'],
        entityId: typeof operation!.target_id === 'string' ? operation!.target_id : '', action: String(operation!.action),
        sourceMessageId: run.sourceMessageId, before: null, after: operation, hashValue, analysisRunId: run.id,
        taskOutcome: typeof operation!.task_outcome === 'string' ? operation!.task_outcome : undefined,
        evidence: typeof operation!.evidence === 'string' ? operation!.evidence : undefined,
      };
      const record = await this.mutate(input, async (tx, sourceOperationId) => {
        await this.assertAnalysisSourceFresh(run.sourceMessage, account.id, tx);
        await this.lockScopeForWrite(tx, [{ projectId: data.projectId as string | null, topicId: data.topicId as string | null }]);
        await this.assertScope(data.projectId, data.topicId, run.sourceMessageId, account.id, tx);
        if (input.entityType === 'task') return this.applyTaskOperation(tx, data, operation!, sourceOperationId, run.sourceMessageId);
        if (input.entityType === 'requirement') return this.applyRequirementOperation(tx, data, operation!, sourceOperationId, run.sourceMessageId);
        return this.applyDecisionOperation(tx, data, operation!, sourceOperationId, run.sourceMessageId);
      });
      records.push({ index, entityType: input.entityType, ...record });
    }
    return { analysisRunId: run.id, operationId, applied: records.length, records };
  }

  async promoteCampaignReply(messageId: string, body: Record<string, unknown>) {
    for (const field of Object.keys(body)) if (field !== 'operationId') throw new BadRequestException(`Unsupported promotion field ${field}`);
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const account = await this.account();
    const message = await this.prisma.emailMessage.findFirst({ where: { id: messageId, mailAccountId: account.id } });
    if (!message) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Email message not found' });
    const sourceOperationId = `outreach-promotion:${message.id}`;
    const hashValue = { action: 'promote_outreach_reply', messageId: message.id };
    const prior = await this.prisma.businessOperation.findFirst({ where: { OR: [{ operationId }, { sourceOperationId }] } });
    if (prior) {
      if (prior.inputHash !== this.hash(hashValue) || prior.entityType !== 'email_message') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      return this.prisma.emailMessage.findUniqueOrThrow({ where: { id: prior.entityId } });
    }
    if (message.direction !== 'inbound' || message.classification !== 'BUSINESS_HUMAN' || message.campaignRole !== 'reply') {
      throw new ConflictException({ code: 'NOT_A_HUMAN_CAMPAIGN_REPLY' });
    }
    if (message.promotionStatus !== 'eligible') {
      throw new ConflictException({ code: 'OUTREACH_REPLY_NOT_ELIGIBLE', promotionStatus: message.promotionStatus });
    }
    const contactResult = await this.contacts.resolveImported([message.id]);
    const projectResult = await this.projects.resolveImported([message.id]);
    if (contactResult.status === 'running' || projectResult.status === 'running') {
      throw new ConflictException({ code: 'PROMOTION_BUSY', message: 'Retry promotion after the mailbox resolver finishes' });
    }
    const resolved = await this.prisma.emailMessage.findUniqueOrThrow({ where: { id: message.id } });
    const needsReview = ['ambiguous', 'provisional', 'unresolved'].includes(resolved.contactResolutionStatus)
      || ['review_pending', 'unresolved'].includes(resolved.projectResolutionStatus)
      || resolved.topicResolutionStatus === 'unresolved';
    const nextStatus = needsReview ? 'review_required' : 'promoted';
    const hash = this.hash(hashValue);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const already = await tx.businessOperation.findFirst({ where: { OR: [{ operationId }, { sourceOperationId }] } });
        if (already) {
          if (already.inputHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          return tx.emailMessage.findUniqueOrThrow({ where: { id: already.entityId } });
        }
        const updated = await tx.emailMessage.updateMany({ where: { id: message.id, mailAccountId: account.id, promotionStatus: 'eligible' }, data: { promotionStatus: nextStatus } });
        const after = await tx.emailMessage.findUniqueOrThrow({ where: { id: message.id } });
        if (!updated.count && !['promoted', 'review_required'].includes(after.promotionStatus)) throw new ConflictException({ code: 'OUTREACH_REPLY_NOT_ELIGIBLE', promotionStatus: after.promotionStatus });
        await tx.businessOperation.create({ data: {
          operationId, sourceOperationId, inputHash: hash, entityType: 'email_message', entityId: message.id,
          action: 'promote_outreach_reply', actorId: 'api-token-client', sourceMessageId: message.id,
          beforeJson: { id: message.id, promotionStatus: message.promotionStatus, contactResolutionStatus: message.contactResolutionStatus, projectResolutionStatus: message.projectResolutionStatus },
          afterJson: { id: after.id, promotionStatus: after.promotionStatus, contactResolutionStatus: after.contactResolutionStatus, projectResolutionStatus: after.projectResolutionStatus },
        } });
        return after;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isConcurrentWriteError(error)) throw new ConflictException({ code: 'CONCURRENT_UPDATE', message: 'Concurrent update detected; reload and retry' });
      if (!this.isUniqueConflict(error)) throw error;
      const prior = await this.prisma.businessOperation.findFirst({ where: { OR: [{ operationId }, { sourceOperationId }] } });
      if (prior && prior.inputHash === hash) return this.prisma.emailMessage.findUniqueOrThrow({ where: { id: prior.entityId } });
      throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
    }
  }

  private async applyTaskOperation(tx: Prisma.TransactionClient, data: Record<string, unknown>, operation: Record<string, unknown>, sourceOperationId: string, sourceMessageId: string) {
    const { projectId, topicId, ...taskData } = data;
    const changes = this.mapTaskChanges(taskData);
    let task: Task;
    if (operation.action === 'create') {
      const waitingSince = nextWaitingSince({ status: 'open', waitingOn: 'none', waitingSince: null }, changes as { status?: string; waitingOn?: string });
      task = await tx.task.create({ data: { ...changes as unknown as Prisma.TaskUncheckedCreateInput, waitingSince, projectId: projectId as string | null, topicId: topicId as string | null, origin: 'email', createdFromMessageId: sourceMessageId, createdBy: 'ai-analysis', sourceOperationId } });
    } else {
      const id = this.requiredText(operation.target_id, 'target_id', 100);
      const current = await tx.task.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Task target not found');
      if (current.projectId !== (projectId as string | null)) throw new ConflictException({ code: 'TARGET_SCOPE_CHANGED' });
      if (current.manualOverride) throw new ConflictException({ code: 'MANUAL_OVERRIDE_PROTECTED' });
      if (['done', 'cancelled'].includes(current.status)) throw new ConflictException({ code: 'TASK_ALREADY_CLOSED' });
      if (operation.action === 'complete' || operation.action === 'cancel') {
        changes.status = operation.action === 'complete' ? 'done' : 'cancelled';
        changes.completedAt = operation.action === 'complete' ? new Date() : null;
        changes.completedFromMessageId = operation.action === 'complete' ? sourceMessageId : null;
      } else if (changes.status === 'done') {
        changes.completedAt = new Date();
        changes.completedFromMessageId = sourceMessageId;
      } else if (changes.status !== undefined && changes.status !== current.status) {
        changes.completedAt = null;
        changes.completedFromMessageId = null;
      }
      const waitingSince = nextWaitingSince(current, changes as { status?: string; waitingOn?: string });
      const result = await tx.task.updateMany({ where: { id, version: current.version, manualOverride: false }, data: { ...changes, waitingSince, version: { increment: 1 } } });
      if (!result.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      task = await tx.task.findUniqueOrThrow({ where: { id } });
    }
    const outcome = operation.task_outcome;
    if (['acknowledged', 'planned', 'partial', 'completed'].includes(String(outcome))) {
      await tx.taskEvidence.create({ data: { taskId: task.id, sourceMessageId, evidenceType: String(outcome), excerpt: String(operation.evidence), confidence: Number(operation.confidence) } });
    }
    return task;
  }

  private async applyRequirementOperation(tx: Prisma.TransactionClient, data: Record<string, unknown>, operation: Record<string, unknown>, sourceOperationId: string, sourceMessageId: string) {
    if (operation.action === 'create') return tx.requirement.create({ data: { projectId: data.projectId as string | null, topicId: data.topicId as string | null, text: String(data.text), status: String(data.status ?? 'open'), sourceMessageId, sourceOperationId, createdBy: 'ai-analysis' } });
    if (operation.action !== 'update') throw new BadRequestException('Unsupported requirement action');
    const id = this.requiredText(operation.target_id, 'target_id', 100);
    const current = await tx.requirement.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Requirement target not found');
    if (current.projectId !== (data.projectId as string | null)) throw new ConflictException({ code: 'TARGET_SCOPE_CHANGED' });
    if (current.manualOverride) throw new ConflictException({ code: 'MANUAL_OVERRIDE_PROTECTED' });
    const changed = await tx.requirement.updateMany({ where: { id, version: current.version, manualOverride: false }, data: { ...(data.text !== undefined ? { text: String(data.text) } : {}), ...(data.status !== undefined ? { status: String(data.status) } : {}), version: { increment: 1 } } });
    if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
    return tx.requirement.findUniqueOrThrow({ where: { id } });
  }

  private async applyDecisionOperation(tx: Prisma.TransactionClient, data: Record<string, unknown>, operation: Record<string, unknown>, sourceOperationId: string, sourceMessageId: string) {
    if (operation.action === 'create') return tx.decision.create({ data: { projectId: data.projectId as string | null, topicId: data.topicId as string | null, text: String(data.text), status: String(data.status ?? 'proposed'), sourceMessageId, sourceOperationId, createdBy: 'ai-analysis', decidedAt: ['accepted', 'rejected'].includes(String(data.status)) ? new Date() : null } });
    if (operation.action !== 'update') throw new BadRequestException('Unsupported decision action');
    const id = this.requiredText(operation.target_id, 'target_id', 100);
    const current = await tx.decision.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Decision target not found');
    if (current.projectId !== (data.projectId as string | null)) throw new ConflictException({ code: 'TARGET_SCOPE_CHANGED' });
    if (current.manualOverride) throw new ConflictException({ code: 'MANUAL_OVERRIDE_PROTECTED' });
    const status = typeof data.status === 'string' ? data.status : undefined;
    const changed = await tx.decision.updateMany({ where: { id, version: current.version, manualOverride: false }, data: { ...(data.text !== undefined ? { text: String(data.text) } : {}), ...(status !== undefined ? { status, decidedAt: ['accepted', 'rejected'].includes(status) ? new Date() : null } : {}), version: { increment: 1 } } });
    if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
    return tx.decision.findUniqueOrThrow({ where: { id } });
  }

  private async mutate<T>(input: MutationInput, execute: (tx: Prisma.TransactionClient, sourceOperationId: string) => Promise<T>): Promise<T> {
    const inputHash = this.hash(input.hashValue);
    const sourceOperationId = input.sourceOperationId ?? input.operationId;
    const existing = await this.prisma.businessOperation.findFirst({ where: { OR: [{ operationId: input.operationId }, { sourceOperationId }] } });
    if (existing) {
      if (existing.inputHash !== inputHash || existing.entityType !== input.entityType) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      return this.findEntity(existing.entityType, existing.entityId) as Promise<T>;
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const raced = await tx.businessOperation.findFirst({ where: { OR: [{ operationId: input.operationId }, { sourceOperationId }] } });
        if (raced) {
          if (raced.inputHash !== inputHash || raced.entityType !== input.entityType) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          return this.findEntityTx(tx, raced.entityType, raced.entityId) as Promise<T>;
        }
        let reused: unknown = null;
        if (input.analysisRunId && input.action === 'create') {
          const facts = await tx.businessOperation.findMany({ where: { sourceMessageId: input.sourceMessageId, actorId: 'ai-analysis', entityType: input.entityType, action: 'create' } });
          const signature = this.analysisFactSignature(input.after);
          const matching = facts.filter(fact => this.analysisFactSignature((fact.afterJson as any)?.analysisProposal) === signature);
          if (matching.length === 1) reused = await this.findEntityTx(tx, input.entityType, matching[0].entityId);
          else if (matching.length > 1 || facts.some(fact => (fact.afterJson as any)?.analysisRunId !== input.analysisRunId)) {
            throw new ConflictException({ code: 'FACT_REANALYSIS_REVIEW_REQUIRED', sourceMessageId: input.sourceMessageId, candidateIds: [...new Set(facts.map(fact => fact.entityId))] });
          }
        }
        const result = reused ? reused as T : await execute(tx, sourceOperationId);
        const entityId = this.entityId(result);
        if (!reused && ['task', 'requirement', 'decision'].includes(input.entityType)) {
          await this.summaries.recordBusinessMutation(tx, input.entityType, input.action, result as Record<string, unknown>, input.sourceMessageId, input.operationId, input.taskOutcome, input.before);
          const entity = result as Record<string, unknown>;
          const eventType = input.entityType === 'task' ? (entity.status === 'done' ? 'TASK_COMPLETED' : input.action === 'create' ? 'TASK_CREATED' : 'TASK_UPDATED') : input.entityType === 'requirement' ? (input.action === 'create' ? 'REQUIREMENT_ADDED' : 'REQUIREMENT_UPDATED') : input.action === 'create' ? 'DECISION_ADDED' : 'DECISION_UPDATED';
          const notificationPolicy = input.entityType === 'task' && entity.status === 'done' ? 'REALTIME' : input.entityType === 'decision' ? 'REVIEW' : 'DIGEST';
          const agentEvent = await tx.agentEvent.create({ data: {
            eventKey: `business-operation:${input.operationId}`, eventType, entityType: input.entityType, entityId,
            priority: notificationPolicy === 'REALTIME' ? 10 : notificationPolicy === 'REVIEW' ? 5 : 0,
            notificationPolicy, payloadJson: {
              eventType, entityType: input.entityType, entityId,
              projectId: typeof entity.projectId === 'string' ? entity.projectId : null,
              sourceMessageId: input.sourceMessageId,
              title: typeof entity.title === 'string' ? entity.title.slice(0, 200) : typeof entity.text === 'string' ? entity.text.slice(0, 200) : null,
              status: typeof entity.status === 'string' ? entity.status : null,
            },
          } });
          await tx.agentWakeupDelivery.create({ data: { eventId: agentEvent.id } });
        }
        await tx.businessOperation.create({ data: {
          operationId: input.operationId, sourceOperationId, inputHash, entityType: input.entityType, entityId, action: input.action,
          actorId: input.actorId, sourceMessageId: input.sourceMessageId,
          beforeJson: input.before === null ? Prisma.JsonNull : input.before as Prisma.InputJsonValue,
          afterJson: this.jsonSafe(input.analysisRunId ? { ...(result as object), analysisRunId: input.analysisRunId, analysisProposal: input.after } : result) as Prisma.InputJsonValue,
        } });
        return result;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof ConflictException && (error.getResponse() as any)?.code === 'FACT_REANALYSIS_REVIEW_REQUIRED') {
        const dedupeKey = `analysis-fact:${input.analysisRunId}:${input.operationId}`;
        await this.prisma.reviewItem.upsert({ where: { dedupeKey }, update: {}, create: {
          entityType: 'email_message', entityId: input.sourceMessageId!, sourceMessageId: input.sourceMessageId,
          reasonCode: 'FACT_REANALYSIS_REVIEW_REQUIRED', confidence: 0,
          dedupeKeyBase: dedupeKey, dedupeKey, proposedChangeJson: this.jsonSafe({ analysisRunId: input.analysisRunId, operation: input.after, candidates: (error.getResponse() as any).candidateIds }),
        } });
      }
      if (isConcurrentWriteError(error)) throw new ConflictException({ code: 'CONCURRENT_UPDATE', message: 'Concurrent update detected; reload and retry' });
      if (!this.isUniqueConflict(error)) throw error;
      const raced = await this.prisma.businessOperation.findFirst({ where: { OR: [{ operationId: input.operationId }, { sourceOperationId }] } });
      if (raced && raced.inputHash === inputHash && raced.entityType === input.entityType) return this.findEntity(raced.entityType, raced.entityId) as Promise<T>;
      throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
    }
  }

  private analysisFactSignature(operation: unknown): string | null {
    if (!operation || typeof operation !== 'object') return null;
    const normalize = (value: any): any => {
      if (typeof value === 'string') return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(key => key !== 'confidence').sort().map(key => [key, normalize(value[key])]));
      return value;
    };
    return JSON.stringify(normalize(operation));
  }

  private async replay<T>(operationId: string, value: unknown, entityType: string): Promise<T | null> {
    const existing = await this.prisma.businessOperation.findUnique({ where: { operationId } });
    if (!existing) return null;
    if (existing.inputHash !== this.hash(value) || existing.entityType !== entityType) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
    return this.findEntity(existing.entityType, existing.entityId) as Promise<T>;
  }

  private async findEntity(type: string, id: string): Promise<unknown> {
    const where = { where: { id } };
    if (type === 'task') return this.prisma.task.findUniqueOrThrow(where);
    if (type === 'requirement') return this.prisma.requirement.findUniqueOrThrow(where);
    if (type === 'email_message') return this.prisma.emailMessage.findUniqueOrThrow(where);
    return this.prisma.decision.findUniqueOrThrow(where);
  }

  private async findEntityTx(tx: Prisma.TransactionClient, type: string, id: string): Promise<unknown> {
    const where = { where: { id } };
    if (type === 'task') return tx.task.findUniqueOrThrow(where);
    if (type === 'requirement') return tx.requirement.findUniqueOrThrow(where);
    if (type === 'email_message') return tx.emailMessage.findUniqueOrThrow(where);
    return tx.decision.findUniqueOrThrow(where);
  }

  private entityId(result: unknown): string {
    if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string') throw new Error('BUSINESS_ENTITY_ID_MISSING');
    return result.id;
  }

  private jsonSafe(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)) as Prisma.InputJsonValue;
  }

  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

  private manualTaskData(body: Record<string, unknown>, creating: boolean) {
    const output: Record<string, unknown> = {};
    const fields = ['title', 'description', 'kind', 'ownerType', 'ownerId', 'waitingOn', 'status', 'priority', 'deadlineAt', 'deadlineDate', 'deadlineTimezone', 'deadlineText', 'projectId', 'topicId'];
    for (const field of Object.keys(body)) if (![...fields, 'operationId', 'expectedVersion'].includes(field)) throw new BadRequestException(`Unsupported task field ${field}`);
    for (const field of fields) {
      if (!(field in body) || (!creating && body[field] === undefined)) continue;
      const value = body[field];
      const optionalText = ['description', 'ownerType', 'ownerId', 'deadlineAt', 'deadlineDate', 'deadlineTimezone', 'deadlineText', 'projectId', 'topicId'].includes(field);
      if (value === null && optionalText) { output[field] = null; continue; }
      if (['kind', 'status', 'waitingOn', 'priority'].includes(field)) {
        const allowed = field === 'kind' ? TASK_KINDS : field === 'status' ? TASK_STATUSES : field === 'priority' ? PRIORITIES : WAITING_ON;
        if (typeof value !== 'string' || !allowed.includes(value)) throw new BadRequestException(`Invalid ${field}`);
        output[field] = value;
      } else if (field === 'deadlineAt') {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new BadRequestException('deadlineAt must be an ISO timestamp with offset');
        output.deadlineAt = new Date(value);
      } else if (['deadlineDate'].includes(field)) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || (!Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)) throw new BadRequestException('deadlineDate must be YYYY-MM-DD');
        output.deadlineDate = value;
      } else if (optionalText) {
        if (typeof value !== 'string' || value.trim().length > 2000) throw new BadRequestException(`Invalid ${field}`);
        if (field === 'ownerType' && value && !['us', 'customer', 'third_party', 'mixed', 'none'].includes(value)) throw new BadRequestException('Invalid ownerType');
        output[field] = value.trim() || null;
      } else {
        const text = this.requiredText(value, field, field === 'title' ? 300 : 200);
        output[field] = text;
      }
    }
    if (creating && !output.title) throw new BadRequestException('title is required');
    if (creating) this.validateTaskState(output);
    return output as Prisma.TaskUncheckedCreateInput;
  }

  private validateTaskState(output: Record<string, unknown>) {
    if (output.topicId && !output.projectId) throw new BadRequestException('projectId is required with topicId');
    if (output.deadlineDate && !output.deadlineTimezone) throw new BadRequestException('deadlineTimezone is required with deadlineDate');
    if (output.deadlineTimezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: String(output.deadlineTimezone) }); }
      catch { throw new BadRequestException('deadlineTimezone must be a valid IANA timezone'); }
    }
    if (output.deadlineDate && output.deadlineAt && this.calendarDateInTimezone(output.deadlineAt as Date, String(output.deadlineTimezone)) !== output.deadlineDate) throw new BadRequestException('deadlineAt and deadlineDate disagree');
  }

  private mapTaskChanges(data: Record<string, unknown>): Prisma.TaskUncheckedUpdateInput {
    const map: Record<string, string> = {
      title: 'title', description: 'description', kind: 'kind', owner_type: 'ownerType', owner_id: 'ownerId', waiting_on: 'waitingOn',
      status: 'status', priority: 'priority', deadline_at: 'deadlineAt', deadline_date: 'deadlineDate', deadline_timezone: 'deadlineTimezone', deadline_text: 'deadlineText',
    };
    const result: Record<string, unknown> = {};
    for (const source of Object.keys(data)) if (!(source in map)) throw new BadRequestException(`Unsupported task field ${source}`);
    for (const [source, target] of Object.entries(map)) {
      if (data[source] === undefined) continue;
      const value = data[source];
      if (value === null) { result[target] = null; continue; }
      if (source === 'kind' && (typeof value !== 'string' || !TASK_KINDS.includes(value))) throw new BadRequestException('Invalid task kind');
      if (source === 'status' && (typeof value !== 'string' || !TASK_STATUSES.includes(value))) throw new BadRequestException('Invalid task status');
      if (source === 'priority' && (typeof value !== 'string' || !PRIORITIES.includes(value))) throw new BadRequestException('Invalid task priority');
      if (source === 'waiting_on' && (typeof value !== 'string' || !WAITING_ON.includes(value))) throw new BadRequestException('Invalid task waiting_on value');
      if (source === 'owner_type' && (typeof value !== 'string' || !['us', 'customer', 'third_party', 'mixed', 'none'].includes(value))) throw new BadRequestException('Invalid task owner_type');
      if (source === 'deadline_at') {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new BadRequestException('deadline_at must be an ISO timestamp with offset');
        result[target] = new Date(value);
      } else if (source === 'deadline_date') {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || (!Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)) throw new BadRequestException('Invalid deadline_date');
        result[target] = value;
      } else {
        if (typeof value !== 'string' || value.length > 2000) throw new BadRequestException(`Invalid ${source}`);
        result[target] = value;
      }
    }
    const deadlineDate = typeof result.deadlineDate === 'string' ? result.deadlineDate : null;
    const timezone = typeof result.deadlineTimezone === 'string' ? result.deadlineTimezone : null;
    const deadlineAt = result.deadlineAt instanceof Date ? result.deadlineAt : null;
    if (deadlineDate && !timezone) throw new BadRequestException('deadline_timezone is required with deadline_date');
    if (timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
      catch { throw new BadRequestException('Invalid deadline_timezone'); }
    }
    if (deadlineDate && deadlineAt && timezone && this.calendarDateInTimezone(deadlineAt, timezone) !== deadlineDate) throw new BadRequestException('deadline_at and deadline_date disagree');
    return result as Prisma.TaskUncheckedUpdateInput;
  }

  private simpleFactData(body: Record<string, unknown>, kind: 'requirement' | 'decision') {
    for (const field of Object.keys(body)) if (!['operationId', 'text', 'status', 'projectId', 'topicId', 'sourceMessageId'].includes(field)) throw new BadRequestException(`Unsupported ${kind} field ${field}`);
    const text = this.requiredText(body.text, 'text', 4000);
    const status = body.status === undefined ? (kind === 'decision' ? 'proposed' : 'open') : this.requiredText(body.status, 'status', 40);
    if (!(kind === 'decision' ? DECISION_STATUSES : REQUIREMENT_STATUSES).includes(status)) throw new BadRequestException(`Invalid ${kind} status`);
    const projectId = this.optionalId(body.projectId);
    const topicId = this.optionalId(body.topicId);
    if (topicId && !projectId) throw new BadRequestException('topicId requires projectId');
    const sourceMessageId = this.optionalId(body.sourceMessageId);
    return { text, status, projectId, topicId, sourceMessageId };
  }

  private factUpdateData(body: Record<string, unknown>, kind: 'requirement' | 'decision') {
    for (const field of Object.keys(body)) if (!['operationId', 'expectedVersion', 'text', 'status'].includes(field)) throw new BadRequestException(`Unsupported ${kind} field ${field}`);
    const result: Record<string, string> = {};
    if ('text' in body) result.text = this.requiredText(body.text, 'text', 4000);
    if ('status' in body) {
      const status = this.requiredText(body.status, 'status', 40);
      if (!(kind === 'decision' ? DECISION_STATUSES : REQUIREMENT_STATUSES).includes(status)) throw new BadRequestException(`Invalid ${kind} status`);
      result.status = status;
    }
    if (!Object.keys(result).length) throw new BadRequestException('At least one business field must be updated');
    return result;
  }

  private async requirementInAccount(id: string) {
    const account = await this.account();
    const item = await this.prisma.requirement.findFirst({ where: { id, OR: [{ sourceMessage: { mailAccountId: account.id } }, { project: { messages: { some: { mailAccountId: account.id } } } }, { project: { messages: { none: {} } } }, { projectId: null, sourceMessageId: null }] } });
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Requirement not found' });
    return item;
  }

  private async decisionInAccount(id: string) {
    const account = await this.account();
    const item = await this.prisma.decision.findFirst({ where: { id, OR: [{ sourceMessage: { mailAccountId: account.id } }, { project: { messages: { some: { mailAccountId: account.id } } } }, { project: { messages: { none: {} } } }, { projectId: null, sourceMessageId: null }] } });
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Decision not found' });
    return item;
  }

  private analysisOperationData(operation: Record<string, unknown>, message: { id: string; projectId: string | null; topicId: string | null }) {
    const changes = operation.changes && typeof operation.changes === 'object' && !Array.isArray(operation.changes) ? operation.changes as Record<string, unknown> : {};
    return { ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null)), projectId: message.projectId, topicId: message.topicId };
  }

  private async assertScope(projectId: unknown, topicId: unknown, sourceMessageId: string | null, accountId: string, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    if (typeof projectId === 'string') {
      const project = await tx.project.findFirst({ where: { id: projectId, status: { not: 'deleted' }, OR: [{ messages: { some: { mailAccountId: accountId } } }, { messages: { none: {} } }] }, select: { id: true } });
      if (!project) throw new NotFoundException('Project not found in this mailbox scope');
    }
    if (typeof topicId === 'string') {
      const topic = await tx.topic.findFirst({ where: { id: topicId, project: { status: { not: 'deleted' } }, ...(typeof projectId === 'string' ? { projectId } : {}), OR: [{ project: { messages: { some: { mailAccountId: accountId } } } }, { project: { messages: { none: {} } } }] }, select: { id: true, projectId: true } });
      if (!topic) throw new NotFoundException('Topic not found in this project/mailbox scope');
    }
    if (sourceMessageId) {
      const message = await tx.emailMessage.findFirst({ where: { id: sourceMessageId, mailAccountId: accountId }, select: { id: true, projectId: true, topicId: true } });
      if (!message) throw new NotFoundException('Source message not found in this mailbox');
      if (projectId && message.projectId && projectId !== message.projectId) throw new ConflictException('Source message and project differ');
      if (topicId && message.topicId && topicId !== message.topicId) throw new ConflictException('Source message and topic differ');
    }
  }

  private async lockScopeForWrite(tx: Prisma.TransactionClient, scopes: Array<{ projectId?: string | null; topicId?: string | null }>) {
    const projectIds = scopes.map((scope) => scope.projectId ?? null);
    const topicIds = [...new Set(scopes.map((scope) => scope.topicId).filter((id): id is string => typeof id === 'string'))];
    if (topicIds.length) {
      const topics = await tx.topic.findMany({ where: { id: { in: topicIds } }, select: { projectId: true } });
      projectIds.push(...topics.map((topic) => topic.projectId));
    }
    await lockProjectsForWrite(tx, projectIds);
  }

  private async assertAnalysisSourceFresh(message: { id: string; projectId: string | null; topicId: string | null; threadId: string | null; sentAt: Date | null; receivedAt: Date | null }, accountId: string, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    const timestamp = message.sentAt ?? message.receivedAt;
    if (!timestamp) throw new ConflictException({ code: 'SOURCE_DATE_MISSING', message: 'Analysis cannot update business state without a source timestamp' });
    const scope = message.projectId ? { projectId: message.projectId } : message.topicId ? { topicId: message.topicId } : message.threadId ? { threadId: message.threadId } : { id: message.id };
    const newer = await tx.emailMessage.findFirst({
      where: { ...scope, mailAccountId: accountId, id: { not: message.id }, OR: [{ sentAt: { gt: timestamp } }, { sentAt: null, receivedAt: { gt: timestamp } }] },
      select: { id: true },
    });
    if (newer) throw new ConflictException({ code: 'STALE_SOURCE', message: 'A newer email exists in this business scope; analyze the latest email before applying changes' });
  }

  private async taskInAccount(id: string, accountId: string): Promise<Task> {
    const task = await this.prisma.task.findFirst({ where: { id, OR: [{ createdFromMessage: { mailAccountId: accountId } }, { project: { messages: { some: { mailAccountId: accountId } } } }, { project: { messages: { none: {} } } }, { projectId: null, topicId: null, createdFromMessageId: null }] } });
    if (!task) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Task not found' });
    return task;
  }

  private calendarDateInTimezone(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  }

  private optionalId(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new BadRequestException('Invalid entity id');
    return value.trim();
  }

  private integer(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new BadRequestException(`${label} must be an integer from ${min} to ${max}`);
    return value;
  }

  private requiredText(value: unknown, label: string, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new BadRequestException(`${label} is required and must be at most ${max} characters`);
    return value.trim();
  }

  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED', message: 'IMAP is not configured' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY', message: 'IMAP account is not ready' });
    return account;
  }

  private isUniqueConflict(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002'); }
}
