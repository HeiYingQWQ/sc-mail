import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  classifyMail,
  extractAutomationDetails,
  getCampaignIdHeader,
  MAILINBLACK_VERIFICATION_REASON,
  GATE_CLASSES,
  GATE_CLASS_LABELS,
  threadReferencesCampaign,
  shouldApplyAutomatedClassification,
  senderRuleSnapshotAction,
  fromMailboxAddresses,
  normalizeSystemSenderAddress,
  type GateInput,
} from './business-gate.rules';
import { SystemMailSendersService } from './system-mail-senders.service';

@Injectable()
export class BusinessGateService {
  private running = false;

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService, private readonly systemMailSenders: SystemMailSendersService) {}

  async classifyImported() {
    if (this.running) return { status: 'running', processed: 0, linkedReplies: 0 };
    this.running = true;
    try {
      return await this.classifyAll();
    } finally {
      this.running = false;
    }
  }

  private async classifyAll() {
    const account = await this.account();
    let processed = 0;
    let linkedReplies = 0;
    const verificationMessageIds: string[] = [];
    const visit = async (handler: (message: {
      id: string; rawSource: Uint8Array; direction: string; subject: string | null;
      bodyText: string | null; fromJson: unknown; toJson: unknown; campaignId: string | null;
      campaignRole: string | null; promotionStatus: string; classificationManualOverride: boolean;
      classification: string; senderRuleSnapshot: unknown; systemSender: boolean;
    }) => Promise<void>, countProcessed = false) => {
      let cursor: string | undefined;
      while (true) {
        const page = await this.prisma.emailMessage.findMany({
          where: { mailAccountId: account.id },
          orderBy: { id: 'asc' }, take: 50,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: {
            id: true, rawSource: true, direction: true, subject: true, bodyText: true, fromJson: true, toJson: true,
            campaignId: true, campaignRole: true, promotionStatus: true, classificationManualOverride: true,
            classification: true, senderRuleSnapshot: true,
          },
        });
        if (!page.length) break;
        const systemMatches = await this.systemMailSenders.matchSystemSenderAddresses(
          [...new Set(page.filter((message) => message.direction === 'inbound').flatMap((message) => fromMailboxAddresses(message.fromJson)))],
        );
        const systemAddressSet = new Set(systemMatches.map(normalizeSystemSenderAddress));
        for (const message of page) {
          const systemSender = message.direction === 'inbound' && fromMailboxAddresses(message.fromJson).some((address) => systemAddressSet.has(normalizeSystemSenderAddress(address)));
          await handler({ ...message, systemSender });
        }
        if (countProcessed) processed += page.length;
        cursor = page.at(-1)?.id;
        if (page.length < 50) break;
      }
    };

    // Complete campaign discovery across the entire mailbox before resolving any replies.
    await visit(async (message) => {
      if (message.classification === 'BLACKLISTED' || senderRuleSnapshotAction(message.senderRuleSnapshot) === 'blacklist') return;
      if (!shouldApplyAutomatedClassification(message.classificationManualOverride)) return;
      const input = this.input(message);
      const externalKey = getCampaignIdHeader(input);
      const detected = classifyMail(input);
      const systemSender = message.systemSender;
      const initial = systemSender && ['BUSINESS_HUMAN', 'UNKNOWN'].includes(detected.classification)
        ? { classification: 'SYSTEM_NOTIFICATION' as const, reason: 'Configured system sender; automatic AI analysis and notifications are disabled.', evidence: [...detected.evidence, 'Exact From address matches configured system sender'], reviewRequired: false }
        : detected;
      if (initial.reason === MAILINBLACK_VERIFICATION_REASON) verificationMessageIds.push(message.id);
      let campaignId = message.campaignId;
      let campaignRole = message.campaignRole;
      let promotionStatus = message.promotionStatus;
      if (initial.classification === 'OUTREACH_OUTBOUND' && externalKey && input.direction === 'outbound') {
        const campaign = await this.prisma.outreachCampaign.upsert({
          where: { campaignKey: externalKey },
          create: { campaignKey: externalKey, name: externalKey },
          update: {}, select: { id: true },
        });
        campaignId = campaign.id;
        campaignRole = 'outbound';
        promotionStatus = 'none';
      }
      await this.prisma.emailMessage.updateMany({
        where: { id: message.id, classificationManualOverride: false },
        data: {
          classification: initial.classification,
          classificationReason: initial.reason,
          classificationEvidence: initial.evidence,
          automationDetails: extractAutomationDetails(input, initial.classification) as Prisma.InputJsonValue,
          reviewRequired: initial.reviewRequired,
          classifiedAt: new Date(), campaignId, campaignRole, promotionStatus,
        },
      });
    }, true);

    const campaignRows = await this.prisma.emailMessage.findMany({
      where: { mailAccountId: account.id, campaignRole: 'outbound', campaignId: { not: null } },
      select: { campaignId: true, rfcMessageId: true, threadId: true },
    });
    const distinctCampaigns = new Map<string, string[]>();
    for (const candidate of campaignRows) {
      if (!candidate.campaignId) continue;
      const ids = distinctCampaigns.get(candidate.campaignId) ?? [];
      for (const id of [candidate.rfcMessageId, candidate.threadId]) if (id && !ids.includes(id)) ids.push(id);
      distinctCampaigns.set(candidate.campaignId, ids);
    }

    await visit(async (message) => {
      if (message.classification === 'BLACKLISTED' || senderRuleSnapshotAction(message.senderRuleSnapshot) === 'blacklist') return;
      if (!shouldApplyAutomatedClassification(message.classificationManualOverride)) return;
      if (message.systemSender) return;
      const input = this.input(message);
      if (input.direction === 'outbound' || message.campaignRole === 'outbound') return;
      const matched = [...distinctCampaigns.entries()].filter(([, ids]) => threadReferencesCampaign(input, ids));
      if (matched.length === 1) {
        const classification = classifyMail(input);
        const human = classification.classification === 'BUSINESS_HUMAN';
        await this.prisma.emailMessage.updateMany({
          where: { id: message.id, classificationManualOverride: false },
          data: {
            classification: classification.classification,
            classificationReason: human ? 'Human reply linked to outreach campaign' : classification.reason,
            classificationEvidence: human
              ? ['References/In-Reply-To matches campaign message']
              : [...classification.evidence, 'Linked to an outreach campaign by reply headers'],
            automationDetails: extractAutomationDetails(input, classification.classification) as Prisma.InputJsonValue,
            reviewRequired: classification.reviewRequired,
            classifiedAt: new Date(),
            campaignId: matched[0][0], campaignRole: 'reply',
            promotionStatus: human ? 'eligible' : 'none',
          },
        });
        if (human) linkedReplies += 1;
      } else if (matched.length > 1 && classifyMail(input).classification === 'BUSINESS_HUMAN') {
        await this.prisma.emailMessage.updateMany({
          where: { id: message.id, classificationManualOverride: false },
          data: {
            classification: 'UNKNOWN', classificationReason: 'Reply references multiple outreach campaigns',
            classificationEvidence: ['References/In-Reply-To matched multiple campaigns'],
            reviewRequired: true, classifiedAt: new Date(), promotionStatus: 'none',
          },
        });
      }
    });
    const verificationCleanup = await this.cleanVerificationRecords(verificationMessageIds);
    return { processed, linkedReplies, verificationMessages: verificationCleanup.messages, provisionalContactsRemoved: verificationCleanup.contacts };
  }

  private async cleanVerificationRecords(messageIds: string[]) {
    if (!messageIds.length) return { messages: 0, contacts: 0 };
    return this.prisma.$transaction(async (tx) => {
      const messages = await tx.emailMessage.findMany({
        where: {
          id: { in: messageIds }, classification: 'SYSTEM_NOTIFICATION',
          classificationReason: MAILINBLACK_VERIFICATION_REASON, classificationManualOverride: false,
        },
        select: {
          id: true, contactId: true, contactResolutionStatus: true, projectManualOverride: true,
          topicManualOverride: true,
          contact: { select: { id: true, status: true, emails: { select: { email: true } } } },
        },
      });
      const removableContactIds = new Set<string>();
      const now = new Date();

      for (const message of messages) {
        const data: Prisma.EmailMessageUncheckedUpdateInput = {};
        const provisionalContact = message.contact?.status === 'provisional';
        if (provisionalContact && message.contactId === message.contact?.id) {
          data.contactId = null;
          data.contactResolutionStatus = 'ignored';
          data.contactResolutionConfidence = 0;
          data.contactResolutionReason = 'Mailinblack verification notices are not CRM contacts';
          if (!message.projectManualOverride) data.companyId = null;
          removableContactIds.add(message.contact.id);
        } else if (!message.contactId && ['unresolved', 'ambiguous', 'provisional'].includes(message.contactResolutionStatus)) {
          data.contactResolutionStatus = 'ignored';
          data.contactResolutionReason = 'Mailinblack verification notices are not CRM contacts';
        }
        if (!message.projectManualOverride) {
          data.projectId = null;
          data.projectResolutionStatus = 'ignored';
          data.projectReason = 'Mailinblack verification notices do not carry project context';
        }
        if (!message.topicManualOverride) {
          data.topicId = null;
          data.topicResolutionStatus = 'ignored';
          data.topicReason = 'Mailinblack verification notices do not carry topic context';
        }
        if (Object.keys(data).length) await tx.emailMessage.update({ where: { id: message.id }, data });
      }

      await tx.reviewItem.updateMany({
        where: { sourceMessageId: { in: messages.map((message) => message.id) }, entityType: 'email_message', status: 'pending',
          OR: [{ reasonCode: 'CLASSIFICATION_UNCERTAIN' }, { reasonCode: 'TOPIC_UNRESOLVED' }, { reasonCode: { startsWith: 'PROJECT_' } }] },
        data: {
          status: 'resolved', resolvedBy: 'business-gate', resolvedAt: now,
          resolutionJson: { action: 'auto_resolved', explanation: 'Sender domain is the configured Mailinblack human-verification service' },
        },
      });

      let contactsRemoved = 0;
      for (const contactId of removableContactIds) {
        const contact = await tx.contact.findUnique({
          where: { id: contactId },
          select: {
            id: true, status: true, mergedIntoId: true,
            emails: { select: { id: true, email: true } },
            messages: { take: 1, select: { id: true } },
            decisions: { take: 1, select: { id: true } },
            mergedContacts: { take: 1, select: { id: true } },
          },
        });
        if (!contact || contact.status !== 'provisional' || contact.mergedIntoId || !contact.emails.length ||
          contact.emails.some((item) => item.email.split('@').at(-1)?.toLowerCase() !== 'invitations.mailinblack.com') ||
          contact.messages.length || contact.decisions.length || contact.mergedContacts.length) continue;

        await tx.reviewItem.updateMany({
          where: { entityType: 'contact', entityId: contact.id, reasonCode: 'CONTACT_PROVISIONAL', status: 'pending' },
          data: {
            status: 'resolved', resolvedBy: 'business-gate', resolvedAt: now,
            resolutionJson: { action: 'auto_resolved', explanation: 'Provisional contact came only from the Mailinblack verification service' },
          },
        });
        await tx.contactEmail.deleteMany({ where: { contactId: contact.id } });
        await tx.contact.delete({ where: { id: contact.id } });
        contactsRemoved += 1;
      }

      for (const message of messages) {
        const pending = await tx.reviewItem.findFirst({ where: { sourceMessageId: message.id, status: 'pending' }, select: { id: true } });
        await tx.processingRecord.updateMany({
          where: { sourceMessageId: message.id },
          data: { classification: 'SYSTEM_NOTIFICATION', status: pending ? 'needs_review' : 'ignored', processedAt: now,
            reviewId: pending?.id ?? null, lastError: null, analysisVersion: 'business-gate.v1' },
        });
      }
      return { messages: messages.length, contacts: contactsRemoved };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 });
  }

  async status() {
    const account = await this.account();
    const [grouped, reviewRequired, eligiblePromotions, campaignCount, total] = await Promise.all([
      this.prisma.emailMessage.groupBy({
        by: ['classification'], where: { mailAccountId: account.id }, _count: { _all: true },
      }),
      this.prisma.emailMessage.count({ where: { mailAccountId: account.id, reviewRequired: true } }),
      this.prisma.emailMessage.count({ where: { mailAccountId: account.id, promotionStatus: 'eligible' } }),
      this.prisma.outreachCampaign.count({ where: { messages: { some: { mailAccountId: account.id } } } }),
      this.prisma.emailMessage.count({ where: { mailAccountId: account.id } }),
    ]);
    return {
      total,
      reviewRequired,
      eligiblePromotions,
      campaigns: campaignCount,
      classifications: Object.fromEntries(grouped.map((row) => [row.classification, row._count._all])),
    };
  }

  async assertAiAnalysisAllowed(messageId: unknown) {
    if (typeof messageId !== 'string' || !messageId.trim()) throw new BadRequestException('messageId is required');
    const message = await this.prisma.emailMessage.findUnique({
      where: { id: messageId.trim() },
      select: { classification: true, senderRuleSnapshot: true },
    });
    if (message && (message.classification === 'BLACKLISTED' || senderRuleSnapshotAction(message.senderRuleSnapshot) === 'blacklist')) {
      throw new ConflictException({ code: 'SENDER_BLACKLISTED', message: 'AI analysis is disabled for a blacklisted sender' });
    }
  }

  async classificationSummary(dateInput?: unknown) {
    const account = await this.account();
    const range = this.classificationDateRange(dateInput);
    const where = { mailAccountId: account.id, direction: 'inbound', ...(range ? { receivedAt: { gte: range.from, lt: range.until } } : {}) };
    const [total, classified, reviewRequired, groups, mailboxes] = await Promise.all([
      this.prisma.emailMessage.count({ where }),
      this.prisma.emailMessage.count({ where: { ...where, classifiedAt: { not: null } } }),
      this.prisma.emailMessage.count({ where: { ...where, reviewRequired: true } }),
      this.prisma.emailMessage.groupBy({ by: ['classification'], where, _count: { _all: true } }),
      this.prisma.syncCheckpoint.findMany({ where: { mailAccountId: account.id }, orderBy: { mailbox: 'asc' }, select: { mailbox: true, status: true, lastSuccessfulSyncAt: true, lastPolledAt: true } }),
    ]);
    const counts = Object.fromEntries(GATE_CLASSES.map((classification) => [classification, 0])) as Record<string, number>;
    for (const group of groups) counts[group.classification] = group._count._all;
    return {
      date: range?.date ?? null,
      timezone: this.config.get<string>('BUSINESS_TIMEZONE', 'Europe/Rome'),
      rangeUtc: range ? { from: range.from.toISOString(), until: range.until.toISOString() } : null,
      total, classified, unclassified: total - classified, reviewRequired,
      categories: GATE_CLASSES.map((classification) => ({ classification, label: GATE_CLASS_LABELS[classification], count: counts[classification] })),
      mailboxes,
      generatedAt: new Date().toISOString(),
    };
  }

  async listClassifiedMessages(classificationInput: unknown, dateInput: unknown, limit: number, offset: number) {
    if (typeof classificationInput !== 'string' || !GATE_CLASSES.includes(classificationInput as (typeof GATE_CLASSES)[number])) {
      throw new BadRequestException('classification must be a supported mail classification');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      throw new BadRequestException('Invalid pagination limits');
    }
    const account = await this.account();
    const range = this.classificationDateRange(dateInput);
    const where = { mailAccountId: account.id, direction: 'inbound', classification: classificationInput,
      ...(range ? { receivedAt: { gte: range.from, lt: range.until } } : {}) };
    const [total, messages] = await this.prisma.$transaction([
      this.prisma.emailMessage.count({ where }),
      this.prisma.emailMessage.findMany({ where, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset,
        select: { id: true, mailbox: true, direction: true, subject: true, fromJson: true, receivedAt: true,
          classification: true, classificationReason: true, classificationEvidence: true, automationDetails: true, reviewRequired: true, classifiedAt: true,
          contact: { select: { displayName: true } }, project: { select: { name: true } } },
      }),
    ]);
    return { classification: classificationInput, label: GATE_CLASS_LABELS[classificationInput as (typeof GATE_CLASSES)[number]], date: range?.date ?? null, timezone: this.config.get<string>('BUSINESS_TIMEZONE', 'Europe/Rome'), total, limit, offset, messages };
  }

  private classificationDateRange(value: unknown): { date: string; from: Date; until: Date } | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new BadRequestException('date must be today, yesterday, or YYYY-MM-DD');
    const timezone = this.config.get<string>('BUSINESS_TIMEZONE', 'Europe/Rome');
    const today = this.localDate(new Date(), timezone);
    const date = value === 'today' ? today : value === 'yesterday' ? this.addDays(today, -1) : value;
    const parsed = Date.parse(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
      throw new BadRequestException('date must be today, yesterday, or YYYY-MM-DD');
    }
    return { date, from: this.localBoundary(date, timezone), until: this.localBoundary(this.addDays(date, 1), timezone) };
  }

  private localDate(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  private addDays(date: string, days: number) {
    const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
  }

  private localBoundary(day: string, timezone: string) {
    const [year, month, date] = day.split('-').map(Number);
    const target = Date.UTC(year, month - 1, date);
    let candidate = target;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = formatter.formatToParts(new Date(candidate));
      const field = (type: string) => Number(parts.find((part) => part.type === type)?.value);
      candidate += target - Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'));
    }
    return new Date(candidate);
  }

  private input(value: {
    rawSource: Uint8Array;
    bodyText: string | null;
    direction: string;
    subject: string | null;
    fromJson: unknown;
    toJson: unknown;
  }): GateInput {
    return value;
  }

  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) {
      throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED', message: 'IMAP is not configured' });
    }
    const account = await this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true } });
    if (!account) {
      throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY', message: 'IMAP account configuration is not ready' });
    }
    return account;
  }
}
