import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { EmailNormalizer, type NormalizedEmail } from './email-normalizer';
import { classifyMail, extractAutomationDetails } from './business-gate.rules';
import { ImapMailService } from './imap-mail.service';
import { nextCheckpointUid, uidValidityChanged } from './sync-cursor.policy';
import { SenderRulesService, type SenderRuleSnapshot } from './sender-rules.service';
import { fromMailboxAddresses, normalizeSystemSenderAddress, senderRuleSnapshotAction } from './business-gate.rules';
import { ProjectEmailAnalysisService } from './project-email-analysis.service';
import { SystemMailSendersService } from './system-mail-senders.service';

const INITIAL_PAGE_STALE_MS = 15 * 60_000;

export class SyncCheckpointChangedError extends Error {
  constructor() { super('Sync checkpoint changed while fetching this page'); }
}

@Injectable()
export class InitialSyncService {
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly imap: ImapMailService,
    private readonly normalizer: EmailNormalizer,
    private readonly senderRules: SenderRulesService,
    private readonly projectAnalysis: ProjectEmailAnalysisService,
    @InjectPinoLogger(InitialSyncService.name)
    private readonly logger: PinoLogger,
    private readonly systemMailSenders: SystemMailSendersService,
  ) {}

  async start(): Promise<{ status: string }> {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) {
      throw new ServiceUnavailableException({
        code: 'IMAP_NOT_CONFIGURED',
        message: 'IMAP is not configured',
      });
    }
    if (this.running) return { status: 'running' };
    this.running = true;

    try {
      const folders = this.folders();
      const now = new Date();
      const fromDate = this.historyCutoff(now, this.config.get<number>('IMAP_SYNC_HISTORY_MONTHS', 12));
      const accountId = await this.accountId(email);
      const existing = await this.prisma.syncCheckpoint.findMany({
        where: { mailAccountId: accountId, mailbox: { in: folders } },
        select: { mailbox: true, status: true },
      });
      const existingByFolder = new Map(existing.map((row) => [row.mailbox, row.status]));
      for (const mailbox of folders) {
        await this.prisma.syncCheckpoint.upsert({
          where: { mailAccountId_mailbox: { mailAccountId: accountId, mailbox } },
          create: {
            mailAccountId: accountId,
            mailbox,
            fromDate,
            throughDate: now,
            status: 'pending',
          },
          update: {},
        });
      }
      if (folders.every((folder) => existingByFolder.get(folder) === 'completed')) {
        this.running = false;
        return { status: 'completed' };
      }
      void this.run(folders, email)
        .catch(() => {
          this.logger.error({ event: 'imap.initial_sync.failed' }, 'Initial mail import failed');
        })
        .finally(() => {
          this.running = false;
        });
      return { status: 'started' };
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) {
      return { configured: false, status: 'not_configured', folders: [] };
    }
    const checkpoints = await this.prisma.syncCheckpoint.findMany({
      where: { mailAccount: { email } },
      orderBy: { mailbox: 'asc' },
      select: {
        mailbox: true,
        uidValidity: true,
        fromDate: true,
        throughDate: true,
        lastUid: true,
        status: true,
        scannedCount: true,
        importedCount: true,
        lastErrorCode: true,
        lastPolledAt: true,
        lastSuccessfulSyncAt: true,
        reconciliationRequired: true,
        completedAt: true,
        updatedAt: true,
      },
    });
    return {
      configured: true,
      folders: checkpoints.map((checkpoint) => ({
        ...checkpoint,
        uidValidity: checkpoint.uidValidity?.toString() ?? null,
      })),
    };
  }

  async listImported(mailbox?: string, limit = 20, offset = 0) {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) {
      throw new ServiceUnavailableException({
        code: 'IMAP_NOT_CONFIGURED',
        message: 'IMAP is not configured',
      });
    }
    const accountId = await this.accountId(email);
    const where = { mailAccountId: accountId, ...(mailbox ? { mailbox } : {}) };
    const [total, messages] = await this.prisma.$transaction([
      this.prisma.emailMessage.count({ where }),
      this.prisma.emailMessage.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
        select: {
          id: true,
          mailbox: true,
          uidValidity: true,
          uid: true,
          providerMessageId: true,
          rfcMessageId: true,
          threadId: true,
          direction: true,
          fromJson: true,
          toJson: true,
          ccJson: true,
          bccJson: true,
          subject: true,
          bodyText: true,
          bodyHtml: true,
          headersJson: true,
          classification: true,
          classificationReason: true,
          classificationEvidence: true,
          reviewRequired: true,
          classifiedAt: true,
          campaignId: true,
          campaignRole: true,
          promotionStatus: true,
          campaign: { select: { campaignKey: true, name: true } },
          contactId: true,
          companyId: true,
          contactResolutionStatus: true,
          contactResolutionConfidence: true,
          contactResolutionReason: true,
          companyResolutionReason: true,
          contact: { select: { id: true, displayName: true, status: true, confidence: true } },
          company: { select: { id: true, name: true, domain: true } },
          projectId: true,
          topicId: true,
          projectResolutionStatus: true,
          projectConfidence: true,
          projectReason: true,
          projectManualOverride: true,
          topicResolutionStatus: true,
          topicConfidence: true,
          topicReason: true,
          topicManualOverride: true,
          project: { select: { id: true, name: true, stage: true, status: true } },
          topic: { select: { id: true, name: true, type: true } },
          sentAt: true,
          receivedAt: true,
        },
      }),
    ]);
    return {
      total,
      offset,
      limit,
      messages: messages.map((message) => ({
        ...message,
        uidValidity: message.uidValidity.toString(),
      })),
    };
  }

  private async run(folders: string[], email: string): Promise<void> {
    const accountId = await this.accountId(email);
    for (const mailbox of folders) {
      const checkpoint = await this.prisma.syncCheckpoint.findUniqueOrThrow({
        where: { mailAccountId_mailbox: { mailAccountId: accountId, mailbox } },
      });
      try {
        await this.resumeFolder(accountId, email, checkpoint.id, mailbox);
      } catch {
        // The checkpoint remains recoverable by the periodic worker. Other
        // folders must still run when this folder cannot be fetched.
      }
    }
  }

  async resumeFolder(accountId: string, email: string, checkpointId: string, mailbox: string, maxPages = Number.MAX_SAFE_INTEGER): Promise<void> {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const checkpoint = await this.prisma.syncCheckpoint.findUniqueOrThrow({ where: { id: checkpointId } });
      if (checkpoint.status === 'completed') return;
      const now = new Date();
      // Claim a single page, not the whole historical import. The version also
      // fences a slow old owner after a stale page is recovered by another process.
      const ownedVersion = new Date(Math.max(now.getTime(), checkpoint.updatedAt.getTime() + 1));
      const claimed = await this.prisma.syncCheckpoint.updateMany({
        where: {
          id: checkpointId, mailAccountId: accountId, mailbox, updatedAt: checkpoint.updatedAt,
          OR: [
            { status: { in: ['pending', 'failed', 'interrupted'] } },
            { status: 'in_progress', updatedAt: { lte: new Date(now.getTime() - INITIAL_PAGE_STALE_MS) } },
          ],
        },
        data: { status: 'in_progress', updatedAt: ownedVersion, lastPolledAt: now, lastErrorCode: null },
      });
      if (!claimed.count) return;
      try {
        const page = await this.imap.fetchPage(
          mailbox, checkpoint.fromDate, checkpoint.throughDate, checkpoint.lastUid,
          this.config.get<number>('IMAP_SYNC_PAGE_SIZE', 25), checkpoint.targetUid,
        );
        if (page.uidValidity === null || page.uidValidity === undefined) throw new Error('IMAP did not return UIDVALIDITY');
        if (uidValidityChanged(checkpoint.uidValidity, page.uidValidity)) {
          const reset = await this.prisma.syncCheckpoint.updateMany({
            where: { id: checkpointId, status: 'in_progress', updatedAt: ownedVersion },
            data: { uidValidity: page.uidValidity, targetUid: page.targetUid, throughDate: page.throughDate, lastUid: 0, status: 'pending', updatedAt: new Date(Math.max(Date.now(), ownedVersion.getTime() + 1)) },
          });
          if (!reset.count) return;
          continue;
        }
        const newCount = await this.persistPage({
          accountId, accountEmail: email, checkpointId, mailbox,
          expectedCheckpointUpdatedAt: ownedVersion,
          uidValidity: page.uidValidity,
          messages: page.messages.map((message) => ({ uid: message.uid, receivedAt: message.receivedAt, rawSource: Buffer.from(message.rawSourceBase64, 'base64') })),
          nextUid: nextCheckpointUid(page.hasMore, page.nextUid, page.targetUid),
          hasMore: page.hasMore, targetUid: page.targetUid, throughDate: page.throughDate,
          clearTargetUid: !page.hasMore,
          releaseInitialPage: true,
          // Deliberately omit realtime/recovery triage flags: resuming an initial
          // import has the same silent historical semantics as its first attempt.
        });
        if (!page.hasMore) return;
        this.logger.info({ event: 'imap.initial_sync.page_saved', mailbox, count: page.messages.length, created: newCount }, 'Initial mail import page saved');
      } catch (error) {
        if (error instanceof SyncCheckpointChangedError) return;
        await this.prisma.syncCheckpoint.updateMany({
          where: { id: checkpointId, status: 'in_progress', updatedAt: ownedVersion },
          data: { status: 'failed', lastErrorCode: 'INITIAL_SYNC_FAILED', updatedAt: new Date(Math.max(Date.now(), ownedVersion.getTime() + 1)) },
        }).catch(() => undefined);
        this.logger.warn({ event: 'imap.initial_sync.folder_failed', mailbox }, 'Initial mail import folder failed; checkpoint retained for automatic retry');
        throw error;
      }
    }
  }

  async persistPage(input: {
    accountId: string;
    accountEmail: string;
    checkpointId?: string;
    mailbox: string;
    uidValidity: bigint;
    messages: Array<{ uid: number; receivedAt: Date | null; rawSource: Buffer }>;
    nextUid: number;
    hasMore: boolean;
    targetUid?: number | null;
    throughDate?: Date;
    incremental?: boolean;
    emitAgentEvents?: boolean;
    auditOnly?: boolean;
    importanceTriageSource?: 'reconciliation' | 'uidvalidity_recovery';
    importanceTriageCatchupCutoff?: Date;
    clearTargetUid?: boolean;
    expectedCheckpointUpdatedAt?: Date;
    releaseInitialPage?: boolean;
  }): Promise<number> {
    const normalized: NormalizedEmail[] = [];
    for (const message of input.messages) {
      normalized.push(await this.normalizer.normalize({
        mailbox: input.mailbox,
        uidValidity: input.uidValidity,
        uid: message.uid,
        rawSource: message.rawSource,
        receivedAt: message.receivedAt,
        accountEmail: input.accountEmail,
      }));
    }
    return this.prisma.$transaction(async (transaction) => {
      // Share the folder lock with deletion reconciliation so a fetched page cannot
      // be persisted after its missing UIDs have been tombstoned and removed.
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`mail-sync:${input.accountId}:${input.mailbox}`}, 0))::text AS "locked"
      `);
      if (input.expectedCheckpointUpdatedAt) {
        if (!input.checkpointId) throw new Error('Expected checkpoint version requires a checkpoint');
        const current = await transaction.syncCheckpoint.updateMany({
          where: { id: input.checkpointId, updatedAt: input.expectedCheckpointUpdatedAt },
          data: { updatedAt: new Date(Math.max(Date.now(), input.expectedCheckpointUpdatedAt.getTime() + 1)) },
        });
        if (!current.count) throw new SyncCheckpointChangedError();
      }
      const systemAddressMatches = await this.systemMailSenders.matchSystemSenderAddresses(
        [...new Set(normalized.filter((message) => message.direction === 'inbound').flatMap((message) => fromMailboxAddresses(message.fromJson)))],
        transaction,
      );
      const systemAddressSet = new Set(systemAddressMatches.map(normalizeSystemSenderAddress));
      let created = 0;
      for (let index = 0; index < normalized.length; index += 1) {
        const item = normalized[index];
        const uid = input.messages[index].uid;
        const deletionTombstone = await transaction.mailDeletionTombstone.findUnique({
          where: {
            mailAccountId_mailbox_uidValidity_uid: {
              mailAccountId: input.accountId,
              mailbox: input.mailbox,
              uidValidity: input.uidValidity,
              uid,
            },
          },
          select: { messageId: true },
        });
        if (deletionTombstone) continue;
        const detectedClassification = item.direction === 'inbound'
          ? classifyMail({ rawSource: item.rawSource, bodyText: item.bodyText, direction: item.direction, subject: item.subject, fromJson: item.fromJson, toJson: item.toJson })
          : null;
        const systemSender = item.direction === 'inbound' && fromMailboxAddresses(item.fromJson).some((address) => systemAddressSet.has(normalizeSystemSenderAddress(address)));
        const initialClassification = systemSender && detectedClassification && ['BUSINESS_HUMAN', 'UNKNOWN'].includes(detectedClassification.classification)
          ? { classification: 'SYSTEM_NOTIFICATION' as const, reason: 'Configured system sender; AI analysis and notifications are disabled.', evidence: [...detectedClassification.evidence, 'Exact From address matches configured system sender'], reviewRequired: false }
          : detectedClassification;
        const existingByIdentity = await transaction.emailMessage.findUnique({
          where: { mailAccountId_providerMessageId: { mailAccountId: input.accountId, providerMessageId: item.providerMessageId } },
          select: { id: true, classificationManualOverride: true, senderRuleSnapshot: true },
        });
        const existingByRfcId = existingByIdentity ?? (item.rfcMessageId
          ? await transaction.emailMessage.findFirst({
              where: { mailAccountId: input.accountId, mailbox: input.mailbox, rfcMessageId: item.rfcMessageId },
              select: { id: true, classificationManualOverride: true, senderRuleSnapshot: true },
            })
          : null);
        const data = {
          mailbox: input.mailbox,
          uidValidity: input.uidValidity,
          uid,
          providerMessageId: item.providerMessageId,
          rfcMessageId: item.rfcMessageId,
          threadId: item.threadId,
          direction: item.direction,
          fromJson: item.fromJson,
          toJson: item.toJson,
          ccJson: item.ccJson,
          bccJson: item.bccJson,
          subject: item.subject,
          bodyText: item.bodyText,
          bodyHtml: item.bodyHtml,
          headersJson: item.headersJson,
          rawSource: item.rawSource,
          sentAt: item.sentAt,
          receivedAt: item.receivedAt,
        };
        let sourceMessageId: string;
        let newlyCreated = false;
        let savedSenderRuleSnapshot: SenderRuleSnapshot | null = null;
        const recoveryCandidate = Boolean(input.importanceTriageSource && input.importanceTriageCatchupCutoff &&
          (!item.receivedAt || item.receivedAt >= input.importanceTriageCatchupCutoff));
        const senderRuleSource = input.emitAgentEvents ? 'realtime' : recoveryCandidate ? input.importanceTriageSource! : null;
        if (existingByRfcId) {
          const wasBlacklisted = senderRuleSnapshotAction(existingByRfcId.senderRuleSnapshot) === 'blacklist';
          await transaction.emailMessage.update({ where: { id: existingByRfcId.id }, data: {
            ...data,
            ...(!wasBlacklisted && !existingByRfcId.classificationManualOverride && initialClassification ? {
              classification: initialClassification.classification,
              classificationReason: initialClassification.reason,
              classificationEvidence: initialClassification.evidence,
              automationDetails: extractAutomationDetails(item, initialClassification.classification) as Prisma.InputJsonValue,
              reviewRequired: initialClassification.reviewRequired,
              classifiedAt: new Date(),
            } : {}),
          } });
          sourceMessageId = existingByRfcId.id;
        } else {
          newlyCreated = true;
          if (senderRuleSource && item.direction === 'inbound') {
            savedSenderRuleSnapshot = await this.senderRules.snapshotForNewMessage(transaction, input.accountId, item.fromJson);
          }
          const blacklisted = savedSenderRuleSnapshot?.action === 'blacklist';
          const classification = blacklisted ? 'BLACKLISTED' : initialClassification?.classification;
          const classificationReason = blacklisted
            ? `Sender matched blacklist rule ${savedSenderRuleSnapshot?.matchedRule?.matchType}:${savedSenderRuleSnapshot?.matchedRule?.pattern}`
            : initialClassification?.reason;
          const classificationEvidence = blacklisted
            ? [...(initialClassification?.evidence ?? []), 'Sender matched an active blacklist rule']
            : initialClassification?.evidence;
          const createdMessage = await transaction.emailMessage.create({ data: { ...data, mailAccountId: input.accountId,
            historicalImport: !input.emitAgentEvents && !input.importanceTriageSource,
            ...(classification ? {
              classification,
              classificationReason,
              classificationEvidence,
              automationDetails: blacklisted ? {} : extractAutomationDetails(item, initialClassification!.classification) as Prisma.InputJsonValue,
              reviewRequired: blacklisted ? false : initialClassification?.reviewRequired ?? true,
              classifiedAt: new Date(),
            } : {}),
            ...(savedSenderRuleSnapshot ? { senderRuleSnapshot: savedSenderRuleSnapshot as unknown as Prisma.InputJsonValue } : {}),
          } });
          sourceMessageId = createdMessage.id;
          created += 1;
        }
        // Recovery scans also revisit already imported messages. Decide from the persisted
        // classification (which may be a manual override), and only fill a missing row.
        const currentMessage = await transaction.emailMessage.findUniqueOrThrow({
          where: { id: sourceMessageId },
          select: { id: true, direction: true, classification: true, classificationManualOverride: true, historicalImport: true, receivedAt: true, senderRuleSnapshot: true },
        });
        const senderRuleAction = senderRuleSnapshotAction(currentMessage.senderRuleSnapshot);
        const triageCandidate = !systemSender && !currentMessage.historicalImport && currentMessage.direction === 'inbound' &&
          ['BUSINESS_HUMAN', 'UNKNOWN'].includes(currentMessage.classification) &&
          senderRuleAction !== 'blacklist' && senderRuleAction !== 'whitelist';
        const realtimeTriage = Boolean(input.emitAgentEvents && triageCandidate);
        const recentRecoveryTriage = Boolean(
          input.importanceTriageSource && input.importanceTriageCatchupCutoff && triageCandidate &&
          (!currentMessage.receivedAt || currentMessage.receivedAt >= input.importanceTriageCatchupCutoff),
        );
        if (realtimeTriage || recentRecoveryTriage) {
          const source = recentRecoveryTriage ? input.importanceTriageSource! : 'realtime';
          const unknownReceivedDate = !currentMessage.receivedAt;
          await transaction.emailImportanceTriage.upsert({
            where: { sourceMessageId },
            create: {
              mailAccountId: input.accountId,
              sourceMessageId,
              source,
              ...(unknownReceivedDate ? {
                status: 'review', importance: 'uncertain', reason: 'Received date is missing; importance was not inferred.',
                lastErrorCode: 'TRIAGE_RECEIVED_DATE_UNKNOWN', analyzedAt: new Date(),
              } : {}),
            },
            update: {},
          });
        }
        if (!systemSender && newlyCreated && senderRuleAction === 'whitelist' && senderRuleSource && currentMessage.classification === 'BUSINESS_HUMAN' && savedSenderRuleSnapshot?.matchedRule) {
          const eventMessageId = await this.projectAnalysis.canonicalMailId(transaction, sourceMessageId);
          const eventKey = `mail-importance:${eventMessageId}`;
          const event = await transaction.agentEvent.upsert({
            where: { eventKey },
            create: {
              eventKey,
              eventType: 'INBOUND_EMAIL_RECEIVED',
              entityType: 'email_message',
              entityId: eventMessageId,
              priority: 8,
              notificationPolicy: 'REALTIME',
              payloadJson: {
                eventType: 'INBOUND_EMAIL_RECEIVED', entityType: 'email_message', entityId: eventMessageId,
                sourceMessageId: eventMessageId, subject: item.subject?.slice(0, 200) ?? null,
                from: Array.isArray(item.fromJson) ? item.fromJson.slice(0, 3) : [],
                receivedAt: item.receivedAt?.toISOString() ?? null,
                classification: currentMessage.classification,
                classificationReason: initialClassification?.reason ?? null,
                reviewRequired: false,
                triageSource: senderRuleSource,
                recoveredDuringReconciliation: senderRuleSource === 'reconciliation',
                recoveredDuringUidValidityReset: senderRuleSource === 'uidvalidity_recovery',
                importance: 'high', importanceConfidence: 1,
                importanceReason: 'A whitelisted human sender bypasses importance scoring; notification is required.',
                importanceEvidence: ['Deterministic classification: BUSINESS_HUMAN', 'Explicit sender whitelist rule'],
                notificationRequired: true,
                senderRule: savedSenderRuleSnapshot.matchedRule,
                contentIsUntrusted: true,
              } as Prisma.InputJsonValue,
            },
            update: {},
            select: { id: true },
          });
          await transaction.agentWakeupDelivery.upsert({
            where: { eventId: event.id },
            create: { id: randomUUID(), eventId: event.id },
            update: {},
          });
        }
        if (!systemSender && newlyCreated && input.emitAgentEvents && currentMessage.direction === 'inbound' && !currentMessage.historicalImport && currentMessage.classification === 'BUSINESS_HUMAN') {
          await this.projectAnalysis.enqueueIncoming(transaction, currentMessage.id);
        }
        const processingClassification = currentMessage.classification;
        const blacklisted = senderRuleAction === 'blacklist';
        await transaction.processingRecord.upsert({
          where: { sourceMessageId },
          create: { mailAccountId: input.accountId, sourceMessageId, provider: 'imap', providerMessageId: item.providerMessageId,
            ...(initialClassification || blacklisted ? {
              classification: processingClassification,
              ...(blacklisted ? { status: 'ignored', processedAt: new Date(), analysisVersion: 'sender-rules.v1' } : { analysisVersion: 'business-gate.v1' }),
            } : {}),
          },
          update: { providerMessageId: item.providerMessageId },
        });
      }
      const now = new Date();
      if (!input.auditOnly) {
        if (!input.checkpointId) throw new Error('Sync checkpoint is required outside audit-only persistence');
        await transaction.syncCheckpoint.update({
          where: { id: input.checkpointId },
          data: {
          ...(input.expectedCheckpointUpdatedAt ? { updatedAt: new Date(Math.max(now.getTime(), input.expectedCheckpointUpdatedAt.getTime() + 1)) } : {}),
          uidValidity: input.uidValidity,
          lastUid: input.nextUid,
          ...(input.clearTargetUid ? { targetUid: null } : input.targetUid !== undefined ? { targetUid: input.targetUid } : {}),
          ...(input.throughDate ? { throughDate: input.throughDate } : {}),
          scannedCount: { increment: input.messages.length },
          importedCount: { increment: created },
          status: input.incremental ? 'completed' : input.hasMore ? input.releaseInitialPage ? 'pending' : 'in_progress' : 'completed',
          completedAt: input.incremental ? undefined : input.hasMore ? null : now,
          lastPolledAt: now,
          lastSuccessfulSyncAt: input.incremental || !input.hasMore ? now : undefined,
          lastErrorCode: null,
          reconciliationRequired: input.incremental && !input.hasMore ? false : undefined,
          },
        });
      }
      return created;
    });
  }

  private folders(): string[] {
    const value = this.config.get<string>('IMAP_SYNC_FOLDERS', 'INBOX');
    return [...new Set(value.split(',').map((folder) => folder.trim()).filter(Boolean))];
  }

  private historyCutoff(now: Date, months: number): Date {
    const targetMonth = now.getUTCMonth() - months;
    const firstOfTargetMonth = new Date(Date.UTC(
      now.getUTCFullYear(),
      targetMonth,
      1,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ));
    const daysInTargetMonth = new Date(Date.UTC(
      firstOfTargetMonth.getUTCFullYear(),
      firstOfTargetMonth.getUTCMonth() + 1,
      0,
    )).getUTCDate();
    firstOfTargetMonth.setUTCDate(Math.min(now.getUTCDate(), daysInTargetMonth));
    return firstOfTargetMonth;
  }

  private async accountId(email: string): Promise<string> {
    const account = await this.prisma.mailAccount.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!account) {
      throw new ServiceUnavailableException({
        code: 'IMAP_ACCOUNT_NOT_READY',
        message: 'IMAP account configuration is not ready',
      });
    }
    return account.id;
  }
}
