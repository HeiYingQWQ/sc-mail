import { emailThreadNavigation } from './email-thread';
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { currentEmailBody, quotedParentBodies, readableEmailBody } from './email-body';

@Injectable()
export class BusinessBriefService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async get(dateInput?: string, fromEmailInput?: string, includeEmails = true) {
    const generatedAt = new Date();
    const timezone = this.config.get<string>('BUSINESS_TIMEZONE', 'Europe/Rome');
    const date = dateInput || 'today';
    const today = this.localDate(generatedAt, timezone);
    const targetDay = date === 'today' ? today : date === 'yesterday' ? this.addDays(today, -1) : date;
    const parsedDay = Date.parse(`${targetDay}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDay) || Number.isNaN(parsedDay) || new Date(parsedDay).toISOString().slice(0, 10) !== targetDay) throw new BadRequestException('date must be today, yesterday, or YYYY-MM-DD');
    const from = this.boundary(targetDay, timezone);
    const until = this.boundary(this.addDays(targetDay, 1), timezone);
    const language = this.config.get<string>('DAILY_BRIEF_LANGUAGE', 'zh-CN');
    const style = this.config.get<string>('DAILY_BRIEF_STYLE', 'concise');
    const waitingThresholdDays = this.config.get<number>('DAILY_BRIEF_WAITING_THRESHOLD_DAYS', 7);
    const followUpWindowDays = this.config.get<number>('DAILY_BRIEF_FOLLOW_UP_WINDOW_DAYS', 7);
    const notifyWhenEmpty = this.config.get<boolean>('DAILY_BRIEF_NOTIFY_WHEN_EMPTY', false);
    const sender = fromEmailInput?.trim().toLowerCase();
    if (sender && (sender.length > 254 || !sender.includes('@'))) throw new BadRequestException('fromEmail must be a valid email address');
    const accountEmail = this.config.get<string>('IMAP_EMAIL');
    if (!accountEmail || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email: accountEmail }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY' });
    // PostgreSQL filters the normalized JSON address before pagination, including older mixed-case addresses.
    const senderIds = sender ? await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "EmailMessage"
      WHERE "mailAccountId" = ${account.id} AND "direction" = 'inbound'
        AND "receivedAt" >= ${from} AND "receivedAt" < ${until}
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof("fromJson") = 'array' THEN "fromJson" ELSE '[]'::jsonb END
        ) AS sender WHERE lower(sender->>'address') = ${sender})
    `) : null;
    const where = { mailAccountId: account.id, direction: 'inbound', receivedAt: { gte: from, lt: until },
      ...(senderIds ? { id: { in: senderIds.map(item => item.id) } } : {}) };
    const taskWhere: Prisma.TaskWhereInput = {
      status: { notIn: ['done', 'cancelled'] },
      OR: [{ createdFromMessage: { mailAccountId: account.id } }, { project: { messages: { some: { mailAccountId: account.id } } } }, { project: { messages: { none: {} } } }, { projectId: null, topicId: null, createdFromMessageId: null }],
    };
    const correctionWhere = { eventType: 'MAIL_RECONCILIATION_CORRECTED', entityId: account.id, createdAt: { gte: from, lt: until } };
    const [total, tasks, taskTotal, ourTaskTotal, reviews, reviewTotal, checkpoints, categories, newLeads, newLeadTotal, correctionEvents, correctionEventTotal, reconciliation, triageStatusGroups] = await this.prisma.$transaction([
      this.prisma.emailMessage.count({ where }),
      this.prisma.task.findMany({ where: taskWhere, orderBy: [{ deadlineAt: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }], take: 501, select: { id: true, title: true, status: true, priority: true, ownerType: true, deadlineAt: true, deadlineDate: true, deadlineTimezone: true, waitingOn: true, waitingSince: true, project: { select: { id: true, name: true } } } }),
      this.prisma.task.count({ where: taskWhere }),
      this.prisma.task.count({ where: { ...taskWhere, ownerType: 'us' } }),
      this.prisma.reviewItem.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, reasonCode: true, entityType: true, sourceMessageId: true, createdAt: true } }),
      this.prisma.reviewItem.count({ where: { status: 'pending' } }),
      this.prisma.syncCheckpoint.findMany({ where: { mailAccountId: account.id }, orderBy: { mailbox: 'asc' }, select: { mailbox: true, lastSuccessfulSyncAt: true, lastPolledAt: true, lastErrorCode: true, status: true } }),
      this.prisma.emailMessage.groupBy({ by: ['classification'], where, orderBy: { classification: 'asc' }, _count: { _all: true } }),
      this.prisma.project.findMany({ where: { stage: 'lead', status: 'active', createdAt: { gte: from, lt: until }, OR: [{ messages: { some: { mailAccountId: account.id } } }, { messages: { none: {} } }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, select: { id: true, name: true, createdAt: true, company: { select: { id: true, name: true } } } }),
      this.prisma.project.count({ where: { stage: 'lead', status: 'active', createdAt: { gte: from, lt: until }, OR: [{ messages: { some: { mailAccountId: account.id } } }, { messages: { none: {} } }] } }),
      this.prisma.agentEvent.findMany({ where: correctionWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, select: { id: true, createdAt: true, payloadJson: true } }),
      this.prisma.agentEvent.count({ where: correctionWhere }),
      this.prisma.mailReconciliationCheckpoint.findUnique({ where: { mailAccountId: account.id }, select: { status: true, lastAuditCompletedAt: true, scannedCount: true, importedCount: true, processingRecordsCreated: true, crmRepaired: true, needsReviewCount: true, lastErrorCode: true } }),
      this.prisma.emailImportanceTriage.groupBy({ by: ['status'], where: { mailAccountId: account.id }, orderBy: { status: 'asc' }, _count: { _all: true } }),
    ]);
    const rows = includeEmails ? await this.prisma.emailMessage.findMany({ where, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 201, select: { id: true, subject: true, fromJson: true, bodyText: true, receivedAt: true, classification: true, contact: { select: { id: true, displayName: true } }, project: { select: { id: true, name: true } }, topic: { select: { id: true, name: true } } } }) : [];
    const scannedTasks = tasks.slice(0, 500);
    const taskScanComplete = taskTotal <= 500;
    const waitingTasks = scannedTasks.filter((task) => task.status === 'waiting' && task.waitingOn !== 'none');
    const waitingForCustomer = waitingTasks.filter((task) => task.waitingOn === 'customer');
    const waitingWithAge = waitingForCustomer.map((task) => ({ ...task, daysWaiting: task.waitingSince ? this.dayDifference(this.localDate(task.waitingSince, timezone), today) : null }));
    const waitingOverThreshold = waitingWithAge.filter((task) => task.daysWaiting !== null && task.daysWaiting >= waitingThresholdDays);
    const dueGroups = { overdue: [] as Array<Record<string, unknown>>, dueToday: [] as Array<Record<string, unknown>>, upcoming: [] as Array<Record<string, unknown>> };
    const waitingByParty: Record<string, number> = {};
    for (const task of scannedTasks) {
      if (task.status === 'waiting' && task.waitingOn !== 'none') waitingByParty[task.waitingOn] = (waitingByParty[task.waitingOn] ?? 0) + 1;
      if (task.ownerType !== 'us') continue;
      const deadlineTimezone = task.deadlineDate ? this.validTimezone(task.deadlineTimezone, timezone) : timezone;
      const dueDate = task.deadlineAt ? this.localDate(task.deadlineAt, timezone) : task.deadlineDate;
      if (!dueDate) continue;
      const relativeToday = task.deadlineAt ? today : this.localDate(generatedAt, deadlineTimezone);
      const daysUntilDue = this.dayDifference(relativeToday, dueDate);
      const entry = { id: task.id, title: task.title, status: task.status, priority: task.priority, deadlineAt: task.deadlineAt, deadlineDate: task.deadlineDate, deadlineTimezone: task.deadlineTimezone, project: task.project };
      if (task.deadlineAt ? task.deadlineAt < generatedAt : daysUntilDue < 0) dueGroups.overdue.push(entry);
      else if (daysUntilDue === 0) dueGroups.dueToday.push(entry);
      else if (daysUntilDue <= followUpWindowDays) dueGroups.upcoming.push(entry);
    }
    for (const group of Object.values(dueGroups)) group.sort((a, b) => String(a.deadlineAt ?? a.deadlineDate).localeCompare(String(b.deadlineAt ?? b.deadlineDate)));
    const correctionSummary = correctionEvents.slice(0, 20).reduce((sum, event) => {
      const payload = event.payloadJson && typeof event.payloadJson === 'object' ? event.payloadJson as Record<string, unknown> : {};
      for (const key of ['importedCount', 'processingRecordsCreated', 'crmRepaired', 'needsReviewCount']) sum[key] = (sum[key] ?? 0) + this.safeCount(payload[key]);
      return sum;
    }, { importedCount: 0, processingRecordsCreated: 0, crmRepaired: 0, needsReviewCount: 0 } as Record<string, number>);
    const categoriesByName = Object.fromEntries(categories.map((entry) => [entry.classification, typeof entry._count === 'object' && entry._count ? entry._count._all ?? 0 : 0]));
    const triageCounts = { review: 0, failed: 0, pending: 0 };
    for (const group of triageStatusGroups) {
      if (group.status in triageCounts) {
        triageCounts[group.status as keyof typeof triageCounts] = typeof group._count === 'object' && group._count ? group._count._all ?? 0 : 0;
      }
    }
    return {
      date: targetDay, timezone, rangeUtc: { from: from.toISOString(), until: until.toISOString() },
      preferences: { language, style, waitingThresholdDays, followUpWindowDays, notifyWhenEmpty },
      emails: rows.slice(0, 200).map((message) => ({ id: message.id, subject: message.subject, from: message.fromJson, receivedAt: message.receivedAt, classification: message.classification, contact: message.contact, project: message.project, topic: message.topic, excerpt: message.bodyText?.slice(0, 700) ?? null, excerptIsUntrustedEmailContent: true })),
      total,
      matchedInScannedMessages: sender && includeEmails ? rows.length : undefined,
      truncated: includeEmails && total > 200,
      openTasks: tasks.slice(0, 100).map(({ id, title, status, priority, deadlineAt, waitingOn, project }) => ({ id, title, status, priority, deadlineAt, waitingOn, project })), pendingReviews: reviews,
      followUps: {
        asOfDate: today, generatedAt: generatedAt.toISOString(), taskTotal, ourTaskTotal, openTasksComplete: taskTotal <= 100, taskScanLimit: 500, taskScanComplete,
        countsAreLowerBounds: !taskScanComplete,
        overdue: { count: dueGroups.overdue.length, complete: taskScanComplete && dueGroups.overdue.length <= 20, tasks: dueGroups.overdue.slice(0, 20) },
        dueToday: { count: dueGroups.dueToday.length, complete: taskScanComplete && dueGroups.dueToday.length <= 20, tasks: dueGroups.dueToday.slice(0, 20) },
        upcoming: { count: dueGroups.upcoming.length, complete: taskScanComplete && dueGroups.upcoming.length <= 20, tasks: dueGroups.upcoming.slice(0, 20) },
        waitingByParty,
        waitingForCustomer: { count: waitingWithAge.length, overThresholdCount: waitingOverThreshold.length, missingStartCount: waitingWithAge.filter((task) => task.daysWaiting === null).length, complete: taskScanComplete && waitingOverThreshold.length <= 20, tasks: waitingOverThreshold.slice(0, 20).map(({ id, title, daysWaiting, waitingSince, project }) => ({ id, title, daysWaiting, waitingSince, project })) },
      },
      audit: {
        newLeads: { count: newLeadTotal, complete: newLeadTotal <= 20, projects: newLeads.slice(0, 20) },
        pendingReviews: { count: reviewTotal, complete: reviewTotal <= 50, items: reviews },
        emailImportanceTriage: {
          asOf: generatedAt.toISOString(),
          pendingCount: triageCounts.pending,
          reviewCount: triageCounts.review,
          failedCount: triageCounts.failed,
        },
      inboundClassifications: { count: total, actionableCount: (categoriesByName.BUSINESS_HUMAN ?? 0) + (categoriesByName.UNKNOWN ?? 0), byClassification: categoriesByName },
        reconciliation: { status: reconciliation?.status ?? 'not_started', lastCompletedAt: reconciliation?.lastAuditCompletedAt ?? null, correctionEventCount: correctionEventTotal, correctionEventsComplete: correctionEventTotal <= 20, totals: correctionSummary, events: correctionEvents.slice(0, 20).map(({ id, createdAt }) => ({ id, createdAt })) },
        syncErrors: checkpoints.filter((item) => item.status === 'failed' || item.lastErrorCode).map(({ mailbox, status, lastErrorCode }) => ({ mailbox, status, code: lastErrorCode })),
      },
      freshness: { generatedAt: generatedAt.toISOString(), mailboxes: checkpoints, taskLimit: 100, reviewLimit: 50, taskScanLimit: 500, taskScanComplete, emailBodiesIncluded: includeEmails },
    };
  }

  async contactMessages(contactId: string, limit = 20, offset = 0, includeBodies = false, filters: { projectId?: string; fromDate?: string; throughDate?: string; direction?: string } = {}) {
    const accountEmail = this.config.get<string>('IMAP_EMAIL');
    if (!accountEmail || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email: accountEmail }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY' });
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, status: 'confirmed' }, select: { id: true, displayName: true, status: true, version: true, notes: true, emails: { select: { email: true, isPrimary: true, verified: true }, orderBy: [{ isPrimary: 'desc' }, { email: 'asc' }] }, company: { select: { id: true, name: true } } } });
    if (!contact) throw new NotFoundException('Contact not found in the configured mailbox');
    const addresses = [...new Set(contact.emails.map(item => item.email.trim().toLowerCase()))];
    const dateFilter = this.mailDateFilter(filters.fromDate, filters.throughDate);
    const timeColumn = Prisma.sql`COALESCE(m."receivedAt", m."sentAt")`;
    const timeClause = Prisma.sql`${dateFilter.from ? Prisma.sql`AND ${timeColumn} >= ${dateFilter.from}` : Prisma.empty}
      ${dateFilter.until ? Prisma.sql`AND ${timeColumn} < ${dateFilter.until}` : Prisma.empty}`;
    const projectClause = filters.projectId ? Prisma.sql`AND m."projectId" = ${filters.projectId}` : Prisma.empty;
    const directionClause = filters.direction ? Prisma.sql`AND m."direction" = ${filters.direction}` : Prisma.empty;
    const addressesClause = addresses.length ? Prisma.sql`(
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."fromJson")='array' THEN m."fromJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses)})) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."toJson")='array' THEN m."toJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses)})) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."ccJson")='array' THEN m."ccJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses)})) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."bccJson")='array' THEN m."bccJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses)}))
    )` : Prisma.sql`false`;
    const joined = Prisma.sql`FROM "EmailMessage" m WHERE m."mailAccountId"=${account.id} AND ${addressesClause} ${projectClause} ${directionClause} ${timeClause}`;
    const [counts, ids, checkpoints] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`WITH matches AS (SELECT m."id", COALESCE(NULLIF(trim(m."rfcMessageId"), ''), 'provider:' || m."providerMessageId") identity ${joined}), logical AS (SELECT DISTINCT ON (identity) "id" FROM matches ORDER BY identity, "id") SELECT count(*) total FROM logical`),
      this.prisma.$queryRaw<Array<{ id: string; participantRoles: string[]; matchedEmails: string[] }>>(Prisma.sql`WITH matches AS (
        SELECT m."id", COALESCE(NULLIF(trim(m."rfcMessageId"), ''), 'provider:' || m."providerMessageId") identity,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."fromJson")='array' THEN m."fromJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''] )})) THEN 'from' END,
            CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."toJson")='array' THEN m."toJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''] )})) THEN 'to' END,
            CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."ccJson")='array' THEN m."ccJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''] )})) THEN 'cc' END,
            CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."bccJson")='array' THEN m."bccJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''] )})) THEN 'bcc' END
          ]::text[], NULL) "participantRoles",
          ARRAY(SELECT DISTINCT lower(a->>'address') FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(m."fromJson")='array' THEN m."fromJson" ELSE '[]'::jsonb END ||
            CASE WHEN jsonb_typeof(m."toJson")='array' THEN m."toJson" ELSE '[]'::jsonb END ||
            CASE WHEN jsonb_typeof(m."ccJson")='array' THEN m."ccJson" ELSE '[]'::jsonb END ||
            CASE WHEN jsonb_typeof(m."bccJson")='array' THEN m."bccJson" ELSE '[]'::jsonb END
          ) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''])})) "matchedEmails",
          COALESCE(m."receivedAt",m."sentAt") happened
        ${joined}
      ), logical AS (SELECT DISTINCT ON (identity) id,"participantRoles","matchedEmails",happened FROM matches ORDER BY identity,id)
      SELECT id,"participantRoles","matchedEmails" FROM logical ORDER BY happened DESC NULLS LAST,id DESC LIMIT ${limit} OFFSET ${offset}`),
      this.prisma.syncCheckpoint.findMany({ where: { mailAccountId: account.id }, select: { mailbox: true, lastSuccessfulSyncAt: true, lastErrorCode: true, status: true }, orderBy: { mailbox: 'asc' } }),
    ]);
    const messages = await this.prisma.emailMessage.findMany({ where: { id: { in: ids.map(item => item.id) } }, select: { id: true, mailbox: true, rfcMessageId: true, subject: true, direction: true, fromJson: true, toJson: true, ccJson: true, bccJson: true, sentAt: true, receivedAt: true, classification: true, projectId: true, projectResolutionStatus: true, projectReason: true, projectResolutionEvidence: true, projectAssignmentVersion: true, projectManualOverride: true, project: { select: { id: true, name: true, status: true } }, topic: { select: { id: true, name: true } }, bodyText: true } });
    const byId = new Map(messages.map(item => [item.id, item]));
    const total = Number(counts[0]?.total ?? 0n);
    return { contact, total, limit, offset, hasMore: offset + ids.length < total,
      messages: ids.map(item => { const row = byId.get(item.id); if (!row) return null; const { bodyText, ...message } = row; return { ...message, participantRoles: item.participantRoles, matchedEmails: item.matchedEmails,
        excerpt: bodyText?.slice(0, 700) ?? null, excerptIsUntrustedEmailContent: true,
        ...(includeBodies ? { bodyText: bodyText?.slice(0, 3000) ?? null, bodyTruncated: Boolean(bodyText && bodyText.length > 3000), bodyIsUntrustedEmailContent: true } : {}),
      }; }).filter((item): item is NonNullable<typeof item> => Boolean(item)),
      freshness: { generatedAt: new Date().toISOString(), mailboxes: checkpoints } };
  }

  async projectMessages(projectId: string, limit = 20, offset = 0, filters: { contactId?: string; fromDate?: string; throughDate?: string; direction?: string } = {}) {
    const accountEmail = this.config.get<string>('IMAP_EMAIL');
    if (!accountEmail || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email: accountEmail }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY' });
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, status: true, company: { select: { id: true, name: true } } } });
    if (!project) throw new NotFoundException('Project not found');
    let addresses: string[] = [];
    if (filters.contactId) {
      const member = await this.prisma.projectContact.findUnique({ where: { projectId_contactId: { projectId, contactId: filters.contactId } }, select: { contact: { select: { id: true, displayName: true, emails: { select: { email: true } } } } } });
      if (!member) throw new BadRequestException('contactId must be a member of this project');
      addresses = [...new Set(member.contact.emails.map((item) => item.email.trim().toLowerCase()))];
    }
    const dateFilter = this.mailDateFilter(filters.fromDate, filters.throughDate);
    const timeColumn = Prisma.sql`COALESCE(m."receivedAt", m."sentAt")`;
    const timeClause = Prisma.sql`${dateFilter.from ? Prisma.sql`AND ${timeColumn} >= ${dateFilter.from}` : Prisma.empty}
      ${dateFilter.until ? Prisma.sql`AND ${timeColumn} < ${dateFilter.until}` : Prisma.empty}`;
    const directionClause = filters.direction ? Prisma.sql`AND m."direction" = ${filters.direction}` : Prisma.empty;
    const memberClause = filters.contactId ? Prisma.sql`AND (
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."fromJson")='array' THEN m."fromJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''])})) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."toJson")='array' THEN m."toJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''])})) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."ccJson")='array' THEN m."ccJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''])})) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."bccJson")='array' THEN m."bccJson" ELSE '[]'::jsonb END) a WHERE lower(a->>'address') IN (${Prisma.join(addresses.length ? addresses : [''])}))
    )` : Prisma.empty;
    const joined = Prisma.sql`FROM "EmailMessage" m WHERE m."mailAccountId"=${account.id} AND m."projectId"=${projectId} ${directionClause} ${timeClause} ${memberClause}`;
    const [counts, ids, checkpoints] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`WITH matches AS (SELECT m."id", COALESCE(NULLIF(trim(m."rfcMessageId"), ''), 'provider:' || m."providerMessageId") identity ${joined}), logical AS (SELECT DISTINCT ON (identity) "id" FROM matches ORDER BY identity,"id") SELECT count(*) total FROM logical`),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`WITH matches AS (SELECT m."id", COALESCE(NULLIF(trim(m."rfcMessageId"), ''), 'provider:' || m."providerMessageId") identity, ${timeColumn} happened ${joined}), logical AS (SELECT DISTINCT ON (identity) id,happened FROM matches ORDER BY identity,id) SELECT id FROM logical ORDER BY happened DESC NULLS LAST,id DESC LIMIT ${limit} OFFSET ${offset}`),
      this.prisma.syncCheckpoint.findMany({ where: { mailAccountId: account.id }, select: { mailbox: true, lastSuccessfulSyncAt: true, lastErrorCode: true, status: true }, orderBy: { mailbox: 'asc' } }),
    ]);
    const messages = await this.prisma.emailMessage.findMany({ where: { id: { in: ids.map(item => item.id) } }, select: { id: true, mailbox: true, rfcMessageId: true, direction: true, subject: true, fromJson: true, toJson: true, ccJson: true, bccJson: true, sentAt: true, receivedAt: true, classification: true, projectId: true, projectResolutionStatus: true, projectConfidence: true, projectReason: true, projectResolutionEvidence: true, projectAssignmentVersion: true, projectManualOverride: true, project: { select: { id: true, name: true, status: true } }, company: { select: { id: true, name: true } }, contact: { select: { id: true, displayName: true } }, topic: { select: { id: true, name: true } }, bodyText: true } });
    const byId = new Map(messages.map(item => [item.id, item]));
    const total = Number(counts[0]?.total ?? 0n);
    return { project, total, limit, offset, hasMore: offset + ids.length < total,
      messages: ids.map(item => { const row = byId.get(item.id); return row ? { ...row, excerpt: row.bodyText?.slice(0, 700) ?? null, excerptIsUntrustedEmailContent: true } : null; }).filter((item): item is NonNullable<typeof item> => Boolean(item)),
      freshness: { generatedAt: new Date().toISOString(), mailboxes: checkpoints } };
  }

  async contactDecisions(contactId: string, limit = 20, offset = 0) {
    const { account, contact, addresses } = await this.contactContext(contactId);
    const recipientMatch = addresses.length ? Prisma.sql`OR (m."direction" IN ('outbound', 'internal') AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(m."toJson") = 'array' THEN m."toJson" ELSE '[]'::jsonb END ||
        CASE WHEN jsonb_typeof(m."ccJson") = 'array' THEN m."ccJson" ELSE '[]'::jsonb END ||
        CASE WHEN jsonb_typeof(m."bccJson") = 'array' THEN m."bccJson" ELSE '[]'::jsonb END
      ) AS recipient WHERE lower(recipient->>'address') IN (${Prisma.join(addresses)})
    )) OR (m."direction" = 'inbound' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."fromJson") = 'array' THEN m."fromJson" ELSE '[]'::jsonb END)
      AS sender WHERE lower(sender->>'address') IN (${Prisma.join(addresses)})
    ))` : Prisma.empty;
    const condition = Prisma.sql`((d."decidedByContactId" = ${contactId} AND (d."sourceMessageId" IS NULL OR m."mailAccountId" = ${account.id}))
      OR (m."mailAccountId" = ${account.id} AND (m."contactId" = ${contactId} ${recipientMatch})))`;
    const source = Prisma.sql`FROM "Decision" d LEFT JOIN "EmailMessage" m ON m."id" = d."sourceMessageId" WHERE ${condition}`;
    const [counts, ids] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT count(*) AS total ${source}`),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT d."id" ${source} ORDER BY d."createdAt" DESC, d."id" DESC LIMIT ${limit} OFFSET ${offset}`),
    ]);
    const decisions = await this.prisma.decision.findMany({ where: { id: { in: ids.map(item => item.id) } }, select: {
      id: true, text: true, status: true, decidedAt: true, createdAt: true, manualOverride: true, sourceDeletedAt: true,
      decidedByContactId: true, project: { select: { id: true, name: true } },
      sourceMessage: { select: { id: true, subject: true, direction: true, sentAt: true, receivedAt: true } },
    } });
    const byId = new Map(decisions.map(item => [item.id, item]));
    return { contact, total: Number(counts[0].total), limit, offset,
      decisions: ids.map(item => byId.get(item.id)).filter((item): item is (typeof decisions)[number] => Boolean(item)) };
  }

  async contactReplyStatus(contactId: string) {
    const { account, contact, addresses } = await this.contactContext(contactId);
    const freshness = { generatedAt: new Date().toISOString(), mailboxes: await this.prisma.syncCheckpoint.findMany({ where: { mailAccountId: account.id }, select: { mailbox: true, lastSuccessfulSyncAt: true, lastErrorCode: true, status: true }, orderBy: { mailbox: 'asc' } }) };
    if (!addresses.length) return { contact, status: 'no_sent_mail_observed', latestSent: null, directReply: null, latestHumanAfter: null, latestInboundAfter: null, freshness };
    const recipients = Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof("toJson") = 'array' THEN "toJson" ELSE '[]'::jsonb END ||
      CASE WHEN jsonb_typeof("ccJson") = 'array' THEN "ccJson" ELSE '[]'::jsonb END ||
      CASE WHEN jsonb_typeof("bccJson") = 'array' THEN "bccJson" ELSE '[]'::jsonb END
    ) AS recipient WHERE lower(recipient->>'address') IN (${Prisma.join(addresses)}))`;
    const sentIds = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "EmailMessage"
      WHERE "mailAccountId" = ${account.id} AND "direction" = 'outbound' AND ${recipients}
      ORDER BY COALESCE("sentAt", "receivedAt") DESC NULLS LAST, "id" DESC LIMIT 1`);
    const latestSent = sentIds[0] ? await this.prisma.emailMessage.findUnique({ where: { id: sentIds[0].id }, select: {
      id: true, subject: true, rfcMessageId: true, threadId: true, sentAt: true, receivedAt: true, toJson: true, ccJson: true, bccJson: true, bodyText: true,
    } }) : null;
    if (!latestSent) return { contact, status: 'no_sent_mail_observed', latestSent: null, directReply: null, latestHumanAfter: null, latestInboundAfter: null, freshness };
    const sentTime = latestSent.sentAt ?? latestSent.receivedAt;
    const sentSummary = { id: latestSent.id, subject: latestSent.subject, sentAt: sentTime, toJson: latestSent.toJson, ccJson: latestSent.ccJson, bccJson: latestSent.bccJson,
      excerpt: latestSent.bodyText?.slice(0, 700) ?? null, excerptIsUntrustedEmailContent: true };
    if (!sentTime) return { contact, status: 'sent_time_unknown', latestSent: sentSummary, directReply: null, latestHumanAfter: null, latestInboundAfter: null, freshness };
    const inbound = Prisma.sql`"mailAccountId" = ${account.id} AND "direction" = 'inbound'
      AND COALESCE("receivedAt", "sentAt") > ${sentTime}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("fromJson") = 'array' THEN "fromJson" ELSE '[]'::jsonb END)
        AS sender WHERE lower(sender->>'address') IN (${Prisma.join(addresses)}))`;
    const rfc = latestSent.rfcMessageId?.trim().toLowerCase();
    const direct = rfc ? Prisma.sql`AND (lower("headersJson"->>'inReplyTo') = ${rfc} OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof("headersJson"->'references') = 'array' THEN "headersJson"->'references' ELSE '[]'::jsonb END)
      AS reference WHERE lower(reference) = ${rfc}))` : Prisma.sql`AND false`;
    const [directIds, humanIds, inboundIds] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "EmailMessage" WHERE ${inbound} ${direct} AND "classification" IN ('BUSINESS_HUMAN', 'UNKNOWN') ORDER BY CASE WHEN "classification" = 'BUSINESS_HUMAN' THEN 0 ELSE 1 END, COALESCE("receivedAt", "sentAt") DESC, "id" DESC LIMIT 2`),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "EmailMessage" WHERE ${inbound} AND "classification" = 'BUSINESS_HUMAN' ORDER BY COALESCE("receivedAt", "sentAt") DESC, "id" DESC LIMIT 1`),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "EmailMessage" WHERE ${inbound} ORDER BY COALESCE("receivedAt", "sentAt") DESC, "id" DESC LIMIT 1`),
    ]);
    const candidateIds = [...new Set([...directIds, ...humanIds, ...inboundIds].map(item => item.id))];
    const candidates = await this.prisma.emailMessage.findMany({ where: { id: { in: candidateIds } }, select: {
      id: true, subject: true, direction: true, classification: true, threadId: true, receivedAt: true, sentAt: true, bodyText: true,
    } });
    const byId = new Map(candidates.map(item => [item.id, item]));
    const summary = (id?: string) => { const row = id ? byId.get(id) : null; return row ? { id: row.id, subject: row.subject, classification: row.classification,
      receivedAt: row.receivedAt ?? row.sentAt, sameThread: Boolean(latestSent.threadId && row.threadId === latestSent.threadId),
      excerpt: row.bodyText?.slice(0, 700) ?? null, excerptIsUntrustedEmailContent: true } : null; };
    const directHuman = directIds.find(item => byId.get(item.id)?.classification === 'BUSINESS_HUMAN');
    const directReply = summary(directHuman?.id ?? directIds[0]?.id);
    const latestHumanAfter = summary(humanIds[0]?.id);
    const latestInboundAfter = summary(inboundIds[0]?.id);
    const status = directHuman ? 'direct_human_reply' : directReply ? 'possible_direct_reply' : latestHumanAfter?.sameThread ? 'same_thread_human_message' : latestHumanAfter ? 'later_human_message' : 'no_human_reply_observed';
    return { contact, status, latestSent: sentSummary, directReply, latestHumanAfter, latestInboundAfter, freshness };
  }

  private async contactContext(contactId: string) {
    const accountEmail = this.config.get<string>('IMAP_EMAIL');
    if (!accountEmail || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email: accountEmail }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY' });
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, displayName: true, status: true, emails: { select: { email: true } }, company: { select: { id: true, name: true } } } });
    if (!contact) throw new NotFoundException('Contact not found in the configured mailbox');
    return { account, contact, addresses: [...new Set(contact.emails.map(item => item.email.trim().toLowerCase()))] };
  }

  async sentEmails(dateInput?: string, toEmailInput?: string, limit = 20, offset = 0) {
    const accountEmail = this.config.get<string>('IMAP_EMAIL');
    if (!accountEmail || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email: accountEmail }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY' });
    const timezone = this.config.get<string>('BUSINESS_TIMEZONE', 'Europe/Rome');
    const today = this.localDate(new Date(), timezone);
    const date = dateInput === 'today' ? today : dateInput === 'yesterday' ? this.addDays(today, -1) : dateInput;
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) {
      throw new BadRequestException('date must be today, yesterday, or YYYY-MM-DD');
    }
    const recipient = toEmailInput?.trim().toLowerCase();
    if (recipient && (recipient.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) throw new BadRequestException('toEmail must be a valid email address');
    const from = date ? this.boundary(date, timezone) : null;
    const until = date ? this.boundary(this.addDays(date, 1), timezone) : null;
    const condition = Prisma.sql`"mailAccountId" = ${account.id} AND "direction" = 'outbound'
      ${from && until ? Prisma.sql`AND COALESCE("sentAt", "receivedAt") >= ${from} AND COALESCE("sentAt", "receivedAt") < ${until}` : Prisma.empty}
      ${recipient ? Prisma.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof("toJson") = 'array' THEN "toJson" ELSE '[]'::jsonb END ||
        CASE WHEN jsonb_typeof("ccJson") = 'array' THEN "ccJson" ELSE '[]'::jsonb END ||
        CASE WHEN jsonb_typeof("bccJson") = 'array' THEN "bccJson" ELSE '[]'::jsonb END
      ) AS address WHERE lower(address->>'address') = ${recipient})` : Prisma.empty}`;
    const [counts, ids, checkpoints] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT count(*) AS total FROM "EmailMessage" WHERE ${condition}`),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "EmailMessage" WHERE ${condition}
        ORDER BY COALESCE("sentAt", "receivedAt") DESC NULLS LAST, "id" DESC LIMIT ${limit} OFFSET ${offset}`),
      this.prisma.syncCheckpoint.findMany({ where: { mailAccountId: account.id }, select: { mailbox: true, lastSuccessfulSyncAt: true, lastErrorCode: true, status: true }, orderBy: { mailbox: 'asc' } }),
    ]);
    const messages = await this.prisma.emailMessage.findMany({ where: { id: { in: ids.map(item => item.id) } }, select: { id: true, subject: true, fromJson: true, toJson: true, ccJson: true, sentAt: true, receivedAt: true, mailbox: true } });
    const byId = new Map(messages.map(item => [item.id, item]));
    return { date: date ?? null, timezone, rangeUtc: from && until ? { from: from.toISOString(), until: until.toISOString() } : null,
      toEmail: recipient ?? null, total: Number(counts[0].total), limit, offset,
      messages: ids.map(item => byId.get(item.id)).filter((item): item is (typeof messages)[number] => Boolean(item)),
      freshness: { generatedAt: new Date().toISOString(), mailboxes: checkpoints } };
  }

  async getEmailMessage(messageId: string) {
    if (!messageId.trim() || messageId.length > 100) throw new BadRequestException('messageId is invalid');
    const accountEmail = this.config.get<string>('IMAP_EMAIL');
    if (!accountEmail || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email: accountEmail }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY' });
    const message = await this.prisma.emailMessage.findFirst({
      where: { id: messageId, mailAccountId: account.id },
      select: {
        id: true, direction: true, mailbox: true, subject: true, fromJson: true, toJson: true, ccJson: true, bccJson: true,
        sentAt: true, receivedAt: true, classification: true, reviewRequired: true,
        projectId: true, projectResolutionStatus: true, projectReason: true, projectResolutionEvidence: true,
        projectAssignmentVersion: true, projectManualOverride: true,
        contact: { select: { id: true, displayName: true } },
        project: { select: { id: true, name: true, status: true } },
        topic: { select: { id: true, name: true } },
        bodyText: true, bodyHtml: true, headersJson: true,
      },
    });
    if (!message) throw new NotFoundException('Email message not found in the configured mailbox');
    const limit = 8000;
    const { bodyText, bodyHtml, headersJson, ...metadata } = message;
    const [parents, threadNavigation] = await Promise.all([quotedParentBodies(this.prisma, account.id, headersJson), emailThreadNavigation(this.prisma, account.id, message.id)]);
    const text = currentEmailBody(bodyText, bodyHtml, parents) ?? '';
    const quotedHistoryRemoved = text.trim() !== (readableEmailBody(bodyText, bodyHtml) ?? '').trim();
    return { ...metadata, threadNavigation, quotedHistoryRemoved, bodyText: text.slice(0, limit) || null, bodyTruncated: text.length > limit, bodyIsUntrustedEmailContent: true };
  }

  private localDate(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  }
  private mailDateFilter(fromInput?: string, throughInput?: string) {
    const timezone = this.config.get<string>('BUSINESS_TIMEZONE', 'Europe/Rome');
    const validate = (value: string | undefined, field: string) => {
      if (value === undefined) return undefined;
      const parsed = Date.parse(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
        throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
      }
      return value;
    };
    const fromDay = validate(fromInput, 'fromDate');
    const throughDay = validate(throughInput, 'throughDate');
    if (fromDay && throughDay && fromDay > throughDay) throw new BadRequestException('fromDate must be on or before throughDate');
    return {
      from: fromDay ? this.boundary(fromDay, timezone) : undefined,
      until: throughDay ? this.boundary(this.addDays(throughDay, 1), timezone) : undefined,
    };
  }
  private dayDifference(from: string, to: string) { return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000); }
  private validTimezone(value: string | null, fallback: string) {
    if (!value) return fallback;
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; }
    catch { return fallback; }
  }
  private safeCount(value: unknown) { const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0; return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }
  private addDays(date: string, days: number) { const day = new Date(`${date}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + days); return day.toISOString().slice(0, 10); }
  private boundary(day: string, timezone: string) {
    const [year, month, date] = day.split('-').map(Number);
    const target = Date.UTC(year, month - 1, date, 0, 0, 0);
    let candidate = target;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (let i = 0; i < 3; i++) {
      const parts = formatter.formatToParts(new Date(candidate));
      const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
      candidate += target - Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    }
    return new Date(candidate);
  }
}
