import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type EmailMessage } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { ProjectEmailAnalysisService } from './project-email-analysis.service';
import { chooseMergeCompany, nextReviewCycle, normalizeResolverText, planContactEmailMerge, reviewDedupeKey } from './project-review.policy';
import { GATE_CLASSES } from './business-gate.rules';
import { executeAuditedMutation } from './business-operation';
import { lockCrmRelationshipWrites } from './crm-relation-lock';
import { assertCompanyAvailable, lockProjectForWrite } from './project-lifecycle.guard';

const PROJECT_STAGES = new Set(['lead', 'planning', 'design', 'quotation', 'revision', 'approval', 'production', 'delivery', 'completed', 'on_hold', 'cancelled']);
const TOPIC_TYPES = new Set(['design', 'graphics', 'quotation', 'budget', 'technical', 'logistics', 'invoice', 'contract', 'meeting', 'product_display', 'custom']);
const RESOLVABLE_ACTIONS = new Set(['assign_project', 'create_project', 'assign_topic', 'confirm_classification', 'merge_contact', 'dismiss']);
type CopyAssignmentAudit = {
  id: string;
  previousProjectId: string | null;
  projectId: string | null;
  previousVersion: number;
  version: number;
  preserved: boolean;
};

type ReviewResolutionInput = {
  action?: unknown; projectId?: unknown; projectName?: unknown; companyId?: unknown; contactIds?: unknown; primaryContactId?: unknown; description?: unknown; stage?: unknown; status?: unknown;
  topicId?: unknown; topicName?: unknown; topicType?: unknown; classification?: unknown; evidence?: unknown;
  targetContactId?: unknown; actorId?: unknown; operationId?: unknown;
};


@Injectable()
export class ProjectReviewService {
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly projectAnalysis: ProjectEmailAnalysisService,
  ) {}

  async resolveImported(messageIds?: string[]) {
    if (this.running) return { status: 'running', processed: 0, matched: 0, reviews: 0 };
    this.running = true;
    try {
      const account = await this.account();
      let processed = 0;
      let matched = 0;
      let reviews = 0;
      let classificationReviews = 0;
      let reviewCursor: string | undefined;
      while (true) {
        const uncertain = await this.prisma.emailMessage.findMany({
          where: { mailAccountId: account.id, reviewRequired: true, ...(messageIds ? { id: { in: messageIds } } : {}) },
          orderBy: { id: 'asc' }, take: 50,
          ...(reviewCursor ? { skip: 1, cursor: { id: reviewCursor } } : {}),
          select: { id: true, classification: true, classificationReason: true, classificationEvidence: true },
        });
        if (!uncertain.length) break;
        for (const message of uncertain) {
          await this.prisma.$transaction((tx) => this.upsertReview(tx, {
            entityType: 'email_message', entityId: message.id, sourceMessageId: message.id,
            reasonCode: 'CLASSIFICATION_UNCERTAIN', confidence: 0,
            proposedChangeJson: {
              currentClassification: message.classification,
              reason: message.classificationReason?.slice(0, 500) ?? null,
              evidence: Array.isArray(message.classificationEvidence) ? message.classificationEvidence : [],
            },
          }));
          classificationReviews += 1;
        }
        reviewCursor = uncertain.at(-1)?.id;
        if (uncertain.length < 50) break;
      }
      return { status: 'completed', processed: 0, matched: 0, reviews: 0, classificationReviews };
    } finally {
      this.running = false;
    }
  }

  async createProject(input: { name?: unknown; companyId?: unknown; description?: unknown; contactIds?: unknown; primaryContactId?: unknown; stage?: unknown; status?: unknown; actorId?: unknown; operationId?: unknown }) {
    const name = this.requiredText(input.name, 'Project name', 200);
    const description = this.optionalText(input.description, 5000);
    const companyId = this.requiredText(input.companyId, 'Company id', 100);
    const contactIds = this.contactIds(input.contactIds, true);
    const primaryContactId = this.optionalId(input.primaryContactId);
    if (primaryContactId && !contactIds.includes(primaryContactId)) throw new BadRequestException('primaryContactId must be one of contactIds');
    const state = this.projectState(input.status, input.stage, 'active', 'lead');
    return executeAuditedMutation(this.prisma, {
      operationId: input.operationId,
      actorId: input.actorId,
      entityType: 'project',
      action: 'create',
      input: { name, description, companyId, contactIds, primaryContactId, ...state },
      load: (client, id) => client.project.findUniqueOrThrow({ where: { id }, include: this.projectInclude() }),
      execute: async (tx) => {
        await lockCrmRelationshipWrites(tx);
        await assertCompanyAvailable(tx, companyId);
        await this.assertCompanyContacts(tx, companyId, contactIds);
        const duplicate = await tx.project.findFirst({
          where: { companyId, name: { equals: name, mode: 'insensitive' }, status: 'active' }, select: { id: true },
        });
        if (duplicate) throw new ConflictException('An active project with this name already exists for the company');
        const project = await tx.project.create({
          data: {
            name, description, companyId, stage: state.stage, status: state.status, confidence: 1, manualOverride: true,
            projectContacts: { create: contactIds.map((contactId) => ({ contactId, isPrimary: contactId === primaryContactId })) },
          },
          include: this.projectInclude(),
        });
        return { entityId: project.id, value: project };
      },
    });
  }

  async listProjects(limit: number, offset: number, companyId?: string) {
    const where = { ...(companyId ? { companyId } : {}), status: { not: 'deleted' } };
    const [total, projects] = await this.prisma.$transaction([
      this.prisma.project.count({ where }),
      this.prisma.project.findMany({
        where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset,
        include: this.projectListInclude(),
      }),
    ]);
    return { total, offset, limit, projects };
  }

  async getProject(id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, status: { not: 'deleted' } }, include: this.projectInclude(),
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async updateProject(id: string, input: Record<string, unknown>) {
    this.assertAllowedFields(input, ['name', 'companyId', 'description', 'contactIds', 'primaryContactId', 'stage', 'status', 'expectedVersion', 'actorId', 'operationId']);
    const expectedVersion = this.requiredVersion(input.expectedVersion);
    const operationId = this.requiredText(input.operationId, 'operationId', 200);
    const patch: Record<string, unknown> = {};
    if (Object.hasOwn(input, 'name')) patch.name = this.requiredText(input.name, 'Project name', 200);
    if (Object.hasOwn(input, 'companyId')) patch.companyId = this.requiredText(input.companyId, 'Company id', 100);
    if (Object.hasOwn(input, 'description')) patch.description = this.optionalText(input.description, 5000);
    if (Object.hasOwn(input, 'stage')) patch.stage = this.requiredText(input.stage, 'Project stage', 80).toLowerCase();
    if (Object.hasOwn(input, 'status')) patch.status = this.requiredText(input.status, 'Project status', 40).toLowerCase();
    if (patch.status === 'deleted') throw new BadRequestException({ code: 'PROJECT_DELETE_REQUIRES_DELETE', message: 'Use the audited project DELETE operation' });
    const contactIds = Object.hasOwn(input, 'contactIds') ? this.contactIds(input.contactIds, true) : undefined;
    const primaryContactId = Object.hasOwn(input, 'primaryContactId') ? this.optionalId(input.primaryContactId) : undefined;
    if (primaryContactId && contactIds && !contactIds.includes(primaryContactId)) throw new BadRequestException('primaryContactId must be one of contactIds');
    const hashInput = { id, expectedVersion, patch, contactIds, primaryContactId };
    return executeAuditedMutation(this.prisma, {
      operationId, actorId: input.actorId, entityType: 'project', action: 'update', input: hashInput,
      load: async (client, entityId) => {
        const project = await client.project.findFirst({ where: { id: entityId, status: { not: 'deleted' } }, include: this.projectInclude() });
        if (!project) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
        return project;
      },
      execute: async (tx) => {
        await lockCrmRelationshipWrites(tx);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id"=${id} FOR UPDATE`);
        const current = await tx.project.findUnique({ where: { id }, include: { projectContacts: { select: { contactId: true, isPrimary: true } } } });
        if (!current || current.status === 'deleted') throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
        if (current.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: current.version });
        const nextCompanyId = Object.hasOwn(patch, 'companyId') ? patch.companyId as string : current.companyId;
        if (Object.hasOwn(patch, 'companyId')) await assertCompanyAvailable(tx, nextCompanyId!);
        const memberIds = contactIds ?? current.projectContacts.map((member) => member.contactId);
        const priorPrimary = current.projectContacts.find((member) => member.isPrimary)?.contactId ?? null;
        const nextPrimary = primaryContactId === undefined ? (priorPrimary && memberIds.includes(priorPrimary) ? priorPrimary : null) : primaryContactId;
        if (nextPrimary && !memberIds.includes(nextPrimary)) throw new BadRequestException('primaryContactId must be one of the project contacts');
        if (nextCompanyId && memberIds.length) await this.assertCompanyContacts(tx, nextCompanyId, memberIds);
        else if (Object.hasOwn(patch, 'companyId') && !memberIds.length) throw new BadRequestException('Select at least one project contact for the company');
        if (nextCompanyId && !memberIds.length) throw new BadRequestException('A company project must have at least one project contact');
        if (!nextCompanyId && memberIds.length) throw new BadRequestException('Remove project contacts when clearing the project company');
        const nextState = this.projectState(patch.status, patch.stage, current.status, current.stage);
        const data = { ...patch, ...nextState, manualOverride: true, version: { increment: 1 } } as Prisma.ProjectUpdateManyMutationInput;
        const changed = await tx.project.updateMany({ where: { id, version: expectedVersion }, data });
        if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
        if (contactIds !== undefined || primaryContactId !== undefined || nextCompanyId !== current.companyId) {
          const relationIds = [...new Set([...current.projectContacts.map((item) => item.contactId), ...memberIds])].sort();
          await this.lockContacts(tx, relationIds);
          const rows = await tx.contact.findMany({ where: { id: { in: memberIds } }, select: { id: true, companyId: true, status: true } });
          if (rows.length !== memberIds.length || rows.some((item) => item.status !== 'confirmed' || item.companyId !== nextCompanyId)) {
            throw new ConflictException({ code: 'PROJECT_CONTACT_MUST_BELONG_TO_COMPANY', companyId: nextCompanyId, invalidContactIds: rows.filter((item) => item.status !== 'confirmed' || item.companyId !== nextCompanyId).map((item) => ({ id: item.id, companyId: item.companyId, status: item.status })) });
          }
          if (memberIds.length) await tx.projectContact.deleteMany({ where: { projectId: id, contactId: { notIn: memberIds } } });
          else await tx.projectContact.deleteMany({ where: { projectId: id } });
          await tx.projectContact.updateMany({ where: { projectId: id }, data: { isPrimary: false } });
          for (const contactId of memberIds) await tx.projectContact.upsert({ where: { projectId_contactId: { projectId: id, contactId } }, create: { projectId: id, contactId, isPrimary: contactId === nextPrimary }, update: { isPrimary: contactId === nextPrimary } });
        }
        const value = await tx.project.findUniqueOrThrow({ where: { id }, include: this.projectInclude() });
        await this.projectAnalysis.invalidateProjectSummaries(tx, [id], 'project_context_changed');
        return { entityId: id, value, before: current, after: value };
      },
    });
  }

  async deleteProject(id: string, input: { expectedVersion?: unknown; operationId?: unknown; actorId?: unknown }) {
    this.assertAllowedFields(input as Record<string, unknown>, ['expectedVersion', 'operationId', 'actorId']);
    const expectedVersion = this.requiredVersion(input.expectedVersion);
    const operationId = this.requiredText(input.operationId, 'operationId', 200);
    const actorId = this.optionalText(input.actorId, 160) ?? 'api-token-client';
    return executeAuditedMutation(this.prisma, {
      operationId, actorId, entityType: 'project', action: 'delete',
      input: { projectId: id, expectedVersion },
      load: async (client, entityId) => {
        const project = await client.project.findUniqueOrThrow({ where: { id: entityId }, select: { id: true, status: true, version: true } });
        return { id: project.id, status: project.status, version: project.version, deleted: project.status === 'deleted', operationId };
      },
      loadReplay: async (_client, operation) => {
        const receipt = operation.afterJson && typeof operation.afterJson === 'object' && !Array.isArray(operation.afterJson)
          ? operation.afterJson as Record<string, unknown> : null;
        if (!receipt || receipt.id !== id || receipt.status !== 'deleted' || !Number.isSafeInteger(receipt.version) || receipt.deleted !== true || receipt.operationId !== operationId) {
          throw new ConflictException({ code: 'IDEMPOTENCY_RESULT_UNAVAILABLE' });
        }
        return { id, status: 'deleted', version: receipt.version as number, deleted: true, operationId };
      },
      execute: async (tx) => {
        await lockCrmRelationshipWrites(tx);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id"=${id} FOR UPDATE`);
        const project = await tx.project.findUnique({ where: { id }, select: { id: true, companyId: true, version: true, status: true } });
        if (!project || project.status === 'deleted') throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
        if (project.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: project.version });

        const pendingAnalysis = await tx.projectAnalysisJob.findFirst({
          where: { projectId: id, status: { in: ['pending', 'processing'] } }, select: { id: true },
        });
        if (pendingAnalysis) throw new ConflictException({ code: 'PROJECT_HAS_ACTIVE_ANALYSIS', message: 'Cancel or finish pending project analysis before deleting this project.' });
        const topicIds = (await tx.topic.findMany({ where: { projectId: id }, select: { id: true } })).map((topic) => topic.id);
        const activeTask = await tx.task.findFirst({
          where: { status: { in: ['open', 'in_progress', 'waiting'] }, OR: [{ projectId: id }, ...(topicIds.length ? [{ topicId: { in: topicIds } }] : [])] },
          select: { id: true },
        });
        if (activeTask) throw new ConflictException({ code: 'PROJECT_HAS_ACTIVE_TASKS', message: 'Complete, cancel, or move active project tasks before deleting this project.' });

        const changed = await tx.project.updateMany({
          where: { id, version: expectedVersion, status: { not: 'deleted' } },
          data: { status: 'deleted', version: { increment: 1 }, manualOverride: true },
        });
        if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
        const value = { id, status: 'deleted', version: expectedVersion + 1, deleted: true, operationId };
        return { entityId: id, value, before: project, after: value };
      },
    });
  }

  async createTopic(projectId: string, input: { name?: unknown; type?: unknown; description?: unknown; actorId?: unknown; operationId?: unknown }) {
    const name = this.requiredText(input.name, 'Topic name', 160);
    const type = typeof input.type === 'string' ? input.type.trim().toLowerCase() : 'custom';
    if (!TOPIC_TYPES.has(type)) throw new BadRequestException('Unsupported topic type');
    const description = this.optionalText(input.description, 3000);
    const normalizedName = normalizeResolverText(name);
    if (!normalizedName) throw new BadRequestException('Topic name must contain letters or numbers');
    return executeAuditedMutation(this.prisma, {
      operationId: input.operationId,
      actorId: input.actorId,
      entityType: 'topic',
      action: 'create',
      input: { projectId, name, normalizedName, type, description },
      load: (client, id) => client.topic.findUniqueOrThrow({ where: { id } }),
      execute: async (tx) => {
        await lockProjectForWrite(tx, projectId);
        try {
          const topic = await tx.topic.create({ data: { projectId, name, normalizedName, type, description } });
          return { entityId: topic.id, value: topic };
        } catch (error) {
          if (this.uniqueConflict(error)) throw new ConflictException('Topic already exists for this project');
          throw error;
        }
      },
    });
  }

  async listReviews(status = 'pending', limit = 50, offset = 0) {
    if (!['pending', 'resolved', 'dismissed', 'all'].includes(status)) throw new BadRequestException('Invalid review status');
    const where: Prisma.ReviewItemWhereInput = {
      ...(status === 'all' ? {} : { status }),
      NOT: { entityType: 'contact', reasonCode: 'CONTACT_PROVISIONAL' },
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.reviewItem.count({ where }),
      this.prisma.reviewItem.findMany({
        where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset,
        include: {
          sourceMessage: {
            select: {
              id: true, subject: true, direction: true, classification: true, fromJson: true,
              receivedAt: true, projectId: true, topicId: true, contactResolutionStatus: true,
              projectResolutionStatus: true, topicResolutionStatus: true,
              project: { select: { id: true, name: true } }, topic: { select: { id: true, name: true } },
            },
          },
        },
      }),
    ]);
    return { total, status, offset, limit, items };
  }

  async getReview(id: string) {
    const item = await this.prisma.reviewItem.findUnique({
      where: { id },
      include: {
        sourceMessage: {
          select: {
            id: true, subject: true, direction: true, classification: true, fromJson: true,
            receivedAt: true, contactId: true, companyId: true, projectId: true, topicId: true,
            contact: { include: { emails: true, company: true } },
            company: { select: { id: true, name: true, domain: true } },
            project: { select: { id: true, name: true } }, topic: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!item) throw new NotFoundException('Review item not found');
    if (item.entityType === 'contact' && item.reasonCode === 'CONTACT_PROVISIONAL') throw new NotFoundException('Contact confirmation reviews are retired; use the legacy contact audit workflow');
    const review = { ...item, isSourceDeleted: Boolean(item.sourceDeletedAt) };
    if (item.entityType === 'contact') {
      return { ...review, contact: await this.prisma.contact.findUnique({ where: { id: item.entityId }, include: { emails: true, company: true } }) };
    }
    return review;
  }

  async resolveReview(id: string, input: ReviewResolutionInput) {
    const action = typeof input.action === 'string' ? input.action : '';
    if (!RESOLVABLE_ACTIONS.has(action)) throw new BadRequestException('Unsupported review action');
    const actor = this.optionalText(input.actorId, 120) ?? 'api-token-client';
    const operationId = this.optionalText(input.operationId, 160) ?? randomUUID();
    const { actorId: _actorId, operationId: _operationId, ...resolution } = input;
    return executeAuditedMutation(this.prisma, {
      operationId, actorId: actor, entityType: 'review_item', action: 'resolve',
      input: { ...resolution, reviewId: id },
      load: (client, entityId) => client.reviewItem.findUniqueOrThrow({ where: { id: entityId } }),
      execute: async (tx) => {
        const value = await this.resolveReviewTx(tx, id, input, action, actor, operationId);
        return { entityId: id, value, before: { status: 'pending' }, after: value };
      },
    });
  }

  private async resolveReviewTx(tx: Prisma.TransactionClient, id: string, input: ReviewResolutionInput, action: string, actor: string, operationId: string) {
      await lockCrmRelationshipWrites(tx);
      const hint = await tx.reviewItem.findUnique({ where: { id }, select: { id: true, entityType: true, sourceMessageId: true } });
      if (!hint) throw new NotFoundException('Review item not found');
      const lockedCopies = hint.entityType === 'email_message' && hint.sourceMessageId ? await this.lockMessageCopies(tx, hint.sourceMessageId) : [];
      const copyIds = lockedCopies.map((item) => item.id);
      if (copyIds.length) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ReviewItem" WHERE "sourceMessageId" IN (${Prisma.join(copyIds)}) AND "status"='pending' ORDER BY "id" FOR UPDATE`);
      } else {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ReviewItem" WHERE "id" = ${id} FOR UPDATE`);
      }
      const review = await tx.reviewItem.findUnique({ where: { id } });
      if (!review) throw new NotFoundException('Review item not found');
      if (review.status !== 'pending') throw new ConflictException({ code: 'REVIEW_ALREADY_RESOLVED', message: 'Reload the review before choosing another resolution' });
      if (review.sourceMessageId !== hint.sourceMessageId) throw new ConflictException({ code: 'REVIEW_SOURCE_CHANGED' });
      if (action === 'dismiss') {
        const now = new Date();
        const copyAssignments: CopyAssignmentAudit[] = [];
        if (review.sourceMessageId && review.reasonCode.startsWith('PROJECT_')) {
          const message = lockedCopies.find((item) => item.id === review.sourceMessageId);
          if (message) {
            const result = await this.applyManualCopyAssignment(tx, lockedCopies, null, null, { action, reviewId: id, actorId: actor, operationId, reason: 'User dismissed project review' });
            copyAssignments.push(...result.assignments);
            await this.closeProjectReviews(tx, lockedCopies.map((item) => item.id), id, actor, 'A user dismissed project assignment and locked the message decision');
            await this.closeAnalysisItems(tx, lockedCopies.map((item) => item.id), null, 'A user dismissed project assignment');
            await this.closeTopicReviews(tx, lockedCopies.map((item) => item.id), actor, 'Project assignment was dismissed');
            await this.projectAnalysis.invalidateProjectSummaries(tx, result.previousProjectIds, 'manual_project_review_dismissed');
          }
        }
        if (review.sourceMessageId && review.reasonCode === 'TOPIC_UNRESOLVED') {
          const message = lockedCopies.find((item) => item.id === review.sourceMessageId);
          if (message && !message.topicManualOverride) {
            const project = message.projectId ? await tx.project.findUnique({ where: { id: message.projectId }, select: { id: true, companyId: true } }) : null;
            const result = await this.applyManualCopyAssignment(tx, lockedCopies, project, null, { action, reviewId: id, actorId: actor, operationId, reason: 'User dismissed topic review', topicDismissed: true });
            copyAssignments.push(...result.assignments);
            await this.closeProjectReviews(tx, lockedCopies.map((item) => item.id), id, actor, 'A user dismissed the topic review and locked the project assignment');
            await this.closeTopicReviews(tx, lockedCopies.map((item) => item.id), actor, 'A user dismissed the topic review');
            await this.closeAnalysisItems(tx, lockedCopies.map((item) => item.id), message.projectId, 'A user dismissed topic review');
            await this.invalidateProjectSummaries(tx, result.previousProjectIds, 'manual_topic_review_dismissed');
          }
        }
        return tx.reviewItem.update({ where: { id }, data: { status: 'dismissed', resolvedBy: actor, resolvedAt: now, resolutionJson: { action, actorId: actor, operationId, copyAssignments } } });
      }
      if (action === 'merge_contact') return this.mergeContactReview(tx, review, input.targetContactId, actor, operationId);
      if (review.entityType !== 'email_message' || !review.sourceMessageId) throw new BadRequestException('This review item does not refer to an email message');
      const message = lockedCopies.find((item) => item.id === review.sourceMessageId);
      if (!message) throw new NotFoundException('Source message not found');
      if (action === 'confirm_classification') {
        if (!['CLASSIFICATION_UNCERTAIN', 'AI_CLASSIFICATION_DISAGREEMENT'].includes(review.reasonCode)) throw new BadRequestException('Classification can only be confirmed from a classification review');
        if (message.classificationManualOverride) throw new ConflictException({ code: 'MANUAL_CLASSIFICATION_PRESERVED' });
        const classification = typeof input.classification === 'string' ? input.classification : '';
        if (!GATE_CLASSES.includes(classification as (typeof GATE_CLASSES)[number])) throw new BadRequestException('Unsupported email classification');
        const proposal = review.proposedChangeJson && typeof review.proposedChangeJson === 'object' && !Array.isArray(review.proposedChangeJson)
          ? review.proposedChangeJson as Record<string, unknown> : {};
        const proposedEvidence = Array.isArray(proposal.evidence) ? proposal.evidence.filter((value): value is string => typeof value === 'string').slice(0, 10) : [];
        const suppliedEvidence = typeof input.evidence === 'string' ? input.evidence.trim().slice(0, 500) : '';
        const evidence = suppliedEvidence ? [suppliedEvidence] : proposedEvidence.length ? proposedEvidence : ['Classification explicitly confirmed by user'];
        const changed = await tx.emailMessage.updateMany({
          where: { id: message.id, classificationManualOverride: false },
          data: {
            classification,
            classificationReason: `Manually confirmed through ReviewItem ${id}`,
            classificationEvidence: evidence,
            reviewRequired: false,
            classificationManualOverride: true,
            classifiedAt: new Date(),
          },
        });
        if (!changed.count) throw new ConflictException({ code: 'MANUAL_CLASSIFICATION_PRESERVED' });
        return this.finishReview(tx, review, actor, {
          action, actorId: actor, operationId, sourceMessageId: message.id,
          previousClassification: message.classification, classification,
          suggestedClassification: proposal.suggestedClassification ?? null,
          classificationEvidence: evidence,
          analysisRunId: proposal.analysisRunId ?? null,
        });
      }
      if (action === 'assign_topic') {
        if (review.reasonCode !== 'TOPIC_UNRESOLVED' || !message.projectId) throw new BadRequestException('A project must be assigned before resolving a topic');
        if (message.topicManualOverride) throw new ConflictException({ code: 'MANUAL_TOPIC_ASSIGNMENT_PRESERVED' });
        const topicId = this.requiredText(input.topicId, 'Topic id', 100);
        const topic = await tx.topic.findUnique({ where: { id: topicId }, select: { id: true, projectId: true } });
        if (!topic || topic.projectId !== message.projectId) throw new BadRequestException('Topic must belong to the message project');
        await lockProjectForWrite(tx, message.projectId);
        const project = await tx.project.findUnique({ where: { id: message.projectId }, select: { id: true, companyId: true } });
        if (!project) throw new NotFoundException('Project not found');
        const result = await this.applyManualCopyAssignment(tx, lockedCopies, project, topicId, { action, reviewId: id, actorId: actor, operationId, reason: 'Manually assigned through ReviewItem', explicitTopic: true });
        await this.closeProjectReviews(tx, lockedCopies.map((item) => item.id), id, actor, 'A user manually confirmed project and topic assignment');
        await this.closeTopicReviews(tx, lockedCopies.map((item) => item.id), actor, 'A user manually confirmed a topic');
        await this.closeAnalysisItems(tx, lockedCopies.map((item) => item.id), project.id, 'A user manually confirmed project and topic assignment');
        await this.projectAnalysis.invalidateProjectSummaries(tx, [...result.previousProjectIds, project.id], 'manual_project_topic_assignment');
        return this.finishReview(tx, review, actor, { action, operationId, previousTopicId: message.topicId, topicId, projectId: message.projectId, copyAssignments: result.assignments });
      }
      if (review.reasonCode.startsWith('PROJECT_') && action === 'assign_project') {
        const projectId = this.requiredText(input.projectId, 'Project id', 100);
        await lockProjectForWrite(tx, projectId);
        const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, companyId: true, status: true } });
        if (!project || !['active', 'completed'].includes(project.status)) throw new BadRequestException('Project not found');
        const topicId = this.optionalId(input.topicId);
        const topic = topicId ? await tx.topic.findUnique({ where: { id: topicId }, select: { id: true, projectId: true } }) : null;
        if (topicId && (!topic || topic.projectId !== project.id)) throw new BadRequestException('Topic must belong to the selected project');
        const result = await this.applyManualCopyAssignment(tx, lockedCopies, project, topic?.id ?? null, { action, reviewId: id, actorId: actor, operationId, reason: 'Manually assigned through ReviewItem', explicitTopic: Boolean(topic) });
        await this.closeProjectReviews(tx, lockedCopies.map((item) => item.id), id, actor, 'A user manually assigned the message to a project');
        if (topic) await this.closeTopicReviews(tx, lockedCopies.map((item) => item.id), actor, 'A user manually assigned a topic');
        await this.closeAnalysisItems(tx, lockedCopies.map((item) => item.id), project.id, 'A user manually assigned the message to a project');
        if (!topic) await this.upsertReview(tx, {
          entityType: 'email_message', entityId: message.id, sourceMessageId: message.id,
          reasonCode: 'TOPIC_UNRESOLVED', confidence: 0,
          proposedChangeJson: { projectId: project.id, topics: await tx.topic.findMany({ where: { projectId: project.id, status: 'active' }, select: { id: true, name: true, type: true } }) },
        });
        await this.projectAnalysis.invalidateProjectSummaries(tx, [...result.previousProjectIds, project.id], 'manual_project_assignment');
        return this.finishReview(tx, review, actor, { action, operationId, previousProjectId: message.projectId, projectId: project.id, topicId: topic?.id ?? null, copyAssignments: result.assignments });
      }
      if (review.reasonCode.startsWith('PROJECT_') && action === 'create_project') {
        const name = this.requiredText(input.projectName, 'Project name', 200);
        const companyId = this.requiredText(input.companyId, 'Company id', 100);
        await lockCrmRelationshipWrites(tx);
        const description = this.optionalText(input.description, 5000);
        const contactIds = this.contactIds(input.contactIds, true);
        const primaryContactId = this.optionalId(input.primaryContactId);
        if (primaryContactId && !contactIds.includes(primaryContactId)) throw new BadRequestException('primaryContactId must be one of contactIds');
        await assertCompanyAvailable(tx, companyId);
        await this.assertCompanyContacts(tx, companyId, contactIds);
        const state = this.projectState(input.status, input.stage, 'active', 'lead');
        const duplicate = await tx.project.findFirst({ where: { companyId, name: { equals: name, mode: 'insensitive' }, status: 'active' }, select: { id: true } });
        if (duplicate) throw new ConflictException('An active project with this name already exists; assign the existing project');
        const project = await tx.project.create({ data: {
          name, description, companyId, stage: state.stage, status: state.status, confidence: 1, manualOverride: true,
          projectContacts: { create: contactIds.map((contactId) => ({ contactId, isPrimary: contactId === primaryContactId })) },
        } });
        let topicId: string | null = null;
        let topic: { id: string } | null = null;
        const topicName = this.optionalText(input.topicName, 160);
        if (topicName) {
          const normalizedName = normalizeResolverText(topicName);
          if (!normalizedName) throw new BadRequestException('Topic name must contain letters or numbers');
          const type = typeof input.topicType === 'string' ? input.topicType.trim().toLowerCase() : 'custom';
          if (!TOPIC_TYPES.has(type)) throw new BadRequestException('Unsupported topic type');
          topic = await tx.topic.create({ data: { projectId: project.id, name: topicName, normalizedName, type }, select: { id: true } });
          topicId = topic.id;
        }
        const result = await this.applyManualCopyAssignment(tx, lockedCopies, { id: project.id, companyId }, topic?.id ?? null, { action, reviewId: id, actorId: actor, operationId, reason: 'Project created and assigned manually through ReviewItem', explicitTopic: Boolean(topic) });
        await this.closeProjectReviews(tx, lockedCopies.map((item) => item.id), id, actor, 'A user created and assigned a project');
        if (topic) await this.closeTopicReviews(tx, lockedCopies.map((item) => item.id), actor, 'A user created and assigned a topic');
        await this.closeAnalysisItems(tx, lockedCopies.map((item) => item.id), project.id, 'A user created and assigned a project');
        if (!topic) await this.upsertReview(tx, {
          entityType: 'email_message', entityId: message.id, sourceMessageId: message.id,
          reasonCode: 'TOPIC_UNRESOLVED', confidence: 0,
          proposedChangeJson: { projectId: project.id, topics: [] },
        });
        await this.projectAnalysis.invalidateProjectSummaries(tx, [...result.previousProjectIds, project.id], 'manual_project_created_and_assigned');
        return this.finishReview(tx, review, actor, { action, operationId, previousProjectId: message.projectId, projectId: project.id, topicId, copyAssignments: result.assignments });
      }
      throw new BadRequestException('The action does not match this review item');
  }

  private async upsertReview(tx: Prisma.TransactionClient, input: {
    entityType: string; entityId: string; sourceMessageId: string; reasonCode: string;
    confidence: number; proposedChangeJson: Prisma.InputJsonValue;
  }) {
    const dedupeKeyBase = reviewDedupeKey(
      input.entityType,
      input.entityId,
      input.reasonCode,
      input.entityType === 'contact' ? null : input.sourceMessageId,
    );
    const pending = await tx.reviewItem.findFirst({ where: { dedupeKeyBase, status: 'pending' }, orderBy: { cycle: 'desc' } });
    if (pending) {
      if (nextReviewCycle(pending, input.proposedChangeJson, input.confidence).action === 'reuse') return pending;
      return tx.reviewItem.update({
        where: { id: pending.id }, data: { confidence: input.confidence, proposedChangeJson: input.proposedChangeJson },
      });
    }
    const latest = await tx.reviewItem.findFirst({ where: { dedupeKeyBase }, orderBy: { cycle: 'desc' } });
    const decision = nextReviewCycle(latest, input.proposedChangeJson, input.confidence);
    if (decision.action === 'reuse' && latest) return latest;
    const cycle = decision.cycle;
    const dedupeKey = `${dedupeKeyBase}:${cycle}`;
    return tx.reviewItem.create({ data: { ...input, dedupeKeyBase, cycle, dedupeKey, status: 'pending' } });
  }

  private async closeProjectReviews(tx: Prisma.TransactionClient, sourceMessageIds: string[], currentReviewId: string | null, actor: string, explanation: string, keepReasonCode?: string) {
    const ids = [...new Set(sourceMessageIds)];
    if (!ids.length) return;
    await tx.reviewItem.updateMany({
      where: {
        sourceMessageId: { in: ids },
        status: 'pending',
        reasonCode: { startsWith: 'PROJECT_', ...(keepReasonCode ? { not: keepReasonCode } : {}) },
        ...(currentReviewId ? { id: { not: currentReviewId } } : {}),
      },
      data: { status: 'resolved', resolvedBy: actor, resolvedAt: new Date(), resolutionJson: { action: 'superseded_or_auto_resolved', explanation } },
    });
  }

  private async closeTopicReviews(tx: Prisma.TransactionClient, sourceMessageIds: string[], actor: string, explanation: string) {
    const ids = [...new Set(sourceMessageIds)];
    if (!ids.length) return;
    await tx.reviewItem.updateMany({
      where: { sourceMessageId: { in: ids }, reasonCode: 'TOPIC_UNRESOLVED', status: 'pending' },
      data: { status: 'resolved', resolvedBy: actor, resolvedAt: new Date(), resolutionJson: { action: 'auto_resolved', explanation } },
    });
  }

  private async closeAnalysisItems(tx: Prisma.TransactionClient, sourceMessageIds: string[], projectId: string | null, reason: string) {
    const ids = [...new Set(sourceMessageIds)];
    if (!ids.length) return;
    await tx.projectAnalysisItem.updateMany({
      where: { sourceMessageId: { in: ids }, status: { in: ['pending', 'needs_review'] } },
      data: {
        status: 'completed', outcome: 'manual_preserved', chosenProjectId: projectId,
        reason: `Manual project decision is authoritative: ${reason}`, evidenceJson: [],
        lastErrorCode: 'PROJECT_MANUAL_OVERRIDE_PRESERVED', leaseToken: null, leaseExpiresAt: null,
      },
    });
  }

  private async finishReview(tx: Prisma.TransactionClient, review: { id: string }, actor: string, resolution: Prisma.InputJsonValue) {
    return tx.reviewItem.update({ where: { id: review.id }, data: { status: 'resolved', resolvedBy: actor, resolvedAt: new Date(), resolutionJson: resolution } });
  }

  private async lockMessageCopies(tx: Prisma.TransactionClient, sourceMessageId: string): Promise<EmailMessage[]> {
    const identity = await tx.emailMessage.findUnique({ where: { id: sourceMessageId }, select: { id: true, mailAccountId: true, rfcMessageId: true } });
    if (!identity) throw new NotFoundException('Source message not found');
    const rfcMessageId = identity.rfcMessageId?.trim();
    const locked = rfcMessageId
      ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "EmailMessage" WHERE "mailAccountId"=${identity.mailAccountId} AND NULLIF(BTRIM("rfcMessageId"), '')=${rfcMessageId} ORDER BY "id" FOR UPDATE`)
      : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "EmailMessage" WHERE "id"=${identity.id} FOR UPDATE`);
    const ids = [...new Set(locked.map((row) => row.id))];
    if (!ids.includes(sourceMessageId)) throw new NotFoundException('Source message not found');
    return tx.emailMessage.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
  }

  private async applyManualCopyAssignment(
    tx: Prisma.TransactionClient,
    copies: EmailMessage[],
    targetProject: { id: string; companyId: string | null } | null,
    topicId: string | null,
    options: { action: string; reviewId: string; actorId: string; operationId: string; reason: string; explicitTopic?: boolean; topicDismissed?: boolean },
  ) {
    const targetProjectId = targetProject?.id ?? null;
    const conflicts = copies.filter((copy) => copy.projectManualOverride && copy.projectId !== targetProjectId);
    if (conflicts.length) throw new ConflictException({
      code: 'RFC_COPY_MANUAL_ASSIGNMENT_CONFLICT',
      message: 'A copy of this email has a different manual project assignment; resolve the duplicate group explicitly first',
      copies: conflicts.map((copy) => ({ id: copy.id, projectId: copy.projectId, projectAssignmentVersion: copy.projectAssignmentVersion })),
    });
    const topicConflicts = copies.filter((copy) => copy.topicManualOverride && (
      (options.explicitTopic && copy.topicId !== topicId) ||
      (options.topicDismissed && (copy.topicId !== null || copy.topicResolutionStatus !== 'dismissed')) ||
      (!targetProjectId && copy.topicId !== null)
    ));
    if (topicConflicts.length) throw new ConflictException({
      code: 'RFC_COPY_MANUAL_TOPIC_CONFLICT',
      message: 'A copy of this email has a different manual topic decision; resolve the duplicate group explicitly first',
      copies: topicConflicts.map((copy) => ({ id: copy.id, topicId: copy.topicId, projectId: copy.projectId })),
    });
    const assignments: Array<{ id: string; previousProjectId: string | null; projectId: string | null; previousVersion: number; version: number; preserved: boolean }> = [];
    for (const copy of copies) {
      if (copy.projectManualOverride && copy.projectId === targetProjectId) {
        assignments.push({ id: copy.id, previousProjectId: copy.projectId, projectId: copy.projectId, previousVersion: copy.projectAssignmentVersion, version: copy.projectAssignmentVersion, preserved: true });
        continue;
      }
      const projectChanged = copy.projectId !== targetProjectId;
      let nextTopicId = copy.topicId;
      let topicResolutionStatus = copy.topicResolutionStatus;
      let topicReason = copy.topicReason;
      let topicManualOverride = copy.topicManualOverride;
      let topicConfidence = copy.topicConfidence;
      if (options.topicDismissed) {
        nextTopicId = null;
        topicResolutionStatus = 'dismissed';
        topicReason = options.reason;
        topicManualOverride = true;
        topicConfidence = 1;
      } else if (options.explicitTopic) {
        nextTopicId = topicId;
        topicResolutionStatus = 'matched';
        topicReason = options.reason;
        topicManualOverride = true;
        topicConfidence = 1;
      } else if (!targetProjectId) {
        nextTopicId = null;
        topicResolutionStatus = 'unresolved';
        topicReason = 'No project is assigned to this message';
        topicManualOverride = false;
        topicConfidence = 0;
      } else if (copy.topicManualOverride && copy.topicId) {
        const existingTopic = await tx.topic.findUnique({ where: { id: copy.topicId }, select: { projectId: true } });
        if (existingTopic && existingTopic.projectId !== targetProjectId) throw new ConflictException({ code: 'PROJECT_TOPIC_CONFLICT', messageId: copy.id, topicId: copy.topicId });
      } else if (projectChanged && !copy.topicManualOverride) {
        nextTopicId = null;
        topicResolutionStatus = 'unresolved';
        topicReason = 'Project changed manually; topic requires review.';
        topicManualOverride = false;
        topicConfidence = 0;
      }
      const changed = await tx.emailMessage.updateMany({
        where: { id: copy.id, projectAssignmentVersion: copy.projectAssignmentVersion, projectManualOverride: false },
        data: {
          companyId: targetProject?.companyId ?? null,
          projectId: targetProjectId,
          projectResolutionStatus: targetProjectId ? 'manual' : 'dismissed',
          projectConfidence: 1,
          projectReason: options.reason,
          projectManualOverride: true,
          projectAssignmentVersion: { increment: 1 },
          topicId: nextTopicId,
          topicResolutionStatus,
          topicReason,
          topicManualOverride,
          topicConfidence,
          projectResolutionEvidence: {
            source: 'manual', action: options.action, reviewId: options.reviewId, actorId: options.actorId,
            operationId: options.operationId, reason: options.reason, syncedCopyIds: copies.map((item) => item.id),
            previousProjectId: copy.projectId, assignedProjectId: targetProjectId,
            previousAssignmentVersion: copy.projectAssignmentVersion,
          } as Prisma.InputJsonValue,
        },
      });
      if (!changed.count) throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_VERSION_CONFLICT', messageId: copy.id });
      assignments.push({ id: copy.id, previousProjectId: copy.projectId, projectId: targetProjectId, previousVersion: copy.projectAssignmentVersion, version: copy.projectAssignmentVersion + 1, preserved: false });
    }
    return { previousProjectIds: [...new Set(copies.map((copy) => copy.projectId).filter((value): value is string => Boolean(value)))], assignments };
  }

  private async mergeContactReview(
    tx: Prisma.TransactionClient,
    review: { id: string; entityType: string; entityId: string },
    targetContactIdValue: unknown,
    actor: string,
    operationId: string | null,
  ) {
    if (review.entityType !== 'contact') throw new BadRequestException('Contact merge requires a contact review item');
    await lockCrmRelationshipWrites(tx);
    const targetContactId = this.requiredText(targetContactIdValue, 'Target contact id', 100);
    if (targetContactId === review.entityId) throw new BadRequestException('Source and target contacts must differ');
    await this.lockContacts(tx, [review.entityId, targetContactId]);
    const [source, target] = await Promise.all([
      tx.contact.findUnique({ where: { id: review.entityId }, include: { emails: true } }),
      tx.contact.findUnique({ where: { id: targetContactId }, include: { emails: true } }),
    ]);
    if (!source || source.status === 'merged' || source.mergedIntoId) throw new ConflictException('Source contact is missing or already merged');
    if (!target || target.status === 'merged' || target.mergedIntoId) throw new ConflictException('Target contact is missing or already merged');
    const sourceMemberships = await tx.projectContact.findMany({ where: { contactId: source.id }, select: { projectId: true } });
    if (sourceMemberships.length) throw new ConflictException({ code: 'CONTACT_HAS_PROJECT_MEMBERSHIPS', message: 'Remove the source contact from its projects before merging it', projectIds: sourceMemberships.map((item) => item.projectId) });
    const mergeCompany = chooseMergeCompany(source.companyId, target.companyId);
    if (!mergeCompany.ok) {
      throw new ConflictException('Contacts belong to different companies; resolve the company mapping before merging');
    }
    const companyId = mergeCompany.companyId;
    const targetMemberships = await tx.projectContact.findMany({ where: { contactId: target.id }, select: { project: { select: { id: true, companyId: true } } } });
    const invalidMemberships = targetMemberships.filter((item) => item.project.companyId !== companyId);
    if (invalidMemberships.length) throw new ConflictException({ code: 'PROJECT_CONTACT_COMPANY_CONFLICT', memberships: invalidMemberships.map((item) => ({ projectId: item.project.id, projectCompanyId: item.project.companyId, nextCompanyId: companyId })) });
    await this.lockCompanies(tx, [source.companyId, target.companyId, companyId]);
    const emailPlan = planContactEmailMerge(source.emails, target.emails.map(({ email }) => email));
    for (const email of source.emails) {
      const normalized = email.email.trim().toLowerCase();
      const mapping = await tx.contactEmail.findUnique({ where: { email: normalized }, select: { id: true, contactId: true } });
      if (mapping && mapping.contactId !== source.id && mapping.contactId !== target.id) {
        throw new ConflictException('A source email address is mapped to another contact; resolve that mapping before merging');
      }
    }
    if (emailPlan.deleteIds.length) await tx.contactEmail.deleteMany({ where: { id: { in: emailPlan.deleteIds } } });
    if (emailPlan.moveIds.length) await tx.contactEmail.updateMany({ where: { id: { in: emailPlan.moveIds } }, data: { contactId: target.id, verified: true } });
    const targetChanged = await tx.contact.updateMany({
      where: { id: target.id, version: target.version },
      data: { companyId, status: 'confirmed', confidence: 1, provisionalReason: null, version: { increment: 1 } },
    });
    if (!targetChanged.count) throw new ConflictException({ code: 'VERSION_CONFLICT', contactId: target.id });
    const sourceMessages = await tx.emailMessage.findMany({ where: { contactId: source.id }, select: { id: true } });
    const sourceMessageIds = sourceMessages.map(({ id }) => id);
    if (sourceMessageIds.length) {
      await tx.emailMessage.updateMany({
        where: { id: { in: sourceMessageIds } },
        data: {
          contactId: target.id, contactResolutionStatus: 'matched', contactResolutionConfidence: 1,
          contactResolutionReason: `Contact merged into ${target.id} through ReviewItem ${review.id}`,
        },
      });
      if (companyId) await tx.emailMessage.updateMany({ where: { id: { in: sourceMessageIds }, companyId: null }, data: { companyId } });
    }
    await tx.contactEmail.updateMany({ where: { contactId: target.id }, data: { verified: true } });
    const sourceChanged = await tx.contact.updateMany({
      where: { id: source.id, version: source.version },
      data: { status: 'merged', mergedIntoId: target.id, confidence: 1, provisionalReason: null, version: { increment: 1 } },
    });
    if (!sourceChanged.count) throw new ConflictException({ code: 'VERSION_CONFLICT', contactId: source.id });
    for (const companyIdToBump of [...new Set([source.companyId, target.companyId, companyId].filter((value): value is string => Boolean(value)))]) {
      await tx.company.updateMany({ where: { id: companyIdToBump }, data: { version: { increment: 1 } } });
    }
    await this.projectAnalysis.invalidateProjectSummaries(tx, targetMemberships.map((item) => item.project.id), 'contact_merged_into_project_member');
    await tx.reviewItem.updateMany({
      where: { entityType: 'contact', entityId: source.id, status: 'pending', id: { not: review.id } },
      data: {
        status: 'resolved', resolvedBy: actor, resolvedAt: new Date(),
        resolutionJson: { action: 'merge_contact', targetContactId: target.id, actorId: actor, operationId },
      },
    });
    return this.finishReview(tx, review, actor, {
      action: 'merge_contact', actorId: actor, operationId,
      sourceContactId: source.id, targetContactId: target.id, companyId,
      transferredEmailCount: emailPlan.moveIds.length,
      reassignedMessageCount: sourceMessageIds.length,
    });
  }

  private projectInclude() {
    return {
      company: { select: { id: true, name: true, domain: true, website: true, address: true, notes: true, version: true } },
      projectContacts: {
        orderBy: [{ isPrimary: 'desc' as const }, { contact: { displayName: 'asc' as const } }],
        include: { contact: { include: { emails: { orderBy: [{ isPrimary: 'desc' as const }, { email: 'asc' as const }] }, company: { select: { id: true, name: true } } } } },
      },
      topics: { orderBy: [{ name: 'asc' as const }, { id: 'asc' as const }] },
      tasks: { orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }] },
      requirements: { orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }] },
      decisions: { orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }] },
      _count: { select: { messages: true, tasks: true, requirements: true, decisions: true } },
    };
  }

  private projectListInclude() {
    return {
      company: { select: { id: true, name: true, domain: true } },
      projectContacts: {
        orderBy: [{ isPrimary: 'desc' as const }, { contact: { displayName: 'asc' as const } }],
        include: { contact: { select: { id: true, displayName: true, status: true, companyId: true, emails: { select: { email: true, isPrimary: true } } } } },
      },
      _count: { select: { messages: true, tasks: true, requirements: true, decisions: true } },
    };
  }

  private contactIds(value: unknown, _mustBeArray: boolean): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 100)) {
      throw new BadRequestException('contactIds must be an array of contact ids');
    }
    const ids = value.map((item) => (item as string).trim());
    if (new Set(ids).size !== ids.length) throw new BadRequestException('contactIds must not contain duplicates');
    return ids.sort();
  }

  private projectState(statusValue: unknown, stageValue: unknown, currentStatus: string, currentStage: string) {
    const status = statusValue === undefined ? currentStatus : this.requiredText(statusValue, 'Project status', 40).toLowerCase();
    const stage = stageValue === undefined ? currentStage : this.requiredText(stageValue, 'Project stage', 80).toLowerCase();
    if (!['active', 'completed'].includes(status)) throw new BadRequestException('Project status must be active or completed');
    if (!PROJECT_STAGES.has(stage)) throw new BadRequestException('Unsupported project stage');
    const consistent = (status === 'completed') === (stage === 'completed');
    if (!consistent) throw new BadRequestException({
      code: 'PROJECT_STATUS_STAGE_MISMATCH',
      message: 'status=completed and stage=completed must change together in the same request',
      status,
      stage,
    });
    return { status, stage };
  }

  private requiredVersion(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new BadRequestException('expectedVersion must be a positive integer');
    return value as number;
  }

  private async lockContacts(tx: Prisma.TransactionClient, contactIds: string[]) {
    const ids = [...new Set(contactIds)].sort();
    if (ids.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Contact" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
  }

  private async lockCompanies(tx: Prisma.TransactionClient, companyIds: Array<string | null>) {
    const ids = [...new Set(companyIds.filter((id): id is string => Boolean(id)))].sort();
    if (ids.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Company" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
  }

  private async assertCompanyContacts(tx: Prisma.TransactionClient, companyId: string, contactIds: string[]) {
    if (!contactIds.length) throw new BadRequestException('A project requires at least one contact from its company');
    await this.lockContacts(tx, contactIds);
    const rows = await tx.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, companyId: true, status: true } });
    const invalid = rows.filter((item) => item.status !== 'confirmed' || item.companyId !== companyId).map(({ id, companyId: currentCompanyId, status }) => ({ id, companyId: currentCompanyId, status }));
    if (rows.length !== contactIds.length || invalid.length) {
      throw new ConflictException({ code: 'PROJECT_CONTACT_MUST_BELONG_TO_COMPANY', companyId, invalidContactIds: invalid });
    }
  }

  private async applyManualMessageAssignment(
    tx: Prisma.TransactionClient,
    message: { id: string; projectAssignmentVersion: number },
    data: Prisma.EmailMessageUpdateManyMutationInput,
    evidence: Record<string, unknown>,
  ) {
    const changed = await tx.emailMessage.updateMany({
      where: { id: message.id, projectAssignmentVersion: message.projectAssignmentVersion },
      data: {
        ...data,
        projectAssignmentVersion: { increment: 1 },
        projectResolutionEvidence: { ...evidence, source: 'manual', assignedAt: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
    if (!changed.count) throw new ConflictException({ code: 'PROJECT_ASSIGNMENT_VERSION_CONFLICT', messageId: message.id });
  }

  private async invalidateProjectSummaries(tx: Prisma.TransactionClient, projectIds: Array<string | null>, reason: string) {
    const ids = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
    if (ids.length) await this.projectAnalysis.invalidateProjectSummaries(tx, ids, reason);
  }

  private assertAllowedFields(input: Record<string, unknown>, allowed: string[]) {
    for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new BadRequestException(`Unsupported field ${key}`);
  }

  private requiredText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new BadRequestException(`${label} is required and must be at most ${maxLength} characters`);
    return value.trim();
  }

  private optionalText(value: unknown, maxLength: number): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.trim().length > maxLength) throw new BadRequestException(`Text must be at most ${maxLength} characters`);
    return value.trim() || null;
  }

  private optionalId(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new BadRequestException('Invalid entity id');
    return value.trim();
  }

  private uniqueConflict(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
  }

  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) {
      throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED', message: 'IMAP is not configured' });
    }
    const account = await this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY', message: 'IMAP account is not ready' });
    return account;
  }
}
