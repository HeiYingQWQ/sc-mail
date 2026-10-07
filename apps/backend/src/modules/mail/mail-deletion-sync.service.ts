import { Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../database/prisma.service';
import { ImapMailService } from './imap-mail.service';
import { MailDeletionCleanupService } from './mail-deletion-cleanup.service';

const LEASE_MS = 30 * 60_000;
const RETRY_MS = 15 * 60_000;

@Injectable()
export class MailDeletionSyncService implements OnModuleInit, OnModuleDestroy {
  private active = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly imap: ImapMailService,
    private readonly cleanup: MailDeletionCleanupService,
    @InjectPinoLogger(MailDeletionSyncService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('APP_ROLE', 'backend') !== 'worker') return;
    this.active = true;
    void this.schedulerLoop();
  }

  onModuleDestroy() { this.active = false; }

  async status() {
    const account = await this.account();
    if (!account) return { configured: false, enabled: false };
    // Expose legacy UIDVALIDITY namespaces for a separate identity audit.
    const [checkpoint, syncCheckpoints, namespaces] = await Promise.all([
      this.prisma.mailDeletionSyncCheckpoint.findUnique({ where: { mailAccountId: account.id } }),
      this.prisma.syncCheckpoint.findMany({ where: { mailAccountId: account.id }, select: { mailbox: true, uidValidity: true } }),
      this.prisma.emailMessage.groupBy({ by: ['mailbox', 'uidValidity'], where: { mailAccountId: account.id }, _count: { _all: true } }),
    ]);
    const currentValidity = new Map(syncCheckpoints.map((item) => [item.mailbox, item.uidValidity]));
    const legacyNamespaces = namespaces.filter((item) => currentValidity.get(item.mailbox) !== item.uidValidity);
    return {
      configured: true,
      enabled: this.config.get<boolean>('MAIL_DELETION_SYNC_ENABLED', true),
      intervalHours: this.config.get<number>('MAIL_DELETION_SYNC_INTERVAL_HOURS', 4),
      legacyNamespace: {
        unverifiedCount: legacyNamespaces.reduce((sum, item) => sum + item._count._all, 0),
        folders: legacyNamespaces.map((item) => ({
          mailbox: item.mailbox, uidValidity: item.uidValidity.toString(), count: item._count._all,
        })),
      },
      checkpoint: checkpoint ? {
        status: checkpoint.status,
        lastAttemptAt: checkpoint.lastAttemptAt,
        lastCompletedAt: checkpoint.lastCompletedAt,
        nextRunAt: checkpoint.nextRunAt,
        scannedCount: checkpoint.scannedCount,
        deletedCount: checkpoint.deletedCount,
        lastErrorCode: checkpoint.lastErrorCode,
        leaseActive: Boolean(checkpoint.leaseExpiresAt && checkpoint.leaseExpiresAt > new Date()),
      } : null,
    };
  }

  async auditLegacyNamespace() {
    const unavailable = (code: string) => new ServiceUnavailableException({ code, message: 'Legacy UIDVALIDITY audit could not complete safely' });
    const account = await this.account();
    if (!account) throw unavailable('IMAP_ACCOUNT_NOT_READY');
    const folders = this.configuredFolders();
    const checkpoints = await this.prisma.syncCheckpoint.findMany({
      where: { mailAccountId: account.id, mailbox: { in: folders } },
      select: { mailbox: true, uidValidity: true, status: true, lastErrorCode: true, reconciliationRequired: true },
    });
    if (checkpoints.length !== folders.length) throw unavailable('FOLDER_SYNC_NOT_READY');
    const current = new Map(checkpoints.map((item) => [item.mailbox, item]));
    for (const folder of folders) {
      const state = current.get(folder);
      if (!state || state.status !== 'completed' || state.uidValidity === null || state.lastErrorCode || state.reconciliationRequired) {
        throw unavailable('FOLDER_SYNC_NOT_READY');
      }
    }
    const namespaces = await this.prisma.emailMessage.groupBy({
      by: ['mailbox', 'uidValidity'], where: { mailAccountId: account.id }, _count: { _all: true },
    });
    const legacy = namespaces.filter((item) => current.get(item.mailbox)?.uidValidity !== item.uidValidity);
    const total = legacy.reduce((sum, item) => sum + item._count._all, 0);
    if (!total) return { readOnly: true, identityCheck: 'sha256-raw-mime', checkedAt: new Date(), legacyCount: 0, exactRawMatchCount: 0, noExactMatchCount: 0 };
    const remoteHashes = new Map<string, number>();
    for (const folder of folders) {
      const snapshot = await this.imap.listMailboxSourceHashes(account.id, folder);
      if (snapshot.uidValidity !== current.get(folder)?.uidValidity) throw unavailable('UIDVALIDITY_CHANGED');
      for (const [hash, count] of snapshot.hashes) remoteHashes.set(hash, (remoteHashes.get(hash) ?? 0) + count);
    }
    let exactRawMatchCount = 0;
    let noExactMatchCount = 0;
    let cursor: string | undefined;
    while (true) {
      const page = await this.prisma.emailMessage.findMany({
        where: { mailAccountId: account.id, OR: legacy.map((item) => ({ mailbox: item.mailbox, uidValidity: item.uidValidity })) },
        orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, rawSource: true },
      });
      if (!page.length) break;
      for (const message of page) {
        const hash = createHash('sha256').update(message.rawSource).digest('hex');
        const remaining = remoteHashes.get(hash) ?? 0;
        if (remaining > 0) {
          remoteHashes.set(hash, remaining - 1);
          exactRawMatchCount++;
        } else noExactMatchCount++;
      }
      cursor = page[page.length - 1].id;
    }
    if (exactRawMatchCount + noExactMatchCount !== total) throw unavailable('LEGACY_AUDIT_CHANGED_DURING_SCAN');
    return { readOnly: true, identityCheck: 'sha256-raw-mime', checkedAt: new Date(),
      legacyCount: total, exactRawMatchCount, noExactMatchCount };
  }

  private async schedulerLoop() {
    while (this.active) {
      try { await this.runIfDue(); }
      catch { this.logger.warn({ event: 'mail_deletion_sync.scheduler_failed' }, 'Mail deletion sync will retry'); }
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 60_000); timer.unref(); });
    }
  }

  private async runIfDue() {
    if (!this.config.get<boolean>('MAIL_DELETION_SYNC_ENABLED', true)) return;
    const account = await this.account();
    if (!account) return;
    const checkpoint = await this.prisma.mailDeletionSyncCheckpoint.upsert({
      where: { mailAccountId: account.id },
      create: { mailAccountId: account.id },
      update: {},
    });
    const now = new Date();
    if (checkpoint.nextRunAt > now || (checkpoint.leaseExpiresAt && checkpoint.leaseExpiresAt > now)) return;
    const leaseToken = randomUUID();
    const acquired = await this.prisma.mailDeletionSyncCheckpoint.updateMany({
      where: { id: checkpoint.id, nextRunAt: { lte: now }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { status: 'running', lastAttemptAt: now, lastErrorCode: null, leaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (!acquired.count) return;
    const heartbeat = setInterval(() => { void this.renewLease(checkpoint.id, leaseToken).catch(() => undefined); }, 60_000);
    try {
      const folders = this.configuredFolders();
      const checkpoints = await this.prisma.syncCheckpoint.findMany({
        where: { mailAccountId: account.id, mailbox: { in: folders } },
        select: { mailbox: true, uidValidity: true, status: true, lastErrorCode: true, reconciliationRequired: true },
      });
      if (checkpoints.length !== folders.length) throw new Error('FOLDER_SYNC_NOT_READY');
      const byFolder = new Map(checkpoints.map((entry) => [entry.mailbox, entry]));
      const snapshots = [] as Array<{ mailbox: string; uidValidity: bigint; uids: number[]; snapshotMaxUid: number }>;
      // Finish every remote inventory before deleting even one local row.
      for (const mailbox of folders) {
        const state = byFolder.get(mailbox);
        if (!state || state.status !== 'completed' || state.lastErrorCode || state.reconciliationRequired || state.uidValidity === null) {
          throw new Error('FOLDER_SYNC_NOT_READY');
        }
        const snapshot = await this.imap.listMailboxUidSnapshot(account.id, mailbox);
        if (snapshot.uidValidity !== state.uidValidity) throw new Error('UIDVALIDITY_CHANGED');
        snapshots.push({ mailbox, ...snapshot });
      }
      let scannedCount = 0;
      let deletedCount = 0;
      for (const snapshot of snapshots) {
        scannedCount += snapshot.uids.length;
        deletedCount += await this.cleanup.deleteMissing(
          account.id, snapshot.mailbox, snapshot.uidValidity, new Set(snapshot.uids), snapshot.snapshotMaxUid,
        );
      }
      const completedAt = new Date();
      const intervalHours = this.config.get<number>('MAIL_DELETION_SYNC_INTERVAL_HOURS', 4);
      await this.prisma.mailDeletionSyncCheckpoint.updateMany({
        where: { id: checkpoint.id, leaseToken },
        data: {
          status: 'completed', lastCompletedAt: completedAt,
          nextRunAt: new Date(completedAt.getTime() + intervalHours * 60 * 60_000),
          scannedCount, deletedCount, lastErrorCode: null, leaseToken: null, leaseExpiresAt: null,
        },
      });
      this.logger.info({ event: 'mail_deletion_sync.completed', scannedCount, deletedCount }, 'Remote mailbox deletion sync completed');
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'MAIL_DELETION_SYNC_FAILED';
      await this.prisma.mailDeletionSyncCheckpoint.updateMany({
        where: { id: checkpoint.id, leaseToken },
        data: { status: 'failed', lastErrorCode: code, nextRunAt: new Date(Date.now() + RETRY_MS), leaseToken: null, leaseExpiresAt: null },
      });
      this.logger.warn({ event: 'mail_deletion_sync.failed', code }, 'Remote mailbox deletion sync failed; no more rows will be deleted in this run');
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async renewLease(id: string, leaseToken: string) {
    await this.prisma.mailDeletionSyncCheckpoint.updateMany({
      where: { id, leaseToken }, data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    });
  }

  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) return null;
    return this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true } });
  }

  private configuredFolders() {
    return [...new Set(this.config.get<string>('IMAP_SYNC_FOLDERS', 'INBOX').split(',').map((folder) => folder.trim()).filter(Boolean))];
  }
}
