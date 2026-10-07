import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { domainToUnicode } from 'node:url';
import { PrismaService } from '../../database/prisma.service';
import { SystemMailSendersService } from './system-mail-senders.service';
import { normalizeSystemSenderAddress } from './business-gate.rules';

type RawDeliveryMessage = {
  id: string;
  mailbox: string;
  rfcMessageId: string | null;
  receivedAt: Date;
  fromJson: unknown;
  classification: string;
  classificationReason: string | null;
  rawSource: Uint8Array | null;
  bodyText: string | null;
};

type DeliveryMessageMetadata = Omit<RawDeliveryMessage, 'rawSource' | 'bodyText'>;

export type DeliveryTargetStatus = 'failed' | 'delayed' | 'delivered' | 'unknown';
export type DeliveryTarget = {
  email: string | null;
  status: DeliveryTargetStatus;
  action: string | null;
  statusCode: string | null;
  diagnostic: string | null;
};

@Injectable()
export class DeliveryFailuresService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly systemMailSenders: SystemMailSendersService,
  ) {}

  async list(dateInput: unknown, limitInput: number, offsetInput: number) {
    if (!Number.isInteger(limitInput) || limitInput < 1 || limitInput > 100 ||
      !Number.isInteger(offsetInput) || offsetInput < 0 || offsetInput > 100_000) {
      throw new BadRequestException({ code: 'INVALID_PAGINATION', message: 'limit must be 1 to 100 and offset must be non-negative' });
    }
    const timezone = this.config.get<string>('BUSINESS_TIMEZONE', 'Europe/Rome');
    const range = this.dateRange(dateInput, timezone);
    const account = await this.account();
    const senderAddresses = await this.systemMailSenders.systemSenderAddresses();
    const senderAddressCandidates = this.senderAddressCandidates(senderAddresses);
    if (!senderAddresses.length) {
      return {
        date: range?.date ?? null, timezone, rangeUtc: range ? { from: range.from.toISOString(), until: range.until.toISOString() } : null,
        total: 0, limit: limitInput, offset: offsetInput,
        stats: { configuredSourceReports: 0, deliveryFailureReports: 0, deliveryDelayReports: 0, systemNotificationReports: 0, uniqueFailedRecipientAddresses: 0, failuresWithoutKnownRecipient: 0 },
        reports: [],
      };
    }
    const candidates = await this.prisma.$queryRaw<DeliveryMessageMetadata[]>(Prisma.sql`
      SELECT m."id", m."mailbox", m."rfcMessageId", m."receivedAt", m."fromJson",
        m."classification", m."classificationReason"
      FROM "EmailMessage" AS m
      WHERE m."mailAccountId" = ${account.id}
        AND m."direction" = 'inbound'
        AND m."receivedAt" IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(m."fromJson") = 'array' THEN m."fromJson" ELSE '[]'::jsonb END
          ) AS sender_entries(sender_entry)
          WHERE lower(btrim(sender_entries.sender_entry->>'address')) IN (${Prisma.join(senderAddressCandidates)})
        )
      ORDER BY m."receivedAt" ASC, m."id" ASC
    `);
    const unique = this.dedupe(candidates);
    const inRange = range ? unique.filter((message) => message.receivedAt >= range.from && message.receivedAt < range.until) : unique;
    const pageStart = offsetInput;
    const pageEnd = offsetInput + limitInput;
    let failureCount = 0;
    let delayCount = 0;
    let systemCount = 0;
    let failuresWithoutKnownRecipient = 0;
    const failedAddresses = new Set<string>();
    const pageReports: ReturnType<DeliveryFailuresService['report']>[] = [];
    for (let start = 0; start < inRange.length; start += 8) {
      const batch = inRange.slice(start, start + 8);
      const payloadRows = batch.length ? await this.prisma.emailMessage.findMany({
        where: { id: { in: batch.map((message) => message.id) } },
        select: { id: true, rawSource: true, bodyText: true },
      }) : [];
      const payloads = new Map(payloadRows.map((row) => [row.id, { rawSource: row.rawSource, bodyText: row.bodyText }]));
      for (let index = 0; index < batch.length; index += 1) {
        const absoluteIndex = start + index;
        const metadata = batch[index];
        const payload = payloads.get(metadata.id);
        const report = this.report({ ...metadata, rawSource: payload?.rawSource ?? null, bodyText: payload?.bodyText ?? null }, senderAddresses);
        if (report.deliveryState === 'failure') {
          failureCount += 1;
          const knownFailureTargets = report.targets.filter((target) => target.status === 'failed' && target.email !== null);
          for (const target of knownFailureTargets) failedAddresses.add(target.email!.trim().toLowerCase());
          if (!knownFailureTargets.length) failuresWithoutKnownRecipient += 1;
        } else if (report.deliveryState === 'delay') delayCount += 1;
        else systemCount += 1;
        if (absoluteIndex >= pageStart && absoluteIndex < pageEnd) pageReports.push(report);
      }
    }
    return {
      date: range?.date ?? null,
      timezone,
      rangeUtc: range ? { from: range.from.toISOString(), until: range.until.toISOString() } : null,
      total: inRange.length,
      limit: limitInput,
      offset: offsetInput,
      stats: {
        configuredSourceReports: inRange.length,
        deliveryFailureReports: failureCount,
        deliveryDelayReports: delayCount,
        systemNotificationReports: systemCount,
        uniqueFailedRecipientAddresses: failedAddresses.size,
        failuresWithoutKnownRecipient,
      },
      reports: pageReports,
    };
  }

  private report(message: RawDeliveryMessage, configuredSenders: string[]) {
    const participants = this.addressParticipants(message.fromJson);
    const sender = participants.find((participant) => configuredSenders.includes(participant.address)) ?? participants[0] ?? { address: 'unknown', name: null };
    const structured = message.rawSource ? this.structuredTargets(message.rawSource) : null;
    const storedState = message.classification === 'DELIVERY_FAILURE' ? 'failure'
      : message.classification === 'DELIVERY_DELAY' ? 'delay' : null;
    const bodyText = message.bodyText ?? '';
    const plainMarkerState = this.plainReportState(bodyText);
    const plainTargets = structured === null ? this.plainTextTargets(bodyText, plainMarkerState) : [];
    const evidenceTargets = structured ?? plainTargets;
    const hasFailed = evidenceTargets.some((target) => target.status === 'failed');
    const hasDelayed = evidenceTargets.some((target) => target.status === 'delayed');
    const hasDelivered = evidenceTargets.some((target) => target.status === 'delivered');
    const deliveryState: 'failure' | 'delay' | 'system_notification' = hasFailed ? 'failure'
      : hasDelayed ? 'delay'
        : hasDelivered ? 'system_notification'
          : structured !== null ? storedState ?? 'system_notification'
            : plainMarkerState ?? 'system_notification';
    const targets = evidenceTargets.length ? evidenceTargets : [this.unknownTarget()];
    const diagnosticReason = evidenceTargets.find((target) => (target.status === 'failed' || target.status === 'delayed') && target.diagnostic)?.diagnostic;
    return {
      messageId: message.id,
      receivedAt: message.receivedAt.toISOString(),
      mailbox: message.mailbox,
      sourceSender: { address: sender.address, name: sender.name },
      classification: message.classification,
      deliveryState,
      isFailure: deliveryState === 'failure',
      targets,
      reason: this.shortText(diagnosticReason) ?? this.shortText(message.classificationReason) ??
        (deliveryState === 'failure' ? 'Delivery failure report'
          : deliveryState === 'delay' ? 'Delivery delay report'
            : 'Configured system sender; no delivery failure evidence'),
    };
  }

  private dedupe(messages: DeliveryMessageMetadata[]): DeliveryMessageMetadata[] {
    const groups = new Map<string, DeliveryMessageMetadata[]>();
    for (const message of messages) {
      const rfcId = typeof message.rfcMessageId === 'string' ? message.rfcMessageId.trim() : '';
      const key = rfcId ? `rfc:${rfcId}` : `message:${message.id}`;
      const group = groups.get(key) ?? [];
      group.push(message);
      groups.set(key, group);
    }
    const priority = (classification: string) => classification === 'DELIVERY_FAILURE' ? 0 : classification === 'DELIVERY_DELAY' ? 1 : 2;
    return [...groups.values()].map((group) => {
      const earliest = [...group].sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime() || left.id.localeCompare(right.id))[0];
      const bestClassification = [...group].sort((left, right) => priority(left.classification) - priority(right.classification) || left.receivedAt.getTime() - right.receivedAt.getTime())[0];
      return { ...earliest, classification: bestClassification.classification, classificationReason: bestClassification.classificationReason ?? earliest.classificationReason };
    })
      .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime() || right.id.localeCompare(left.id));
  }

  private addressParticipants(value: unknown): Array<{ address: string; name: string | null }> {
    if (!Array.isArray(value)) return [];
    const participants: Array<{ address: string; name: string | null }> = [];
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.address !== 'string') continue;
      const address = normalizeSystemSenderAddress(row.address);
      if (!this.validAddress(address)) continue;
      participants.push({ address, name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 120) : null });
    }
    return participants;
  }

  private structuredTargets(rawSource: Uint8Array): DeliveryTarget[] | null {
    const source = Buffer.from(rawSource).toString('utf8');
    const header = this.rawHeaders(source.split(/\r?\n\r?\n/, 1)[0] ?? '');
    const contentType = header.get('content-type') ?? '';
    if (!/multipart\/report\b/i.test(contentType) || !/report-type\s*=\s*["']?delivery-status/i.test(contentType)) return null;
    const boundary = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i)?.slice(1).find(Boolean);
    if (!boundary) return [];
    const matchingPart = source.split(`--${boundary}`).map((part) => {
      const separator = part.search(/\r?\n\r?\n/);
      if (separator < 0) return null;
      const delimiter = part.slice(separator).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
      const headerText = part.slice(0, separator);
      const headers = this.rawHeaders(headerText);
      if (!/^message\/delivery-status\b/i.test(headers.get('content-type') ?? '')) return null;
      return part.slice(separator + delimiter.length);
    }).find((body): body is string => body !== null);
    if (matchingPart === undefined) return [];
    const blocks = matchingPart.split(/\r?\n[ \t]*\r?\n/).filter((block) => /(?:^|\r?\n)(?:Final-Recipient|Original-Recipient)\s*:/im.test(block));
    return blocks.flatMap((block) => {
      const finalRecipient = this.mimeField(block, 'Final-Recipient');
      const originalRecipient = this.mimeField(block, 'Original-Recipient');
      const email = this.addressFromRecipientField(finalRecipient || originalRecipient);
      if (!email) return [];
      const action = (this.mimeField(block, 'Action') ?? '').trim().toLowerCase() || null;
      const statusCode = (this.mimeField(block, 'Status') ?? '').trim().match(/\b[245]\.\d{1,3}(?:\.\d{1,3})?\b/)?.[0] ?? null;
      const diagnostic = this.shortText(this.mimeField(block, 'Diagnostic-Code'));
      return [{ email, status: this.targetStatus(action, statusCode, diagnostic), action, statusCode, diagnostic }];
    });
  }

  private plainTextTargets(bodyText: string, deliveryState: 'failure' | 'delay' | null): DeliveryTarget[] {
    const lead = this.unquotedLead(bodyText);
    const unfolded = lead.replace(/\r?\n[ \t]+/g, ' ');
    const targets: DeliveryTarget[] = [];
    const add = (value: string, evidenceStatus: DeliveryTargetStatus | undefined, evidence?: string) => {
      const email = this.addressFromRecipientField(value);
      if (!email || targets.some((target) => target.email === email)) return;
      targets.push({ email, status: evidenceStatus ?? (deliveryState === 'failure' ? 'failed' : deliveryState === 'delay' ? 'delayed' : 'unknown'), action: null, statusCode: evidence?.match(/\b[245]\.\d{1,3}(?:\.\d{1,3})?\b/)?.[0] ?? evidence?.match(/\b[245]\d\d\b/)?.[0] ?? null, diagnostic: evidence ? this.shortText(evidence) : null });
    };
    for (const paragraph of unfolded.split(/\r?\n[ \t]*\r?\n/)) {
      if (!/(?:^|\r?\n)(?:Final-Recipient|Original-Recipient)\s*:/im.test(paragraph)) continue;
      const finalRecipient = this.mimeField(paragraph, 'Final-Recipient');
      const originalRecipient = this.mimeField(paragraph, 'Original-Recipient');
      const action = (this.mimeField(paragraph, 'Action') ?? '').trim().toLowerCase() || null;
      const statusCode = (this.mimeField(paragraph, 'Status') ?? '').match(/\b[245]\.\d{1,3}(?:\.\d{1,3})?\b/)?.[0] ?? null;
      const diagnostic = this.shortText(this.mimeField(paragraph, 'Diagnostic-Code'));
      let status = this.targetStatus(action, statusCode, diagnostic);
      if (status === 'unknown' && deliveryState) status = deliveryState === 'failure' ? 'failed' : 'delayed';
      add(finalRecipient || originalRecipient || '', status, diagnostic ?? undefined);
    }

    const phrasePatterns: Array<{ pattern: RegExp; status: DeliveryTargetStatus }> = [
      { pattern: /\byour message (?:was not|wasn't) delivered to\s*<?([^\s<>;,]+@[^\s<>;,]+)>?\s+because\b/ig, status: 'failed' },
      { pattern: /\byour message (?:to|for)\s*<?([^\s<>;,]+@[^\s<>;,]+)>?\s+(?:could not|couldn't) be delivered\b/ig, status: 'failed' },
      { pattern: /\byour message (?:to|for)\s*<?([^\s<>;,]+@[^\s<>;,]+)>?\s+(?:was delayed|has been delayed)\b/ig, status: 'delayed' },
    ];
    for (const { pattern, status } of phrasePatterns) {
      for (const match of unfolded.matchAll(pattern)) add(match[1], status, match[0]);
    }

    const lines = lead.replace(/\r\n/g, '\n').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const heading = lines[index].match(/^\s*<?([^\s<>;,]+@[^\s<>;,]+)>?\s*:\s*(.*)$/);
      if (!heading) continue;
      const evidenceLines = [heading[2]];
      for (let next = index + 1; next < Math.min(lines.length, index + 5); next += 1) {
        if (!lines[next].trim() || /^\s*<?[^\s<>;,]+@[^\s<>;,]+>?\s*:/.test(lines[next])) break;
        evidenceLines.push(lines[next].trim());
      }
      const evidence = evidenceLines.join(' ');
      const hostFailure = /\bhost\b.{0,240}\b(?:said|replied|returned)\s*:\s*(?:5\d\d|5\.\d{1,3}(?:\.\d{1,3})?)/i.test(evidence);
      const qmailFailure = /\b(?:sorry,?\s*)?(?:no mailbox|(?:unknown|no such)\s+(?:user|mailbox)|user unknown|recipient address rejected|mailbox unavailable)\b|(?:#?5[. ]\d{1,3}|\b5\d\d\b)/i.test(evidence);
      if (hostFailure || qmailFailure) add(heading[1], 'failed', evidence);
    }
    return targets;
  }

  private plainReportState(bodyText: string): 'failure' | 'delay' | null {
    const lead = this.unquotedLead(bodyText);
    if (/\b(?:delivery status notification\s*(?:\(|:|-)?\s*(?:failure|failed)|undelivered mail returned|mail delivery failed|delivery failure(?: notification| report)?|failure report|delivery failed|message (?:was not|wasn't) delivered|could not be delivered|couldn't be delivered|no mailbox here|user unknown|unknown user|recipient address rejected)\b/i.test(lead)) return 'failure';
    if (/\b(?:delivery status notification\s*(?:\(|:|-)?\s*(?:delay|delayed)|delivery delay(?: notification| report)?|delivery delayed|temporarily deferred|message.{0,80}was delayed)\b/i.test(lead)) return 'delay';
    return null;
  }

  private targetStatus(action: string | null, statusCode: string | null, diagnostic: string | null): DeliveryTargetStatus {
    if (action === 'failed') return 'failed';
    if (action === 'delayed') return 'delayed';
    if (['delivered', 'relayed', 'expanded'].includes(action ?? '')) return 'delivered';
    if (statusCode?.startsWith('5.') || /\b5\d\d\b/.test(diagnostic ?? '')) return 'failed';
    if (statusCode?.startsWith('4.') || /\b4\d\d\b/.test(diagnostic ?? '')) return 'delayed';
    if (statusCode?.startsWith('2.')) return 'delivered';
    return 'unknown';
  }

  private addressFromRecipientField(value: string | null): string | null {
    if (!value) return null;
    const unfolded = value.replace(/\r?\n[ \t]+/g, ' ').trim();
    const afterType = unfolded.replace(/^[^;]+;\s*/, '').trim();
    const candidate = afterType.startsWith('<') && afterType.includes('>') ? afterType.slice(1, afterType.indexOf('>')) : afterType.split(/[\s,;]+/, 1)[0];
    const email = candidate.trim().replace(/^mailto:/i, '').toLowerCase();
    return this.validAddress(email) ? email : null;
  }

  private mimeField(block: string, field: string): string | null {
    const match = block.match(new RegExp(`(?:^|\\r?\\n)${field}\\s*:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im'));
    return match?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim() ?? null;
  }

  private rawHeaders(value: string): Map<string, string> {
    const headers = new Map<string, string>();
    for (const line of value.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index < 1) continue;
      const key = line.slice(0, index).trim().toLowerCase();
      const content = line.slice(index + 1).trim();
      headers.set(key, headers.has(key) ? `${headers.get(key)}, ${content}` : content);
    }
    return headers;
  }

  private unquotedLead(value: string): string {
    const lines: string[] = [];
    for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
      if (/^\s*>/.test(line) || /^\s*(?:-{2,}\s*(?:original|forwarded) message\s*-{2,}|begin forwarded message:|(?:-{2,}\s*)?(?:below this line is a copy of the message|this is a copy of the message|original message)(?:[.!]?\s*-{0,})?)\s*$/i.test(line) ||
        /^\s*On .{1,240} wrote:\s*$/i.test(line) || /^\s*From:\s+.+$/i.test(line)) break;
      lines.push(line);
    }
    return lines.join('\n');
  }

  private unknownTarget(): DeliveryTarget {
    return { email: null, status: 'unknown', action: null, statusCode: null, diagnostic: null };
  }

  private validAddress(value: string): boolean {
    return value.length <= 320 && /^[^\s@<>;,]+@[^\s@<>;,\.]+(?:\.[^\s@<>;,\.]+)+$/.test(value);
  }

  private senderAddressCandidates(addresses: string[]): string[] {
    const candidates = new Set<string>();
    for (const rawAddress of addresses) {
      const address = normalizeSystemSenderAddress(rawAddress);
      const at = address.lastIndexOf('@');
      if (at < 1) continue;
      candidates.add(address);
      const local = address.slice(0, at);
      const asciiDomain = address.slice(at + 1);
      const unicodeDomain = domainToUnicode(asciiDomain).toLocaleLowerCase('en-US');
      if (unicodeDomain && unicodeDomain !== asciiDomain) candidates.add(`${local}@${unicodeDomain}`);
    }
    return [...candidates];
  }

  private shortText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const text = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 180) : null;
  }

  private dateRange(value: unknown, timezone: string): { date: string; from: Date; until: Date } | null {
    if (value === undefined || value === null || value === '') {
      const date = this.localDate(new Date(), timezone);
      return { date, from: this.localBoundary(date, timezone), until: this.localBoundary(this.addDays(date, 1), timezone) };
    }
    if (typeof value !== 'string') throw new BadRequestException({ code: 'INVALID_DELIVERY_FAILURE_DATE', message: 'date must be YYYY-MM-DD' });
    const date = value.trim();
    const parsed = Date.parse(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
      throw new BadRequestException({ code: 'INVALID_DELIVERY_FAILURE_DATE', message: 'date must be YYYY-MM-DD' });
    }
    return { date, from: this.localBoundary(date, timezone), until: this.localBoundary(this.addDays(date, 1), timezone) };
  }

  private addDays(date: string, days: number): string {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  private localDate(value: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
    const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${field('year')}-${field('month')}-${field('day')}`;
  }

  private localBoundary(day: string, timezone: string): Date {
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

  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED', message: 'IMAP is not configured' });
    const account = await this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY', message: 'IMAP account is not ready' });
    return account;
  }
}
