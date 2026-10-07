import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

type ThreadMessage = { id: string; rfcMessageId: string | null; subject: string | null; direction: string; sentAt: Date | null; receivedAt: Date | null };

/** RFC relationships, never subject equality. UNION terminates even for malformed cyclic headers. */
export async function emailThreadNavigation(db: PrismaService, accountId: string, messageId: string) {
  const members = await db.$queryRaw<ThreadMessage[]>(Prisma.sql`
    WITH RECURSIVE connected(id) AS (
      SELECT "id" FROM "EmailMessage" WHERE "id"=${messageId} AND "mailAccountId"=${accountId}
      UNION
      SELECT e."id" FROM connected c
      JOIN "EmailMessage" p ON p."id"=c.id
      JOIN "EmailMessage" e ON e."mailAccountId"=${accountId} AND (
        (p."threadId" IS NOT NULL AND e."threadId"=p."threadId") OR
        (p."rfcMessageId" IS NOT NULL AND (e."threadId"=p."rfcMessageId" OR e."headersJson"->>'inReplyTo'=p."rfcMessageId" OR (e."headersJson"->'references') ? p."rfcMessageId")) OR
        (e."rfcMessageId" IS NOT NULL AND (p."threadId"=e."rfcMessageId" OR p."headersJson"->>'inReplyTo'=e."rfcMessageId" OR (p."headersJson"->'references') ? e."rfcMessageId"))
      )
    ) SELECT e."id", e."rfcMessageId", e."subject", e."direction", e."sentAt", e."receivedAt"
      FROM connected c JOIN "EmailMessage" e ON e."id"=c.id
      ORDER BY COALESCE(e."sentAt", e."receivedAt", e."createdAt"), e."id"`);
  // A Sent/Inbox copy with the same RFC ID is one logical message. Keep the open copy.
  const unique: ThreadMessage[] = []; const positions = new Map<string, number>();
  for (const member of members) {
    const key = member.rfcMessageId ?? member.id;
    const position = positions.get(key);
    if (position === undefined) { positions.set(key, unique.length); unique.push(member); }
    else if (member.id === messageId) unique[position] = member;
  }
  const index = unique.findIndex(member => member.id === messageId);
  const view = (member: ThreadMessage | undefined) => member ? { id: member.id, subject: member.subject, direction: member.direction, sentAt: member.sentAt, receivedAt: member.receivedAt } : null;
  return { previous: index > 0 ? view(unique[index - 1]) : null, next: index >= 0 ? view(unique[index + 1]) : null, position: index + 1, total: unique.length };
}
