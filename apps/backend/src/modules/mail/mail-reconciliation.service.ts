import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type MailReconciliationCheckpoint } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { InitialSyncService } from './initial-sync.service';
import { ImapMailService } from './imap-mail.service';
import { BusinessGateService } from './business-gate.service';
import { ContactResolverService } from './contact-resolver.service';
import { ProjectReviewService } from './project-review.service';

const LEASE_MS = 15 * 60_000;
const INITIAL_RECONCILIATION_TRIAGE_WINDOW_MS = 24 * 60 * 60_000;
const MAX_PAGES_PER_RUN = 20;

type MailboxCursor = { lastUid: number; targetUid: number | null; uidValidity: string | null; done: boolean };
type MailboxCursors = { [mailbox: string]: MailboxCursor };

@Injectable()
export class MailReconciliationService implements OnModuleInit, OnModuleDestroy {
  private active = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly imap: ImapMailService,
    private readonly initialSync: InitialSyncService,
    private readonly businessGate: BusinessGateService,
    private readonly contacts: ContactResolverService,
    private readonly projects: ProjectReviewService,
    @InjectPinoLogger(MailReconciliationService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('APP_ROLE', 'backend') !== 'worker') return;
    this.active = true;
    void this.schedulerLoop();
  }

  onModuleDestroy() { this.active = false; }

  async status() {
    const account = await this.account();
    if (!account) return { configured: false, status: 'not_configured' };
    const checkpoint = await this.prisma.mailReconciliationCheckpoint.findUnique({ where: { mailAccountId: account.id } });
    return {
      configured: true,
      enabled: this.config.get<boolean>('MAIL_RECONCILIATION_ENABLED', true),
      checkpoint: checkpoint ? {
        status: checkpoint.status, auditFrom: checkpoint.auditFrom, auditThrough: checkpoint.auditThrough,
        lastAuditStartedAt: checkpoint.lastAuditStartedAt, lastAuditCompletedAt: checkpoint.lastAuditCompletedAt,
        scannedCount: checkpoint.scannedCount, importedCount: checkpoint.importedCount,
        processingRecordsCreated: checkpoint.processingRecordsCreated, crmRepaired: checkpoint.crmRepaired,
        needsReviewCount: checkpoint.needsReviewCount, lastErrorCode: checkpoint.lastErrorCode,
        leaseActive: Boolean(checkpoint.leaseExpiresAt && checkpoint.leaseExpiresAt > new Date()),
        folders: Object.entries(this.readCursors(checkpoint.mailboxCursors)).map(([mailbox, cursor]) => ({ mailbox, done: cursor.done, lastUid: cursor.lastUid })),
      } : null,
    };
  }

  async runNow() { return this.runBatch(true); }

  private async schedulerLoop() {
    while (this.active) {
      try { await this.runIfDue(); }
      catch { this.logger.warn({ event: 'mail_reconciliation.scheduler_failed' }, 'Daily mail reconciliation will retry'); }
      await this.pause(60_000);
    }
  }

  private async runIfDue() {
    if (!this.config.get<boolean>('MAIL_RECONCILIATION_ENABLED', true)) return;
    const account = await this.account();
    if (!account) return;
    const checkpoint = await this.prisma.mailReconciliationCheckpoint.upsert({
      where: { mailAccountId: account.id }, create: { mailAccountId: account.id }, update: {},
    });
    const now = new Date();
    const timezone = this.config.get<string>('BUSINESS_TIMEZONE', 'Europe/Rome');
    const localNow = this.localDateTime(now, timezone);
    const scheduledTime = this.config.get<string>('MAIL_RECONCILIATION_TIME', '05:00');
    if (localNow.slice(11, 16) < scheduledTime) return;
    if (checkpoint.status === 'completed' && checkpoint.lastAuditCompletedAt && this.localDateTime(checkpoint.lastAuditCompletedAt, timezone).slice(0, 10) === localNow.slice(0, 10)) return;
    if (checkpoint.nextRunAt > now || (checkpoint.leaseExpiresAt && checkpoint.leaseExpiresAt > now)) return;
    await this.runBatch(false);
  }

  private async runBatch(manual: boolean) {
    const account = await this.account();
    if (!account) return { configured: false, status: 'not_configured' };
    const now = new Date();
    const initial = await this.prisma.mailReconciliationCheckpoint.upsert({
      where: { mailAccountId: account.id }, create: { mailAccountId: account.id }, update: {},
    });
    if (!manual && initial.nextRunAt > now) return { status: initial.status, deferredUntil: initial.nextRunAt };
    const leaseToken = randomUUID();
    const checkpoint = await this.prisma.$transaction(async (tx) => {
      const acquired = await tx.mailReconciliationCheckpoint.updateMany({
        where: { id: initial.id, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        data: { status: 'running', leaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), lastErrorCode: null },
      });
      if (!acquired.count) return null;
      let claimed = await tx.mailReconciliationCheckpoint.findUniqueOrThrow({ where: { id: initial.id } });
      const resume = Boolean(claimed.auditFrom && claimed.auditThrough && ['running', 'failed'].includes(initial.status));
      if (!resume) {
        const range = await tx.syncCheckpoint.aggregate({ where: { mailAccountId: account.id }, _min: { fromDate: true } });
        const auditFrom = claimed.lastAuditCompletedAt
          ? new Date(claimed.lastAuditCompletedAt.getTime() - 60 * 60_000)
          : range._min.fromDate ?? new Date(now.getTime() - this.config.get<number>('IMAP_SYNC_HISTORY_MONTHS', 12) * 30 * 24 * 60 * 60_000);
        claimed = await tx.mailReconciliationCheckpoint.update({
          where: { id: initial.id },
          data: {
            auditFrom, auditThrough: now, mailboxCursors: {}, lastAuditStartedAt: now,
            scannedCount: 0, importedCount: 0, processingRecordsCreated: 0, crmRepaired: 0, needsReviewCount: 0,
          },
        });
      }
      return claimed;
    });
    if (!checkpoint) return { status: 'running', message: 'A reconciliation run already owns the lease' };

    const heartbeat = setInterval(() => { void this.renewLease(checkpoint.id, leaseToken).catch(() => undefined); }, 60_000);
    try {
      // Count repairs before persistPage's upsert can silently recreate a missing record.
      // Keep the counter in the checkpoint so an IMAP/stage retry retains the repair evidence.
      await this.createMissingProcessingRecords(account.id, checkpoint.id, leaseToken);
      const finishedScan = await this.scanMailboxes(account.id, account.email, checkpoint, leaseToken);
      if (!finishedScan) {
        await this.releaseLease(checkpoint.id, leaseToken, { status: 'running', nextRunAt: new Date(Date.now() + 60_000) });
        return this.status();
      }
      await this.createMissingProcessingRecords(account.id, checkpoint.id, leaseToken);
      const crmBefore = await this.crmUnresolvedCount(account.id);
      const classification = await this.businessGate.classifyImported();
      if ('status' in classification && classification.status === 'running') throw new Error('MAIL_RECONCILIATION_STAGE_BUSY');
      const contactResolution = await this.contacts.resolveImported();
      const projectResolution = await this.projects.resolveImported();
      if (contactResolution.status !== 'completed' || projectResolution.status !== 'completed') throw new Error('MAIL_RECONCILIATION_STAGE_BUSY');
      const crmAfter = await this.crmUnresolvedCount(account.id);
      const crmRepaired = Math.max(0, crmBefore - crmAfter);
      const needsReviewCount = await this.updateProcessingRecords(account.id);
      const progress = await this.prisma.mailReconciliationCheckpoint.findUniqueOrThrow({ where: { id: checkpoint.id } });
      const report = {
        auditFrom: checkpoint.auditFrom,
        auditThrough: checkpoint.auditThrough,
        scannedCount: progress.scannedCount,
        importedCount: progress.importedCount,
        processingRecordsCreated: progress.processingRecordsCreated,
        crmRepaired,
        needsReviewCount,
        classificationProcessed: 'processed' in classification ? classification.processed : 0,
        contactsProcessed: 'processed' in contactResolution ? contactResolution.processed : 0,
        projectReviews: 'reviews' in projectResolution ? projectResolution.reviews : 0,
      };
      await this.finishRun(account.id, checkpoint, leaseToken, report);
      return { status: 'completed', ...report };
    } catch (error) {
      const errorCode = this.safeError(error);
      await this.releaseLease(checkpoint.id, leaseToken, {
        status: 'failed', lastErrorCode: errorCode, nextRunAt: new Date(Date.now() + 15 * 60_000),
      }).catch(() => undefined);
      this.logger.warn({ event: 'mail_reconciliation.run_failed', code: errorCode }, 'Mail reconciliation failed; its cursor is retained for retry');
      return { status: 'failed', lastErrorCode: errorCode };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async scanMailboxes(accountId: string, accountEmail: string, checkpoint: MailReconciliationCheckpoint, leaseToken: string) {
    const mailboxes = this.configuredFolders();
    const cursors = this.readCursors(checkpoint.mailboxCursors);
    let pages = 0;
    for (const mailbox of mailboxes) {
      while (!cursors[mailbox]?.done && pages < MAX_PAGES_PER_RUN) {
        await this.renewLease(checkpoint.id, leaseToken);
        const cursor = cursors[mailbox] ?? { lastUid: 0, targetUid: null, uidValidity: null, done: false };
        const page = await this.imap.fetchIncrementalPage(
          accountId, mailbox, cursor.lastUid, this.config.get<number>('IMAP_SYNC_PAGE_SIZE', 25),
          { fromDate: checkpoint.auditFrom!, throughDate: checkpoint.auditThrough! }, cursor.targetUid,
        );
        if (page.uidValidity === null) throw new Error('IMAP did not return UIDVALIDITY');
        if (cursor.uidValidity && cursor.uidValidity !== page.uidValidity.toString()) {
          cursors[mailbox] = { lastUid: 0, targetUid: null, uidValidity: null, done: false };
          await this.saveCursor(checkpoint.id, leaseToken, cursors);
          continue;
        }
        const messages = page.messages.filter((message) => !message.receivedAt || (
          message.receivedAt >= checkpoint.auditFrom! && message.receivedAt <= checkpoint.auditThrough!
        ));
        const imported = await this.initialSync.persistPage({
          accountId, accountEmail, mailbox, uidValidity: page.uidValidity, messages,
          nextUid: page.nextUid, hasMore: page.hasMore, targetUid: page.targetUid,
          throughDate: checkpoint.auditThrough!, auditOnly: true, importanceTriageSource: 'reconciliation',
          importanceTriageCatchupCutoff: checkpoint.lastAuditCompletedAt
            ? new Date(checkpoint.lastAuditCompletedAt.getTime() - 60 * 60_000)
            : new Date(checkpoint.auditThrough!.getTime() - INITIAL_RECONCILIATION_TRIAGE_WINDOW_MS),
        });
        cursors[mailbox] = {
          lastUid: page.nextUid, targetUid: page.targetUid, uidValidity: page.uidValidity.toString(), done: !page.hasMore,
        };
        await this.saveCursor(checkpoint.id, leaseToken, cursors, messages.length, imported);
        pages += 1;
      }
      if (pages >= MAX_PAGES_PER_RUN && mailboxes.some((folder) => !cursors[folder]?.done)) return false;
    }
    return true;
  }

  private async createMissingProcessingRecords(mailAccountId: string, checkpointId: string, leaseToken: string) {
    let created = 0;
    while (true) {
      const messages = await this.prisma.emailMessage.findMany({
        where: { mailAccountId, processingRecord: { is: null } }, orderBy: { id: 'asc' }, take: 100,
        select: { id: true, providerMessageId: true },
      });
      if (!messages.length) return created;
      const result = await this.prisma.$transaction(async (tx) => {
        const inserted = await tx.processingRecord.createMany({
          data: messages.map((message) => ({
            id: randomUUID(), mailAccountId, sourceMessageId: message.id, provider: 'imap',
            providerMessageId: message.providerMessageId, status: 'pending',
          })), skipDuplicates: true,
        });
        const owned = await tx.mailReconciliationCheckpoint.updateMany({
          where: { id: checkpointId, leaseToken },
          data: { processingRecordsCreated: { increment: inserted.count } },
        });
        if (!owned.count) throw new Error('MAIL_RECONCILIATION_LEASE_LOST');
        return inserted;
      });
      if (result.count === 0 && await this.prisma.emailMessage.count({
        where: { id: { in: messages.map((message) => message.id) }, processingRecord: { is: null } },
      })) throw new Error('PROCESSING_RECORD_IDENTITY_CONFLICT');
      created += result.count;
    }
  }

  private async updateProcessingRecords(mailAccountId: string) {
    let cursor: string | undefined;
    let needsReviewCount = 0;
    while (true) {
      const messages = await this.prisma.emailMessage.findMany({
        where: { mailAccountId }, orderBy: { id: 'asc' }, take: 50,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true, providerMessageId: true, classification: true, reviewRequired: true,
          direction: true, contactId: true, contactResolutionStatus: true,
          projectResolutionStatus: true, topicResolutionStatus: true,
          reviewItems: { where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
        },
      });
      if (!messages.length) break;
      for (const message of messages) {
        const blacklisted = message.classification === 'BLACKLISTED';
        const crmUnresolved = message.direction === 'inbound' && message.classification === 'BUSINESS_HUMAN' && (
          !message.contactId || ['unresolved', 'ambiguous', 'provisional'].includes(message.contactResolutionStatus) ||
          ['unresolved', 'ambiguous'].includes(message.projectResolutionStatus) || ['unresolved', 'ambiguous'].includes(message.topicResolutionStatus)
        );
        const needsReview = !blacklisted && (message.classification === 'UNKNOWN' || message.reviewRequired || crmUnresolved || message.reviewItems.length > 0);
        const ignored = blacklisted || ['SPAM', 'DELIVERY_FAILURE', 'DELIVERY_DELAY', 'OUT_OF_OFFICE', 'AUTO_ACKNOWLEDGEMENT', 'TICKET_CONFIRMATION', 'UNSUBSCRIBE', 'NEWSLETTER', 'MARKETING', 'SYSTEM_NOTIFICATION'].includes(message.classification);
        const status = ignored ? 'ignored' : needsReview ? 'needs_review' : 'completed';
        if (needsReview) needsReviewCount += 1;
        await this.prisma.processingRecord.upsert({
          where: { sourceMessageId: message.id },
          create: {
            mailAccountId, sourceMessageId: message.id, provider: 'imap', providerMessageId: message.providerMessageId,
            classification: message.classification, status, processedAt: new Date(), reviewId: message.reviewItems[0]?.id ?? null,
            analysisVersion: 'business-gate.v1',
          },
          update: {
            providerMessageId: message.providerMessageId, classification: message.classification, status,
            processedAt: new Date(), reviewId: message.reviewItems[0]?.id ?? null,
            analysisVersion: 'business-gate.v1', lastError: null,
          },
        });
      }
      cursor = messages.at(-1)?.id;
      if (messages.length < 50) break;
    }
    return needsReviewCount;
  }

  private async crmUnresolvedCount(mailAccountId: string) {
    return this.prisma.emailMessage.count({
      where: {
        mailAccountId, direction: 'inbound', classification: 'BUSINESS_HUMAN',
        OR: [
          { contactId: null }, { contactResolutionStatus: { in: ['unresolved', 'ambiguous'] } },
          { projectResolutionStatus: { in: ['unresolved', 'ambiguous'] } },
          { topicResolutionStatus: { in: ['unresolved', 'ambiguous'] } },
        ],
      },
    });
  }

  private async finishRun(accountId: string, checkpoint: MailReconciliationCheckpoint, leaseToken: string, report: Record<string, unknown>) {
    const corrected = Number(report.importedCount) + Number(report.processingRecordsCreated) + Number(report.crmRepaired);
    await this.prisma.$transaction(async (tx) => {
      const eventKey = `mail-reconciliation:${accountId}:${checkpoint.auditThrough!.toISOString()}`;
      if (corrected > 0) {
        await tx.agentEvent.createMany({
          data: [{
            id: randomUUID(), eventKey, eventType: 'MAIL_RECONCILIATION_CORRECTED', entityType: 'mail_account', entityId: accountId,
            priority: 6, notificationPolicy: 'REVIEW', payloadJson: JSON.parse(JSON.stringify(report)) as Prisma.InputJsonValue,
          }], skipDuplicates: true,
        });
        const event = await tx.agentEvent.findUnique({ where: { eventKey }, select: { id: true } });
        if (event) await tx.agentWakeupDelivery.createMany({ data: [{ id: randomUUID(), eventId: event.id }], skipDuplicates: true });
      }
      const updated = await tx.mailReconciliationCheckpoint.updateMany({
        where: { id: checkpoint.id, leaseToken },
        data: {
          status: 'completed', lastAuditCompletedAt: checkpoint.auditThrough, lastErrorCode: null,
          scannedCount: Number(report.scannedCount), importedCount: Number(report.importedCount),
          processingRecordsCreated: Number(report.processingRecordsCreated), crmRepaired: Number(report.crmRepaired),
          needsReviewCount: Number(report.needsReviewCount), mailboxCursors: {}, leaseToken: null, leaseExpiresAt: null,
          nextRunAt: new Date(checkpoint.auditThrough!.getTime() + 60 * 60_000),
        },
      });
      if (!updated.count) throw new Error('MAIL_RECONCILIATION_LEASE_LOST');
    });
  }

  private async saveCursor(id: string, leaseToken: string, cursors: MailboxCursors, scanned = 0, imported = 0) {
    const updated = await this.prisma.mailReconciliationCheckpoint.updateMany({
      where: { id, leaseToken },
      data: {
        mailboxCursors: JSON.parse(JSON.stringify(cursors)) as Prisma.InputJsonValue,
        scannedCount: { increment: scanned }, importedCount: { increment: imported },
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
    if (!updated.count) throw new Error('MAIL_RECONCILIATION_LEASE_LOST');
  }

  private async renewLease(id: string, leaseToken: string) {
    const updated = await this.prisma.mailReconciliationCheckpoint.updateMany({
      where: { id, leaseToken }, data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    });
    if (!updated.count) throw new Error('MAIL_RECONCILIATION_LEASE_LOST');
  }

  private releaseLease(id: string, leaseToken: string, data: Prisma.MailReconciliationCheckpointUpdateManyMutationInput) {
    return this.prisma.mailReconciliationCheckpoint.updateMany({ where: { id, leaseToken }, data: { ...data, leaseToken: null, leaseExpiresAt: null } });
  }

  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) return null;
    return this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true, email: true } });
  }

  private configuredFolders() {
    return [...new Set(this.config.get<string>('IMAP_SYNC_FOLDERS', 'INBOX').split(',').map((folder) => folder.trim()).filter(Boolean))];
  }

  private readCursors(value: Prisma.JsonValue): MailboxCursors {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as MailboxCursors;
  }

  private localDateTime(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  }

  private safeError(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) return `PRISMA_${error.code}`;
    return error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message) ? error.message.slice(0, 100) : 'MAIL_RECONCILIATION_FAILED';
  }

  private pause(ms: number) { return new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); }); }
}
