import { domainToASCII } from 'node:url';

export const GATE_CLASSES = [
  'BUSINESS_HUMAN', 'OUTREACH_OUTBOUND', 'BLACKLISTED', 'DELIVERY_FAILURE', 'DELIVERY_DELAY',
  'OUT_OF_OFFICE', 'AUTO_ACKNOWLEDGEMENT', 'TICKET_CONFIRMATION', 'UNSUBSCRIBE', 'NEWSLETTER', 'MARKETING',
  'SYSTEM_NOTIFICATION', 'SPAM', 'UNKNOWN',
] as const;
export type GateClass = (typeof GATE_CLASSES)[number];

export const GATE_CLASS_LABELS: Record<GateClass, string> = {
  BUSINESS_HUMAN: '商务邮件', OUTREACH_OUTBOUND: '外发开发邮件',
  BLACKLISTED: '发送方黑名单',
  DELIVERY_FAILURE: '发送失败/退信', DELIVERY_DELAY: '投递延迟',
  OUT_OF_OFFICE: '自动休假回复', AUTO_ACKNOWLEDGEMENT: '自动回执',
  TICKET_CONFIRMATION: '工单确认', UNSUBSCRIBE: '退订确认',
  NEWSLETTER: '订阅邮件', MARKETING: '营销广告',
  SYSTEM_NOTIFICATION: '系统通知', SPAM: '垃圾邮件/疑似诈骗', UNKNOWN: '待判断',
};

export function senderRuleSnapshotAction(snapshot: unknown): 'blacklist' | 'whitelist' | 'none' | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !('action' in snapshot)) return null;
  const action = (snapshot as { action?: unknown }).action;
  return action === 'blacklist' || action === 'whitelist' || action === 'none' ? action : null;
}

/** Return parser-produced From addresses only; display names and recipient fields are never consulted. */
export function fromMailboxAddresses(fromJson: unknown): string[] {
  const values: unknown[] = Array.isArray(fromJson) ? fromJson : fromJson && typeof fromJson === 'object' ? [fromJson] : [];
  return [...new Set(values.flatMap((value) => {
    const address = value && typeof value === 'object' && 'address' in value ? (value as { address?: unknown }).address : null;
    if (typeof address !== 'string') return [];
    const trimmed = address.trim();
    return /^[^\s<>@]+@[^\s<>@]+$/.test(trimmed) ? [trimmed] : [];
  }))];
}

export function normalizeSystemSenderAddress(address: string): string {
  const normalized = address.trim();
  const at = normalized.lastIndexOf('@');
  if (at < 1 || at !== normalized.indexOf('@')) return '';
  const local = normalized.slice(0, at).toLocaleLowerCase('en-US');
  const domain = domainToASCII(normalized.slice(at + 1)).toLocaleLowerCase('en-US');
  return local && domain ? `${local}@${domain}` : '';
}

export async function isConfiguredSystemSender(
  direction: string,
  fromJson: unknown,
  matchAddresses: (addresses: string[]) => Promise<string[]>,
): Promise<boolean> {
  if (direction !== 'inbound') return false;
  const addresses = fromMailboxAddresses(fromJson);
  return addresses.length > 0 && (await matchAddresses(addresses)).length > 0;
}

export const MAILINBLACK_VERIFICATION_DOMAIN = 'invitations.mailinblack.com';
export const MAILINBLACK_VERIFICATION_REASON = 'Mailinblack human-verification challenge';

export function shouldApplyAutomatedClassification(manualOverride: boolean): boolean {
  return !manualOverride;
}

export type GateResult = {
  classification: GateClass;
  reason: string;
  evidence: string[];
  reviewRequired: boolean;
};

export type GateInput = {
  rawSource: Uint8Array;
  bodyText?: string | null;
  direction: string;
  subject: string | null;
  fromJson: unknown;
  toJson: unknown;
};

export function parseMailHeaders(rawSource: Uint8Array): Map<string, string> {
  const source = Buffer.from(rawSource).toString('utf8');
  const head = source.split(/\r?\n\r?\n/, 1)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!name) continue;
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return headers;
}

function headerValue(headers: Map<string, string>, name: string): string {
  return headers.get(name.toLowerCase())?.trim() ?? '';
}

function senderDomains(input: GateInput): Set<string> {
  // Use parser-produced addresses only. A display name can contain an unrelated email address.
  const values: unknown[] = Array.isArray(input.fromJson) ? input.fromJson : [input.fromJson];
  const domains = new Set<string>();
  for (const value of values) {
    const address = value && typeof value === 'object' && 'address' in value
      ? (value as { address?: unknown }).address
      : null;
    if (typeof address !== 'string') continue;
    const normalized = address.trim().toLowerCase();
    if (/^[^\s<>@]+@[^\s<>@]+$/.test(normalized)) domains.add(normalized.split('@')[1]);
  }
  return domains;
}

function rule(
  classification: GateClass,
  reason: string,
  evidence: string[],
  reviewRequired = false,
): GateResult {
  return { classification, reason, evidence, reviewRequired };
}

export function classifyMail(input: GateInput): GateResult {
  const headers = parseMailHeaders(input.rawSource);
  const evidence: string[] = [];
  const autoSubmitted = headerValue(headers, 'Auto-Submitted').toLowerCase();
  const isAutoSubmitted = Boolean(autoSubmitted && autoSubmitted !== 'no');
  const origin = headerValue(headers, 'X-SC-Origin').toLowerCase();
  const campaignId = headerValue(headers, 'X-SC-Campaign-ID');
  const contentType = headerValue(headers, 'Content-Type').toLowerCase();
  const report = parseDeliveryReport(input.rawSource, contentType);
  const status = report.status.toLowerCase();
  const action = report.action.toLowerCase();
  const diagnostic = report.diagnostic.toLowerCase();
  const precedence = headerValue(headers, 'Precedence').toLowerCase();
  const listId = headerValue(headers, 'List-Id');
  const unsubscribe = headerValue(headers, 'List-Unsubscribe');
  const spamFlag = headerValue(headers, 'X-Spam-Flag').toLowerCase();
  const spamStatus = headerValue(headers, 'X-Spam-Status').toLowerCase();
  const subject = input.subject?.toLowerCase() ?? '';
  const from = headerValue(headers, 'From').toLowerCase();
  const automatedSender = /\b(?:no-?reply|do-?not-?reply|mailer[-_. ]?daemon|postmaster)\b/i.test(from);
  const ticketPlatform = /\b(?:zendesk|freshdesk|helpscout|intercom|servicenow|atlassian|salesforce)\b/i.test(from);
  // Message text contributes classification evidence only; it never grants authorization or tool access.
  const bodyLead = (input.bodyText ?? '').split(/\n(?:on .{0,180}wrote:|am .{0,180}schrieb.*:|-----original message-----|_{5,}|>)/i, 1)[0].slice(0, 3000);
  const explicitAutoAcknowledgement = /(?:automated (?:reply|response)|this message was sent automatically|with this automated response|we confirm receipt of your (?:email|message|inquiry)|your (?:email|message|inquiry) (?:has been received|has been registered|is being handled)|thank you for (?:your )?(?:inquiry|message|contacting us).{0,120}(?:registered|received|being handled)|automatisierte antwort|bestätigen.{0,80}(?:eingang|erhalt).{0,80}(?:nachricht|e-mail)|ihre (?:nachricht|e-mail).{0,160}(?:eingang|erhalt).{0,100}(?:bestätigen|bestätigt)|ihre (?:nachricht|e-mail).{0,80}(?:eingegangen|erhalten))/i.test(bodyLead);
  const autoAcknowledgmentSubject = /^(?:thank you for (?:your )?(?:inquiry|message)|thank you for contacting|vielen dank, dass sie .{1,100}kontaktiert)/i.test(subject.trim());
  const messageId = headerValue(headers, 'Message-ID');
  const inReplyTo = headerValue(headers, 'In-Reply-To');
  const references = headerValue(headers, 'References');

  if (origin === 'outreach' && /^[A-Za-z0-9._:-]{1,100}$/.test(campaignId) && input.direction === 'outbound') {
    return rule('OUTREACH_OUTBOUND', 'Explicit outreach campaign headers', [
      'X-SC-Origin: outreach', `X-SC-Campaign-ID: ${campaignId}`,
    ]);
  }
  const authFailed = /(?:^|[,; ])(?:spf|dkim|dmarc)=fail(?:[,; ]|$)/i.test(headerValue(headers, 'Authentication-Results'));
  if (spamFlag === 'yes' || /^yes\b/.test(spamStatus) || authFailed) {
    return rule('SPAM', authFailed ? 'Sender authentication failed' : 'Explicit spam header', [
      ...(spamFlag === 'yes' ? ['X-Spam-Flag: yes'] : []),
      ...(/^yes\b/.test(spamStatus) ? ['X-Spam-Status: yes'] : []),
      ...(authFailed ? ['Authentication-Results contains an SPF, DKIM, or DMARC failure'] : []),
    ], authFailed);
  }
  const domains = senderDomains(input);
  if (input.direction === 'inbound' && domains.size === 1 && domains.has(MAILINBLACK_VERIFICATION_DOMAIN)) {
    return rule('SYSTEM_NOTIFICATION', MAILINBLACK_VERIFICATION_REASON, [
      `Sender domain: ${MAILINBLACK_VERIFICATION_DOMAIN}`,
      'Recipient must complete the human slider check to access the message',
    ]);
  }
  const combinedLead = `${subject}\n${bodyLead}`;
  const credentialExpiryLanguage = /(?:webmail login expired|server expiry id|(?:mailbox|email|webmail|server) password.{0,60}(?:expire|expiry|expired|expiration)|password.{0,60}(?:scheduled to expire|will expire|expires soon))/i.test(combinedLead);
  if (input.direction === 'inbound' && automatedSender && credentialExpiryLanguage && /(?:https?:\/\/|www\.)/i.test(bodyLead)) {
    return rule('SPAM', 'Credential-expiry alert uses an untrusted external link', ['credential-expiry language', 'external link in message lead'], true);
  }
  if (/multipart\/report/.test(contentType) && /report-type\s*=\s*delivery-status/.test(contentType)) {
    if (!report.found) {
      return rule('UNKNOWN', 'Delivery report MIME part could not be safely parsed', ['multipart/report; report-type=delivery-status'], true);
    }
    const isFailure = /5\.[0-9](?:\.[0-9])?/.test(status + ' ' + diagnostic) || /failed/.test(action);
    const isDelay = /4\.[0-9](?:\.[0-9])?/.test(status + ' ' + diagnostic) || /delayed/.test(action);
    if (isFailure || isDelay) {
      return rule(isFailure ? 'DELIVERY_FAILURE' : 'DELIVERY_DELAY', 'Structured delivery-status report', [
        'multipart/report; report-type=delivery-status',
        ...(status ? [`Status: ${status}`] : []),
        ...(action ? [`Action: ${action}`] : []),
      ]);
    }
    return rule('UNKNOWN', 'Delivery report has no recognizable status', ['delivery-status MIME report'], true);
  }
  // Many Zimbra and hosted mail systems send useful DSNs as plain text rather than RFC 3464 MIME reports.
  // Use the sender plus a specific subject signal so ordinary human messages about delivery stay untouched.
  if (input.direction === 'inbound' && automatedSender && /(?:delivery status notification\s*\(\s*delay|delivery delayed|temporary delivery failure|暂时无法投递|延迟投递)/i.test(subject)) {
    return rule('DELIVERY_DELAY', 'Automated delivery-delay sender and subject', ['automated mail sender', 'delivery-delay subject']);
  }
  if (input.direction === 'inbound' && automatedSender && /(?:failure notice|undeliver(?:able|ed)|delivery status notification\s*\(\s*failure|delivery failed|delivery failure|failure to deliver|mail delivery failed|mail system error|returned mail|returned to sender|message not delivered|发送失败|邮件发送失败|投递失败|退信)/i.test(subject)) {
    return rule('DELIVERY_FAILURE', 'Automated delivery-failure sender and subject', ['automated mail sender', 'delivery-failure subject']);
  }
  if (input.direction === 'inbound' && automatedSender && /^(?:unsubscribe(?:d)?(?: successfully)?|subscription (?:cancelled|canceled)|you have been unsubscribed|opt[- ]?out confirmation|已退订|退订成功)/i.test(subject.trim())) {
    return rule('UNSUBSCRIBE', 'Automated unsubscribe confirmation', ['automated sender', 'unsubscribe subject']);
  }
  if (listId && unsubscribe && (precedence === 'bulk' || precedence === 'list' || !precedence)) {
    return rule('NEWSLETTER', 'Mailing-list headers', ['List-Id', 'List-Unsubscribe']);
  }
  if (unsubscribe && (precedence === 'bulk' || precedence === 'list')) {
    return rule('MARKETING', 'Bulk/list mail with an unsubscribe mechanism', ['List-Unsubscribe', `Precedence: ${precedence}`]);
  }
  if (origin && origin !== 'outreach') {
    return rule('UNKNOWN', 'Unrecognized explicit origin metadata', [`X-SC-Origin: ${origin}`], true);
  }
  if (autoSubmitted && autoSubmitted !== 'no') {
    if (/out of office|automatic reply|auto.?reply|risposta automatica|fuori ufficio|assenza/i.test(subject)) {
      return rule('OUT_OF_OFFICE', 'Automatic submission header and vacation subject', ['Auto-Submitted', 'subject pattern']);
    }
    if (/ticket|case|request received|support request/i.test(subject)) {
      return rule('TICKET_CONFIRMATION', 'Automatic submission header and ticket subject', ['Auto-Submitted', 'subject pattern']);
    }
    return rule('AUTO_ACKNOWLEDGEMENT', 'Auto-Submitted header', ['Auto-Submitted']);
  }
  if (/^auto-replied$/i.test(headerValue(headers, 'X-Autoreply')) || /^yes$/i.test(headerValue(headers, 'X-Autorespond')) ) {
    return rule('AUTO_ACKNOWLEDGEMENT', 'Explicit auto-response header', ['auto-response header']);
  }
  if (input.direction === 'inbound' && ((explicitAutoAcknowledgement && (automatedSender || isAutoSubmitted || /^(?:thank you|we received|your request)/i.test(subject.trim()))) || (automatedSender && autoAcknowledgmentSubject))) {
    return rule('AUTO_ACKNOWLEDGEMENT', 'Message lead confirms an automated receipt', ['automated sender or confirmation subject', 'automated acknowledgment wording']);
  }
  if (input.direction === 'inbound' && /^(?:automatic reply|auto(?:matic)?-?reply|out of office|risposta automatica|fuori ufficio)\s*:/i.test(subject.trim())) {
    return rule('OUT_OF_OFFICE', 'Automatic-reply subject prefix', ['automatic-reply subject']);
  }
  if (/ticket created|case (?:opened|created)|request received/i.test(subject) &&
      (isAutoSubmitted || automatedSender || (ticketPlatform && /\b(?:ticket|case|#)\s*#?\d{3,}\b/i.test(subject)))) {
    return rule('TICKET_CONFIRMATION', 'Automatic ticket confirmation', ['Auto-Submitted', 'subject pattern']);
  }
  if (/notification|alert|automated report/i.test(subject) && (isAutoSubmitted || /no-reply|noreply/i.test(headerValue(headers, 'From')))) {
    return rule('SYSTEM_NOTIFICATION', 'Automated sender and system subject', ['automated sender', 'subject pattern']);
  }
  if (input.direction === 'inbound' && /^(?:request for quotation|rfq|quotation request|quote request|request a quote|询价|报价请求)(?:\b|$)/i.test(subject.trim())) {
    return rule('BUSINESS_HUMAN', 'Quotation request subject needs business attention', ['quotation/RFQ subject']);
  }
  if (campaignId || origin === 'outreach') {
    return rule('UNKNOWN', 'Campaign metadata is incomplete or conflicts with message direction', [
      ...(origin ? [`X-SC-Origin: ${origin.slice(0, 40)}`] : []),
      ...(campaignId ? [`X-SC-Campaign-ID present (${Math.min(campaignId.length, 200)} chars)`] : []),
    ], true);
  }

  evidence.push('No explicit automation, delivery, list, spam, or campaign signal');
  if (autoSubmitted === 'no') evidence.push('Auto-Submitted: no (not an automation signal)');
  // Body phrases are intentionally ignored: quoted text can contain noise vocabulary.
  if (/\b(?:out of office|automatic reply)\b/i.test(Buffer.from(input.rawSource).toString('utf8').split(/\r?\n\r?\n/).slice(1).join('\n'))) {
    evidence.push('Body phrase ignored without explicit automation header');
  }
  if (!messageId && !inReplyTo && !references) evidence.push('No RFC message/thread identifiers');
  if (input.direction === 'internal') {
    return rule('UNKNOWN', 'Self-to-self/internal message requires review', evidence, true);
  }
  if (automatedSender) {
    return rule('UNKNOWN', 'Automated-looking sender lacks a reliable classification signal', [...evidence, 'sender pattern requires review'], true);
  }
  if (/^(?:\[?request received\]?|thank you for (?:contacting|your message)|subscription update)/i.test(subject.trim())) {
    return rule('UNKNOWN', 'Automated-looking confirmation subject needs review', [...evidence, 'confirmation subject pattern requires review'], true);
  }
  return rule('BUSINESS_HUMAN', 'No deterministic noise or automation indicators', evidence);
}

export type AutomationDetailFact = { type: string; value: string; evidence: string };
export type AutomationDetails = { version: 1; classification: GateClass; facts: AutomationDetailFact[] };

/** Extract only bounded, source-backed facts from deterministic machine mail. Never invokes an LLM. */
export function extractAutomationDetails(input: GateInput, classification: GateClass): AutomationDetails | Record<string, never> {
  const supported = new Set<GateClass>([
    'DELIVERY_FAILURE', 'DELIVERY_DELAY', 'OUT_OF_OFFICE', 'AUTO_ACKNOWLEDGEMENT', 'TICKET_CONFIRMATION',
  ]);
  if (!supported.has(classification)) return {};

  const body = input.bodyText ?? '';
  const bodyLead = body.split(/\n(?:on .{0,180}wrote:|am .{0,180}schrieb.*:|-----original message-----|_{5,}|>)/i, 1)[0].slice(0, 12_000);
  const facts: AutomationDetailFact[] = [];
  const add = (type: string, value: string, evidence: string) => {
    const normalizedValue = value.replace(/\s+/g, ' ').trim().slice(0, 240);
    const normalizedEvidence = evidence.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!normalizedValue || !normalizedEvidence || facts.some((fact) => fact.type === type && fact.value === normalizedValue)) return;
    if (facts.length < 12) facts.push({ type, value: normalizedValue, evidence: normalizedEvidence });
  };

  if (classification === 'DELIVERY_FAILURE' || classification === 'DELIVERY_DELAY') {
    const report = parseStructuredDeliveryReport(input.rawSource);
    for (const address of report.failedRecipients.length ? report.failedRecipients : report.recipients) {
      add('recipient', address, `Delivery report recipient: ${address}`);
    }
    if (report.action) add('delivery_action', report.action, `Action: ${report.action}`);
    if (report.status) add('status_code', report.status, `Status: ${report.status}`);
    if (report.diagnostic) add('diagnostic', report.diagnostic, `Diagnostic-Code: ${report.diagnostic}`);

    if (!report.found) {
      const lines = bodyLead.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        const address = line.match(/(?:final-recipient|original-recipient|recipient|user|mailbox|address|for|to)\s*[:=]?\s*[<"']?(?:rfc822;\s*)?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i)?.[1];
        if (address) add('recipient', address.toLowerCase(), line);
        const code = line.match(/\b(?:5\.[0-9](?:\.[0-9])?|4\.[0-9](?:\.[0-9])?)\b/);
        if (code) add('status_code', code[0], line);
        if (/(?:unknown user|user unknown|mailbox (?:disabled|inactive|not found|unavailable|full)|address (?:not found|does not exist)|recipient rejected|找不到地址|地址不存在|邮箱(?:已停用|不可用|已满))/i.test(line)) {
          add('diagnostic', line, line);
        }
      }
    }
  }

  if (classification === 'OUT_OF_OFFICE' || classification === 'AUTO_ACKNOWLEDGEMENT') {
    const datePattern = /\b(?:(?:back|return(?:ing)?|available|away|out of office)\s+(?:on|by|from|until|through)?\s*|until\s+)(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*,?\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/i;
    const returnMatch = `${input.subject ?? ''}\n${bodyLead}`.match(datePattern);
    if (returnMatch?.[1]) {
      const line = `${input.subject ?? ''}\n${bodyLead}`.split(/\r?\n/).find((candidate) => candidate.includes(returnMatch[1]!)) ?? returnMatch[0];
      add('return_date_text', returnMatch[1], line);
    }

    const alternateCue = /\b(?:please )?(?:contact|reach|email|write to|call|speak to)\b|\b(?:for|during) (?:urgent matters|assistance|help)\b|(?:替代联系人|请联系|联系同事)/i;
    const lines = bodyLead.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && alternateCue.test(line));
    for (const line of lines.slice(0, 3)) {
      const addresses = [...line.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0].toLowerCase());
      for (const address of addresses) add('alternate_contact_email', address, line);
      const phone = line.match(/(?:\+?\d[\d ()-]{7,}\d)/)?.[0];
      if (phone) add('alternate_contact_phone', phone, line);
      if (addresses.length || phone) add('alternate_contact', line, line);
    }
  }

  if (classification === 'TICKET_CONFIRMATION' || classification === 'AUTO_ACKNOWLEDGEMENT') {
    const source = `${input.subject ?? ''}\n${bodyLead}`;
    const ticketId = source.match(/\b(?:ticket|case|request|incident|reference|ref)\s*(?:id|number|no\.?|#)?\s*[:#-]?\s*([A-Z]{0,8}[-#]?\d{3,})\b/i)?.[1];
    if (ticketId) add('ticket_id', ticketId, source.split(/\r?\n/).find((line) => line.includes(ticketId)) ?? ticketId);
    for (const match of source.matchAll(/https?:\/\/[^\s<>"']+/gi)) add('ticket_or_request_url', match[0].replace(/[),.;]+$/, ''), 'URL in automatic confirmation');
  }

  return { version: 1, classification, facts };
}

export function parseStructuredDeliveryReport(rawSource: Uint8Array) {
  const headers = parseMailHeaders(rawSource);
  return parseDeliveryReport(rawSource, headerValue(headers, 'content-type'));
}

function parseDeliveryReport(rawSource: Uint8Array, topContentType: string) {
  if (!/multipart\/report/.test(topContentType) || !/report-type\s*=\s*delivery-status/.test(topContentType)) {
    return { found: false, action: '', status: '', diagnostic: '', recipients: [] as string[], failedRecipients: [] as string[] };
  }
  const source = Buffer.from(rawSource).toString('utf8');
  const boundary = topContentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundary) return { found: false, action: '', status: '', diagnostic: '', recipients: [] as string[], failedRecipients: [] as string[] };
  const marker = `--${boundary[1] ?? boundary[2]}`;
  const part = source.split(marker).find((candidate) => /content-type:\s*message\/delivery-status/i.test(candidate));
  if (!part) return { found: false, action: '', status: '', diagnostic: '', recipients: [] as string[], failedRecipients: [] as string[] };
  // DSN fields are headers within the message/delivery-status MIME part body.
  const field = (block: string, name: string) => block.match(new RegExp(`(?:^|\\r?\\n)${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im'))?.[1]
    ?.replace(/\r?\n[ \t]+/g, ' ').trim() ?? '';
  const addresses = (block: string) => [...block.matchAll(/(?:^|\r?\n)(?:Final-Recipient|Original-Recipient):\s*([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/gim)]
    .map((match) => match[1]?.replace(/\r?\n[ \t]+/g, ' ').trim() ?? '')
    .map((value) => value.split(';').at(-1)?.trim().replace(/^<|>$/g, '') ?? '')
    .map((value) => value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? '')
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
  const recipientBlocks = part.split(/\r?\n[ \t]*\r?\n/).filter((block) => /(?:^|\r?\n)(?:Final-Recipient|Original-Recipient):/im.test(block));
  const perRecipient = recipientBlocks.map((block) => ({
    addresses: addresses(block), action: field(block, 'Action'), status: field(block, 'Status'), diagnostic: field(block, 'Diagnostic-Code'),
  }));
  const failedBlocks = perRecipient.filter((block) => block.action.toLowerCase() === 'failed' || /5\.[0-9](?:\.[0-9])?/.test(`${block.status} ${block.diagnostic}`));
  const reportBlock = failedBlocks[0] ?? perRecipient[0];
  const recipients = [...new Set(perRecipient.flatMap((block) => block.addresses))];
  const failedRecipients = [...new Set(failedBlocks.flatMap((block) => block.addresses))];
  return {
    found: true,
    action: reportBlock?.action || field(part, 'Action'),
    status: reportBlock?.status || field(part, 'Status'),
    diagnostic: reportBlock?.diagnostic || field(part, 'Diagnostic-Code'),
    recipients,
    failedRecipients,
  };
}

export function threadReferencesCampaign(input: GateInput, campaignMessageIds: string[]): boolean {
  const headers = parseMailHeaders(input.rawSource);
  const references = [headerValue(headers, 'In-Reply-To'), headerValue(headers, 'References')].join(' ');
  if (!references.trim()) return false;
  const referencedIds = new Set((references.match(/<[^<>\s]+>/g) ?? []).map((id) => id.toLowerCase()));
  return campaignMessageIds.some((id) => {
    const exactMessageId = id.match(/<[^<>\s]+>/)?.[0];
    return exactMessageId ? referencedIds.has(exactMessageId.toLowerCase()) : false;
  });
}

export function getCampaignIdHeader(input: GateInput): string | null {
  const value = parseMailHeaders(input.rawSource).get('x-sc-campaign-id')?.trim();
  return value && /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : null;
}
