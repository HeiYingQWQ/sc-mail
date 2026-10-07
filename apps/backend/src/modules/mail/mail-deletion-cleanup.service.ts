import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { ProjectEmailAnalysisService } from './project-email-analysis.service';

const SCAN_BATCH = 500;
const DELETE_BATCH = 50;

type LockedMessage = {
  id: string;
  mailAccountId: string;
  mailbox: string;
  uidValidity: bigint;
  uid: number;
};

@Injectable()
export class MailDeletionCleanupService {
  constructor(private readonly prisma: PrismaService, private readonly projectAnalysis: ProjectEmailAnalysisService) {}

  /**
   * Called only after the scheduler has obtained and validated a complete UID
   * snapshot for every configured mailbox. snapshotMaxUid is uidNext - 1 at
   * snapshot time, so arrivals after the snapshot cannot be removed.
   */
  async deleteMissing(
    accountId: string,
    mailbox: string,
    uidValidity: bigint,
    remoteUids: Set<number>,
    snapshotMaxUid: number,
  ): Promise<number> {
    if (!accountId || !mailbox || uidValidity <= 0n || !Number.isSafeInteger(snapshotMaxUid) || snapshotMaxUid < 0) {
      throw new Error('INVALID_MAIL_DELETION_SNAPSHOT');
    }
    let lastUid = 0;
    let deleted = 0;
    while (true) {
      const page = await this.prisma.emailMessage.findMany({
        where: {
          mailAccountId: accountId,
          mailbox,
          uidValidity,
          uid: { gt: lastUid, lte: snapshotMaxUid },
        },
        orderBy: { uid: 'asc' },
        take: SCAN_BATCH,
        select: { id: true, uid: true },
      });
      if (!page.length) break;
      lastUid = page[page.length - 1].uid;
      const missingIds = page.filter((message) => !remoteUids.has(message.uid)).map((message) => message.id);
      for (let start = 0; start < missingIds.length; start += DELETE_BATCH) {
        deleted += await this.deleteBatch(accountId, mailbox, uidValidity, remoteUids, snapshotMaxUid, missingIds.slice(start, start + DELETE_BATCH));
      }
      if (page.length < SCAN_BATCH) break;
    }
    // Old UIDVALIDITY values are incomparable with the current UID set.
    // Recovery imports only the configured history window, so older remote mail
    // might still exist even when its old local row has not been refreshed.
    // Leave those rows for a separate identity-based reconciliation.
    return deleted;
  }

  private async deleteBatch(
    accountId: string,
    mailbox: string,
    uidValidity: bigint,
    remoteUids: Set<number>,
    snapshotMaxUid: number,
    ids: string[],
  ): Promise<number> {
    if (!ids.length) return 0;
    return this.prisma.$transaction(async (tx) => {
      // persistPage takes this exact transaction lock before checking tombstones.
      // The pair of locks prevents an already fetched page from resurrecting a
      // message after its deletion is committed.
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mail-sync:${accountId}:${mailbox}`}, 0))::text AS "locked"`);
      const locked = await tx.$queryRaw<LockedMessage[]>(Prisma.sql`
        SELECT "id", "mailAccountId", "mailbox", "uidValidity", "uid"
        FROM "EmailMessage" WHERE "id" IN (${Prisma.join(ids)}) FOR UPDATE
      `);
      const selected = locked.filter((message) =>
        message.mailAccountId === accountId && message.mailbox === mailbox &&
        message.uidValidity === uidValidity && message.uid <= snapshotMaxUid &&
        !remoteUids.has(message.uid),
      );
      if (!selected.length) return 0;
      const messageIds = selected.map((message) => message.id);
      const deletedAt = new Date();

      await this.projectAnalysis.markDeletedSources(tx, messageIds, deletedAt);

      await tx.mailDeletionTombstone.createMany({
        data: selected.map((message) => ({
          id: randomUUID(), mailAccountId: accountId, mailbox, uidValidity,
          uid: message.uid, messageId: message.id, deletedAt,
        })),
        skipDuplicates: true,
      });

      await tx.emailImportanceTriage.deleteMany({ where: { sourceMessageId: { in: messageIds } } });
      await tx.processingRecord.deleteMany({ where: { sourceMessageId: { in: messageIds } } });
      await tx.analysisRun.deleteMany({ where: { sourceMessageId: { in: messageIds } } });
      await tx.taskEvidence.deleteMany({ where: { sourceMessageId: { in: messageIds } } });

      await tx.reviewItem.deleteMany({ where: { entityType: 'email_message', entityId: { in: messageIds }, reasonCode: { not: { startsWith: 'PROJECT_ANALYSIS_' } } } });
      await tx.reviewItem.updateMany({
        where: { sourceMessageId: { in: messageIds } },
        data: { sourceMessageId: null, sourceDeletedAt: deletedAt },
      });
      await tx.task.updateMany({
        where: { createdFromMessageId: { in: messageIds } },
        data: { createdFromMessageId: null, createdSourceDeletedAt: deletedAt },
      });
      await tx.task.updateMany({
        where: { completedFromMessageId: { in: messageIds } },
        data: { completedFromMessageId: null, completedSourceDeletedAt: deletedAt },
      });
      await tx.requirement.updateMany({
        where: { sourceMessageId: { in: messageIds } },
        data: { sourceMessageId: null, sourceDeletedAt: deletedAt },
      });
      await tx.decision.updateMany({
        where: { sourceMessageId: { in: messageIds } },
        data: { sourceMessageId: null, sourceDeletedAt: deletedAt },
      });
      await tx.summaryVersion.updateMany({
        where: { triggerMessageId: { in: messageIds } },
        data: { triggerMessageId: null, sourceDeletedAt: deletedAt },
      });
      await tx.timelineEvent.updateMany({
        where: { sourceMessageId: { in: messageIds } },
        data: { sourceMessageId: null, sourceDeletedAt: deletedAt },
      });

      // BusinessOperation has no FK. Scrub JSON copies, but keep the operation
      // identity and action as an audit of business changes already made.
      await tx.businessOperation.updateMany({
        where: { OR: [
          { sourceMessageId: { in: messageIds } },
          { entityType: 'email_message', entityId: { in: messageIds } },
        ] },
        data: {
          sourceMessageId: null,
          beforeJson: Prisma.DbNull,
          afterJson: { redacted: true, reason: 'SOURCE_MAIL_DELETED' },
        },
      });

      const events = await tx.agentEvent.findMany({
        where: { entityType: 'email_message', entityId: { in: messageIds } },
        select: { id: true },
      });
      const eventIds = events.map((event) => event.id);
      if (eventIds.length) {
        await tx.notificationDelivery.deleteMany({ where: { eventId: { in: eventIds } } });
        await tx.agentWakeupDelivery.deleteMany({ where: { eventId: { in: eventIds } } });
        await tx.agentEvent.deleteMany({ where: { id: { in: eventIds } } });
      }

      // The deletion audit contains only IDs and IMAP identity, never content.
      await tx.businessOperation.createMany({
        data: selected.map((message) => ({
          id: randomUUID(), operationId: `mail-delete:${message.id}`,
          inputHash: 'imap-uid-absence-v1', entityType: 'mail_deletion',
          entityId: message.id, action: 'delete', actorId: 'mail-deletion-sync',
          afterJson: {
            mailAccountId: accountId, mailbox, uidValidity: uidValidity.toString(),
            uid: message.uid, deletedAt: deletedAt.toISOString(),
          },
        })),
        skipDuplicates: true,
      });
      await tx.emailMessage.deleteMany({ where: { id: { in: messageIds } } });
      return messageIds.length;
    }, { timeout: 60_000 });
  }
}
