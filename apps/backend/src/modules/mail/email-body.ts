import type { PrismaService } from '../../database/prisma.service';
// Conversion parses HTML as data; it never renders markup or loads remote assets.
const { convert } = require('html-to-text') as {
  convert(html: string, options: Record<string, unknown>): string;
};

export function readableEmailBody(text: string | null | undefined, html: string | null | undefined): string | null {
  if (text?.trim()) return text;
  if (!html?.trim()) return null;
  const converted = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
    ],
  }).trim();
  return converted || null;
}

/** A display/analysis projection only. Never replaces the stored MIME text or raw evidence. */
export function currentEmailBody(text: string | null | undefined, html: string | null | undefined, quotedBodies: string[] = []): string | null {
  // Structural quote containers preserve replies written AFTER a quote and inline unquoted replies.
  let body = html?.trim() ? convert(html, {
    wordwrap: false,
    selectors: [
      ...['img', 'script', 'style', 'blockquote', '.gmail_quote', '.yahoo_quoted', '.moz-cite-prefix'].map(selector => ({ selector, format: 'skip' })),
    ],
  }).trim() : (text ?? '').trim();
  // Some malformed HTML alternatives are empty; their plain-text alternative is still useful.
  if (!body && html && !/(?:blockquote|gmail_quote|yahoo_quoted)/i.test(html)) body = (text ?? '').trim();
  const replyHeader = /^(?:on\s+.{3,300}\bwrote\s*:|il\s+.{3,300}\bha scritto\s*:|le\s+.{3,300}\ba écrit\s*:|am\s+.{3,300}\bschrieb.*:|在.{2,200}(?:写道|寫道)\s*[:：]|[-_]{2,}\s*(?:original message|messaggio originale|forwarded message|原始邮件|转发邮件)\s*[-_]*|[-_]{5,})$/iu;
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const hasHeader = lines.some(line => replyHeader.test(line.trim()) || /^(?:from|da|发件人)\s*:/iu.test(line.trim()));
  const structuredQuotes = Boolean(html && /<blockquote\b|gmail_quote|yahoo_quoted/i.test(html));
  let matchedParent = false;
  if (hasHeader) {
    const headerIndex = lines.findIndex(line => replyHeader.test(line.trim()) || /^(?:from|da|发件人)\s*:/iu.test(line.trim()));
    const beforeHistory = lines.slice(0, headerIndex).join('\n');
    let history = lines.slice(headerIndex).join('\n');
    const matched: string[] = [];
    for (const prior of [...new Set(quotedBodies)].sort((a, b) => b.length - a.length)) {
      const value = prior.trim();
      if (value.length < 6 || matched.some(anchor => anchor.includes(value))) continue;
      const escaped = value.split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(String.raw`\s+(?:>\s*)?`);
      const pattern = new RegExp(escaped, 'u');
      if (pattern.test(history)) { matchedParent = true; matched.push(value); history = history.replace(pattern, ''); }
    }
    body = `${beforeHistory}\n${history}`;
  }
  const result: string[] = [];
  const source = body.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < source.length; index++) {
    const line = source[index]; const trimmed = line.trim();
    if (/^>/.test(trimmed)) continue;
    const outlookHeader = /^(?:from|da|发件人)\s*:/iu.test(trimmed) && source.slice(index + 1, index + 7).some(next => /^(?:sent|inviato|date|发送时间|发送日期|subject|oggetto|主题)\s*:/iu.test(next.trim()));
    if (replyHeader.test(trimmed) || outlookHeader) {
      if (outlookHeader) while (index + 1 < source.length && /^(?:\s*$|(?:sent|inviato|date|to|a|cc|subject|oggetto|发送时间|发送日期|收件人|抄送|主题)\s*:)/iu.test(source[index + 1].trim())) index++;
      // Unmarked plain-text history has no reliable end boundary. Linked parent text can
      // establish it; otherwise retain only the authored content before that history.
      const firstFollowing = source.slice(index + 1).find(next => next.trim());
      if (!matchedParent && !structuredQuotes && firstFollowing && !/^>/.test(firstFollowing.trim())) break;
      continue;
    }
    result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim() || null;
}

export async function quotedParentBodies(
  db: Pick<PrismaService, 'emailMessage'>,
  accountId: string,
  headers: unknown,
  excludeParent?: (parent: { direction: string; fromJson: unknown }) => Promise<boolean>,
): Promise<string[]> {
  const values = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers as Record<string, unknown> : {};
  const ids = [...new Set([values.inReplyTo, ...(Array.isArray(values.references) ? values.references : [])].filter((id): id is string => typeof id === 'string' && id.length < 1000))].slice(-20);
  if (!ids.length) return [];
  const parents = await db.emailMessage.findMany({ where: { mailAccountId: accountId, rfcMessageId: { in: ids } }, select: { bodyText: true, bodyHtml: true, direction: true, fromJson: true }, take: 40 });
  const eligible = excludeParent ? [] : parents;
  if (excludeParent) for (const parent of parents) if (!await excludeParent(parent)) eligible.push(parent);
  return eligible.flatMap((parent: { bodyText: string | null; bodyHtml: string | null }) => [readableEmailBody(parent.bodyText, parent.bodyHtml), currentEmailBody(parent.bodyText, parent.bodyHtml)]).filter((body: string | null): body is string => Boolean(body));
}
