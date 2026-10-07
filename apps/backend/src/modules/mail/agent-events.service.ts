import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { GATE_CLASS_LABELS, senderRuleSnapshotAction } from './business-gate.rules';
import { ProjectEmailAnalysisService } from './project-email-analysis.service';
import { SystemMailSendersService } from './system-mail-senders.service';
import { isConfiguredSystemSender } from './business-gate.rules';

type NotificationInput = { requestKey: string; channel: string; recipientRef: string; content: string };

@Injectable()
export class AgentEventsService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly projectAnalysis: ProjectEmailAnalysisService, private readonly systemMailSenders: SystemMailSendersService) {}

  async list(status = 'pending', limit = 50, offset = 0) {
    if (!['pending', 'processing', 'completed', 'ignored', 'failed', 'all'].includes(status)) throw new BadRequestException('Invalid event status');
    const where = status === 'all' ? {} : { status };
    const [total, events] = await this.prisma.$transaction([
      this.prisma.agentEvent.count({ where }),
      this.prisma.agentEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset, select: { id: true, eventKey: true, eventType: true, entityType: true, entityId: true, priority: true, notificationPolicy: true, status: true, attempts: true, maxAttempts: true, nextAttemptAt: true, lastError: true, createdAt: true, processedAt: true } }),
    ]);
    return { total, status, limit, offset, events };
  }

  async createBacklogReviewSummary(operationId: unknown) {
    const operation = this.text(operationId, 'operationId', 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(operation)) throw new BadRequestException('operationId is invalid');
    const eventKey = `backlog-review-summary:${operation}`;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.agentEvent.findUnique({ where: { eventKey } });
      if (existing) return { eventId: existing.id, eventKey, status: existing.status, replayed: true };

      const reviewedEvents = await tx.agentEvent.findMany({
        where: { eventType: { not: 'BACKLOG_REVIEW_SUMMARY' } },
        select: { id: true, eventType: true, status: true, entityId: true },
      });
      const pending = reviewedEvents.filter((event) => event.status === 'pending').length;
      const processing = reviewedEvents.filter((event) => event.status === 'processing').length;
      if (pending || processing) throw new ConflictException({ code: 'EVENT_REVIEW_INCOMPLETE', pending, processing });

      const countsByEvent = await tx.agentEvent.groupBy({
        by: ['eventType', 'status'],
        where: { eventType: { not: 'BACKLOG_REVIEW_SUMMARY' } },
        _count: { _all: true },
      });
      const notificationStates = reviewedEvents.length ? await tx.notificationDelivery.groupBy({
        by: ['channel', 'status'],
        where: { eventId: { in: reviewedEvents.map((event) => event.id) } },
        _count: { _all: true },
      }) : [];
      const sourceMessageIds = reviewedEvents.filter((event) => event.eventType === 'INBOUND_EMAIL_RECEIVED').map((event) => event.entityId);
      const sourceMessages = sourceMessageIds.length ? await tx.emailMessage.groupBy({
        by: ['classification'], where: { id: { in: sourceMessageIds } }, _count: { _all: true },
      }) : [];
      const payload = {
        purpose: 'completed_backlog_review',
        operationId: operation,
        totalEvents: reviewedEvents.length,
        eventCounts: countsByEvent.map(({ eventType, status, _count }) => ({ eventType, status, count: _count._all })),
        mailClassifications: sourceMessages.map(({ classification, _count }) => ({ classification, label: GATE_CLASS_LABELS[classification as keyof typeof GATE_CLASS_LABELS] ?? '待判断', count: _count._all })),
        failures: reviewedEvents.filter((event) => event.status === 'failed').length,
        notificationDeliveries: notificationStates.map(({ channel, status, _count }) => ({ channel, status, count: _count._all })),
      };
      const event = await tx.agentEvent.create({
        data: {
          eventKey, eventType: 'BACKLOG_REVIEW_SUMMARY', entityType: 'agent_event_batch', entityId: operation,
          priority: 10, notificationPolicy: 'REVIEW', payloadJson: payload,
        },
      });
      await tx.agentWakeupDelivery.create({ data: { eventId: event.id } });
      return { eventId: event.id, eventKey, status: event.status, replayed: false, payload };
    });
  }

  async claim(agentId: unknown, limit: number, leaseSeconds: number, eventId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 3600) throw new BadRequestException('Invalid claim limits');
    const agent = this.text(agentId, 'agentId', 120);
    if (eventId !== undefined) this.text(eventId, 'eventId', 100);
    const now = new Date();
    const expires = new Date(now.getTime() + leaseSeconds * 1000);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`UPDATE "AgentEvent" SET "status" = 'failed', "leaseToken" = NULL,
        "assignedAgent" = NULL, "leaseExpiresAt" = NULL, "lastError" = 'Lease expired; retry limit reached'
        WHERE "status" = 'processing' AND "leaseExpiresAt" <= ${now} AND "attempts" >= "maxAttempts"`);
      const eventFilter = eventId ? Prisma.sql`AND "id" = ${eventId}` : Prisma.empty;
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "AgentEvent"
        WHERE "attempts" < "maxAttempts" AND "nextAttemptAt" <= ${now}
          AND ("status" = 'pending' OR ("status" = 'processing' AND "leaseExpiresAt" <= ${now}))
          AND ("eventType" <> 'INBOUND_EMAIL_RECEIVED' OR NOT EXISTS (
            SELECT 1 FROM "ProjectAnalysisItem" item JOIN "ProjectAnalysisJob" job ON job."id" = item."jobId"
            WHERE job."trigger" = 'incoming' AND item."sourceMessageId" = "AgentEvent"."entityId" AND item."status" IN ('pending', 'processing')
          ))
          ${eventFilter}
        ORDER BY "priority" DESC, "createdAt" ASC
        LIMIT ${limit} FOR UPDATE SKIP LOCKED
      `);
      const eligibleIds: string[] = [];
      for (const row of rows) {
        const candidate = await tx.agentEvent.findUniqueOrThrow({ where: { id: row.id }, select: { eventType: true, entityId: true } });
        if (candidate.eventType === 'INBOUND_EMAIL_RECEIVED') {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "EmailMessage" WHERE "id" = ${candidate.entityId} FOR UPDATE`);
          const source = await tx.emailMessage.findUnique({ where: { id: candidate.entityId }, select: { direction: true, fromJson: true } });
          if (source && await isConfiguredSystemSender(source.direction, source.fromJson, (addresses) => this.systemMailSenders.matchSystemSenderAddresses(addresses, tx))) {
            await tx.agentEvent.update({ where: { id: row.id }, data: { status: 'ignored', processedAt: now, lastError: 'SYSTEM_SENDER_SUPPRESSED', assignedAgent: null, leaseToken: null, leaseExpiresAt: null } });
            await tx.agentWakeupDelivery.updateMany({ where: { eventId: row.id, status: 'pending' }, data: { status: 'failed', lastError: 'SYSTEM_SENDER_SUPPRESSED', leaseToken: null, leaseExpiresAt: null } });
            await tx.notificationDelivery.updateMany({ where: { eventId: row.id, status: 'pending' }, data: { status: 'failed', lastError: 'SYSTEM_SENDER_SUPPRESSED', leaseToken: null, leaseExpiresAt: null } });
            continue;
          }
        }
        eligibleIds.push(row.id);
        await tx.agentEvent.update({ where: { id: row.id }, data: { status: 'processing', assignedAgent: agent, leaseToken: randomUUID(), leaseExpiresAt: expires, attempts: { increment: 1 } } });
      }
      return tx.agentEvent.findMany({ where: { id: { in: eligibleIds }, assignedAgent: agent, leaseExpiresAt: expires }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], select: { id: true, eventKey: true, eventType: true, entityType: true, entityId: true, priority: true, payloadJson: true, notificationPolicy: true, attempts: true, maxAttempts: true, leaseToken: true, leaseExpiresAt: true } });
    });
  }

  async getNotification(id: string) {
    const delivery = await this.prisma.notificationDelivery.findUnique({ where: { id } });
    if (!delivery) throw new NotFoundException('Notification request not found');
    return delivery;
  }

  async renew(id: string, body: Record<string, unknown>) {
    this.rejectExtra(body, ['agentId', 'leaseToken', 'leaseSeconds']);
    const agent = this.text(body.agentId, 'agentId', 120); const token = this.text(body.leaseToken, 'leaseToken', 100);
    const seconds = this.integer(body.leaseSeconds, 'leaseSeconds', 10, 3600);
    const now = new Date();
    const updated = await this.prisma.agentEvent.updateMany({ where: { id, status: 'processing', assignedAgent: agent, leaseToken: token, leaseExpiresAt: { gt: now } }, data: { leaseExpiresAt: new Date(now.getTime() + seconds * 1000) } });
    if (!updated.count) throw new ConflictException({ code: 'LEASE_INVALID' });
    return this.prisma.agentEvent.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, leaseExpiresAt: true } });
  }

  async complete(id: string, body: Record<string, unknown>) {
    this.rejectExtra(body, ['agentId', 'leaseToken', 'result', 'notifications']);
    const agent = this.text(body.agentId, 'agentId', 120); const token = this.text(body.leaseToken, 'leaseToken', 100);
    const result = body.result === undefined ? {} : body.result;
    const resultJson = this.json(result);
    let notifications = this.notifications(body.notifications);
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.agentEvent.findUnique({ where: { id } });
      if (!event) throw new NotFoundException('Agent event not found');
      const payload = event.payloadJson && typeof event.payloadJson === 'object' && !Array.isArray(event.payloadJson)
        ? event.payloadJson as Prisma.JsonObject : null;
      let sourceMessage: { direction: string; fromJson: unknown; classification: string; senderRuleSnapshot: unknown; historicalImport: boolean } | null = null;
      if (event.eventType === 'INBOUND_EMAIL_RECEIVED') {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "EmailMessage" WHERE "id" = ${event.entityId} FOR UPDATE`);
        sourceMessage = await tx.emailMessage.findUnique({ where: { id: event.entityId }, select: { direction: true, fromJson: true, classification: true, senderRuleSnapshot: true, historicalImport: true } });
        const systemSender = sourceMessage && await isConfiguredSystemSender(sourceMessage.direction, sourceMessage.fromJson, (addresses) => this.systemMailSenders.matchSystemSenderAddresses(addresses, tx));
        if (systemSender) {
          if (event.status !== 'completed' && (event.status !== 'processing' || event.assignedAgent !== agent || event.leaseToken !== token || !event.leaseExpiresAt || event.leaseExpiresAt <= new Date())) throw new ConflictException({ code: 'LEASE_INVALID' });
          await tx.notificationDelivery.updateMany({ where: { eventId: id, status: 'pending' }, data: { status: 'failed', lastError: 'SYSTEM_SENDER_SUPPRESSED', leaseToken: null, leaseExpiresAt: null } });
          await tx.agentWakeupDelivery.updateMany({ where: { eventId: id, status: 'pending' }, data: { status: 'failed', lastError: 'SYSTEM_SENDER_SUPPRESSED', leaseToken: null, leaseExpiresAt: null } });
          if (event.status === 'processing') {
            const suppressed = await tx.agentEvent.updateMany({ where: { id, status: 'processing', assignedAgent: agent, leaseToken: token, leaseExpiresAt: { gt: new Date() } }, data: { status: 'ignored', payloadJson: { ...(payload ?? {}), systemSenderSuppressed: true } as Prisma.InputJsonValue, resultJson: resultJson as Prisma.InputJsonValue, processedAt: new Date(), lastError: 'SYSTEM_SENDER_SUPPRESSED', leaseToken: null, assignedAgent: null, leaseExpiresAt: null } });
            if (!suppressed.count) throw new ConflictException({ code: 'LEASE_INVALID' });
          }
          return { event: await tx.agentEvent.findUniqueOrThrow({ where: { id } }), notifications: [], replayed: event.status === 'completed', suppressed: true };
        }
      }
      const notificationRequired = payload?.notificationRequired === true;
      const projectRoute = payload?.projectNotification === true ? await this.projectAnalysis.validateProjectNotification(event.entityId, payload, tx) : { allowed: false, hasIndependentReason: false };
      const inboundHighCandidate = event.eventType === 'INBOUND_EMAIL_RECEIVED' &&
        payload?.classification === 'BUSINESS_HUMAN' && ['high', 'urgent'].includes(String(payload.importance));
      const resultObject = resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)
        ? resultJson as Record<string, unknown> : null;
      if (inboundHighCandidate && !notificationRequired && !projectRoute.allowed && typeof resultObject?.actionable !== 'boolean') {
        throw new BadRequestException({ code: 'ACTIONABLE_DECISION_REQUIRED', message: 'result.actionable must be a boolean for a high or urgent inbound email' });
      }
      if (inboundHighCandidate && !notificationRequired && !projectRoute.allowed && resultObject?.actionable === false && notifications.length) {
        throw new ConflictException({ code: 'NON_ACTIONABLE_NOTIFICATION_BLOCKED', message: 'A non-actionable inbound email must complete without notifications' });
      }
      const actionableNotificationRequired = inboundHighCandidate && resultObject?.actionable === true;
      const independentNotificationRequired = notificationRequired || actionableNotificationRequired || projectRoute.hasIndependentReason;
      if (payload?.projectNotification === true && !projectRoute.allowed && !independentNotificationRequired) notifications = [];
      const notificationRequiredCode = notificationRequired ? 'WHITELIST_NOTIFICATION_REQUIRED' : actionableNotificationRequired ? 'ACTIONABLE_NOTIFICATION_REQUIRED' : 'ACTIVE_PROJECT_UPDATE_REQUIRED';
      const mustNotify = notificationRequired || actionableNotificationRequired || projectRoute.allowed;
      if (event.status === 'completed' && this.jsonFingerprint(event.resultJson) === this.jsonFingerprint(resultJson)) {
        if (mustNotify && notifications.length === 0) {
          throw new ConflictException({ code: notificationRequiredCode, message: 'This event requires at least one allowlisted notification request' });
        }
        const deliveries = await tx.notificationDelivery.findMany({ where: { eventId: id } });
        if (deliveries.length !== notifications.length || notifications.some((item) => {
          const prior = deliveries.find((delivery) => delivery.requestKey === item.requestKey);
          return !prior || prior.requestHash !== this.hash({ ...item, eventId: id });
        })) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return { event, notifications: deliveries, replayed: true };
      }
      if (event.status !== 'processing' || event.assignedAgent !== agent || event.leaseToken !== token || !event.leaseExpiresAt || event.leaseExpiresAt <= new Date()) throw new ConflictException({ code: 'LEASE_INVALID' });
      if (event.eventType === 'INBOUND_EMAIL_RECEIVED') {
        const message = sourceMessage;
        if ((!message || message.historicalImport || message.direction !== 'inbound' || message.classification !== 'BUSINESS_HUMAN' ||
          senderRuleSnapshotAction(message.senderRuleSnapshot) === 'blacklist') && (notifications.length || mustNotify)) {
          throw new ConflictException({ code: 'INBOUND_NOTIFICATION_NOT_ELIGIBLE', message: 'The source email is no longer eligible for notification' });
        }
      }
      if (mustNotify && notifications.length === 0) {
        throw new ConflictException({ code: notificationRequiredCode, message: 'This event requires at least one allowlisted notification request' });
      }
      if (notifications.length && !['REALTIME', 'REVIEW'].includes(event.notificationPolicy)) throw new ConflictException({ code: 'NOTIFICATION_POLICY_BLOCKED', policy: event.notificationPolicy });
      const allowedChannels = this.config.get<string>('NOTIFICATION_ALLOWED_CHANNELS', 'telegram').split(',').map((x) => x.trim()).filter(Boolean);
      const allowedRecipients = this.config.get<string>('NOTIFICATION_ALLOWED_RECIPIENTS', '').split(',').map((x) => x.trim()).filter(Boolean);
      const created = [];
      for (const item of notifications) {
        if (!allowedChannels.includes(item.channel) || !allowedRecipients.includes(item.recipientRef)) throw new ConflictException({ code: 'NOTIFICATION_TARGET_NOT_ALLOWED' });
        const requestHash = this.hash({ ...item, eventId: id });
        const found = await tx.notificationDelivery.findUnique({ where: { requestKey: item.requestKey } });
        if (found) {
          if (found.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          created.push(found); continue;
        }
        created.push(await tx.notificationDelivery.create({ data: { ...item, requestHash, eventId: id } }));
      }
      const nextPayload = payload ? { ...payload, ...(resultObject?.actionable === true ? { agentActionable: true, notificationReasons: [...new Set([...(Array.isArray(payload.notificationReasons) ? payload.notificationReasons.filter((value): value is string => typeof value === 'string') : []), 'actionable_intent'])] } : {}), ...(payload.projectNotification === true && !projectRoute.allowed ? { projectNotification: false, projectId: null, projectProjectRouteStale: true } : {}) } : payload;
      const updated = await tx.agentEvent.updateMany({ where: { id, status: 'processing', assignedAgent: agent, leaseToken: token, leaseExpiresAt: { gt: new Date() } }, data: { status: 'completed', payloadJson: nextPayload as Prisma.InputJsonValue, resultJson, processedAt: new Date(), leaseToken: null, assignedAgent: null, leaseExpiresAt: null, lastError: null } });
      if (!updated.count) throw new ConflictException({ code: 'LEASE_INVALID' });
      return { event: await tx.agentEvent.findUniqueOrThrow({ where: { id } }), notifications: created, replayed: false };
    });
  }

  async fail(id: string, body: Record<string, unknown>) {
    this.rejectExtra(body, ['agentId', 'leaseToken', 'error', 'retryable']);
    const agent = this.text(body.agentId, 'agentId', 120); const token = this.text(body.leaseToken, 'leaseToken', 100);
    const error = this.text(body.error, 'error', 1000);
    if (typeof body.retryable !== 'boolean') throw new BadRequestException('retryable must be boolean');
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.agentEvent.findUnique({ where: { id } });
      if (!event) throw new NotFoundException('Agent event not found');
      if (event.status !== 'processing' || event.assignedAgent !== agent || event.leaseToken !== token || !event.leaseExpiresAt || event.leaseExpiresAt <= now) throw new ConflictException({ code: 'LEASE_INVALID' });
      const retry = body.retryable && event.attempts < event.maxAttempts;
      const changed = await tx.agentEvent.updateMany({ where: { id, status: 'processing', leaseToken: token, leaseExpiresAt: { gt: now } }, data: { status: retry ? 'pending' : 'failed', nextAttemptAt: retry ? new Date(now.getTime() + Math.min(3600, 30 * 2 ** Math.max(0, event.attempts - 1)) * 1000) : event.nextAttemptAt, lastError: error.replace(/[\r\n\t]/g, ' ').slice(0, 1000), assignedAgent: null, leaseToken: null, leaseExpiresAt: null } });
      if (!changed.count) throw new ConflictException({ code: 'LEASE_INVALID' });
      return tx.agentEvent.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, attempts: true, nextAttemptAt: true, lastError: true } });
    });
  }

  private notifications(value: unknown): NotificationInput[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 3) throw new BadRequestException('notifications must be an array with at most 3 items');
    return value.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new BadRequestException('Invalid notification');
      const item = entry as Record<string, unknown>; this.rejectExtra(item, ['requestKey', 'channel', 'recipientRef', 'content']);
      return { requestKey: this.text(item.requestKey, 'requestKey', 200), channel: this.text(item.channel, 'channel', 40), recipientRef: this.text(item.recipientRef, 'recipientRef', 200), content: this.text(item.content, 'content', 4000) };
    });
  }
  private json(value: unknown): Prisma.InputJsonValue { if (value === null || typeof value !== 'object') throw new BadRequestException('result must be a JSON object or array'); return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private jsonFingerprint(value: unknown) {
    const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
      : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : input;
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  }
  private text(value: unknown, name: string, max: number) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new BadRequestException(`${name} is invalid`); return value.trim(); }
  private integer(value: unknown, name: string, min: number, max: number) { if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new BadRequestException(`${name} is invalid`); return value; }
  private rejectExtra(body: Record<string, unknown>, allowed: string[]) { for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new BadRequestException(`Unsupported field ${key}`); }
}
