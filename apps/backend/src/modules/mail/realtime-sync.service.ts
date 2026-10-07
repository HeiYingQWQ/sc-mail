import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBoss, type Job } from 'pg-boss';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../database/prisma.service';
import { ImapMailService } from './imap-mail.service';
import { InitialSyncService, SyncCheckpointChangedError } from './initial-sync.service';
import { nextCheckpointUid, uidValidityChanged } from './sync-cursor.policy';
import { MailDeletionSyncService } from './mail-deletion-sync.service';

const QUEUE = 'mailbox-incremental-sync';
const MAX_PAGES_PER_JOB = 20;

@Injectable()
export class RealtimeSyncService implements OnModuleInit, OnModuleDestroy {
  private boss: PgBoss | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly imap: ImapMailService,
    private readonly initialSync: InitialSyncService,
    private readonly deletionSync: MailDeletionSyncService,
    @InjectPinoLogger(RealtimeSyncService.name)
    private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString) return;
    this.boss = new PgBoss(connectionString);
    this.boss.on('error', () => {
      this.logger.error({ event: 'mail_sync_queue.error' }, 'Persistent mail sync queue error');
    });
    this.boss.on('warning', (warning) => {
      this.logger.warn({ event: 'mail_sync_queue.warning' }, 'Persistent mail sync queue warning');
    });
    await this.boss.start();
    await this.boss.createQueue(QUEUE, {
      policy: 'exclusive',
      retryLimit: 8,
      retryDelay: 15,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 900,
      heartbeatSeconds: 60,
      retentionSeconds: 14 * 24 * 3600,
      deleteAfterSeconds: 7 * 24 * 3600,
    });

    if (this.config.get<string>('APP_ROLE', 'backend') !== 'worker') return;
    if (!this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY')) {
      this.logger.info({ event: 'mail_sync_worker.disabled' }, 'Mail sync worker requires the credential encryption key');
      return;
    }
    const intervalSeconds = this.config.get<number>('IMAP_POLL_INTERVAL_SECONDS', 60);
    const intervalMinutes = Math.max(1, Math.round(intervalSeconds / 60));
    await this.boss.work(QUEUE, { batchSize: 1, teamSize: 1, teamConcurrency: 1 }, (jobs: Job<unknown>[]) => this.handleJobs(jobs));
    await this.boss.schedule(
      QUEUE,
      `RRULE:FREQ=MINUTELY;INTERVAL=${intervalMinutes}`,
      { source: 'periodic-poll' },
      {
        tz: 'UTC',
        missed: 'once',
        singletonKey: 'mailbox-poll',
        singletonSeconds: intervalSeconds,
        singletonNextSlot: true,
      },
    );
    await this.boss.send(QUEUE, { source: 'worker-startup' }, {
      singletonKey: 'mailbox-poll',
      singletonSeconds: intervalSeconds,
      singletonNextSlot: true,
    });
    this.logger.info({ event: 'mail_sync_worker.ready', intervalSeconds }, 'Periodic IMAP sync worker ready');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.boss) await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  async status() {
    const host = this.config.get<string>('IMAP_HOST');
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!host || !email) return { configured: false, status: 'not_configured', folders: [] };
    const account = await this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!account) return { configured: false, status: 'account_not_ready', folders: [] };
    const folders = await this.prisma.syncCheckpoint.findMany({
      where: { mailAccountId: account.id, mailbox: { in: this.configuredFolders() } },
      orderBy: { mailbox: 'asc' },
      select: {
        mailbox: true, uidValidity: true, lastUid: true, status: true,
        fromDate: true, throughDate: true, lastPolledAt: true,
        lastSuccessfulSyncAt: true, lastErrorCode: true,
        reconciliationRequired: true, scannedCount: true, importedCount: true,
      },
    });
    const stats = this.boss ? (await this.boss.getQueueStats(QUEUE))[0] : undefined;
    return {
      configured: true,
      workerConfigured: Boolean(this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY')),
      pollIntervalSeconds: this.config.get<number>('IMAP_POLL_INTERVAL_SECONDS', 60),
      queue: stats ? {
        queued: stats.queuedCount,
        ready: stats.readyCount,
        active: stats.activeCount,
        failed: stats.failedCount,
      } : null,
      deletionSync: await this.deletionSync.status(),
      folders: folders.map((folder) => ({ ...folder, uidValidity: folder.uidValidity?.toString() ?? null })),
    };
  }

  private async handleJobs(jobs: Job<unknown>[]): Promise<void> {
    for (const job of jobs) {
      let failure: unknown;
      try { await this.syncConfiguredFolders(); }
      catch (error) { failure = error; }
      if (failure) throw new Error('Incremental mail sync failed');
    }
  }

  private async syncConfiguredFolders(): Promise<void> {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email) return;
    const account = await this.prisma.mailAccount.findUnique({
      where: { email },
      select: { id: true, email: true },
    });
    if (!account) return;
    const checkpoints = await this.prisma.syncCheckpoint.findMany({
      where: { mailAccountId: account.id, status: { in: ['completed', 'pending', 'failed', 'interrupted', 'in_progress'] }, mailbox: { in: this.configuredFolders() } },
      orderBy: { mailbox: 'asc' },
      select: { id: true, mailbox: true, status: true },
    });
    let failedFolders = 0;
    for (const checkpoint of checkpoints) {
      try {
        if (checkpoint.status === 'completed') {
          await this.syncFolder(account.id, account.email, checkpoint.id, checkpoint.mailbox);
        } else {
          await this.initialSync.resumeFolder(account.id, account.email, checkpoint.id, checkpoint.mailbox, MAX_PAGES_PER_JOB);
        }
      } catch (error) {
        if (error instanceof SyncCheckpointChangedError) continue;
        failedFolders += 1;
        if (checkpoint.status === 'completed') {
          await this.prisma.syncCheckpoint.updateMany({
            where: { id: checkpoint.id, status: 'completed' },
            data: { lastPolledAt: new Date(), lastErrorCode: 'INCREMENTAL_SYNC_FAILED' },
          }).catch(() => undefined);
        }
        this.logger.warn(
          { event: 'imap.incremental.folder_failed', mailbox: checkpoint.mailbox },
          'Incremental IMAP sync failed; the next queue retry resumes from the saved UID',
        );
      }
    }
    if (failedFolders) throw new Error(`${failedFolders} IMAP folder(s) failed; other folders were still processed`);
  }

  private async syncFolder(accountId: string, accountEmail: string, checkpointId: string, mailbox: string): Promise<void> {
    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_JOB; pageNumber += 1) {
      const checkpoint = await this.prisma.syncCheckpoint.findUniqueOrThrow({ where: { id: checkpointId } });
      if (checkpoint.status !== 'completed') return;
      const page = await this.imap.fetchIncrementalPage(
        accountId,
        mailbox,
        checkpoint.lastUid,
        this.config.get<number>('IMAP_SYNC_PAGE_SIZE', 25),
        checkpoint.reconciliationRequired ? { fromDate: checkpoint.fromDate, throughDate: checkpoint.throughDate } : undefined,
        checkpoint.reconciliationRequired ? checkpoint.targetUid : undefined,
      );
      if (uidValidityChanged(checkpoint.uidValidity, page.uidValidity)) {
        const now = new Date();
        const reset = await this.prisma.syncCheckpoint.updateMany({
          where: { id: checkpoint.id, status: 'completed', updatedAt: checkpoint.updatedAt },
          data: {
            updatedAt: new Date(Math.max(now.getTime(), checkpoint.updatedAt.getTime() + 1)),
            uidValidity: page.uidValidity,
            lastUid: 0,
            fromDate: this.historyCutoff(now, this.config.get<number>('IMAP_SYNC_HISTORY_MONTHS', 12)),
            throughDate: page.throughDate,
            targetUid: page.targetUid,
            reconciliationRequired: true,
            lastErrorCode: null,
          },
        });
        if (!reset.count) return;
        continue;
      }
      if (page.uidValidity === null) throw new Error('IMAP did not return UIDVALIDITY');
      if (page.messages.length > 0) {
        await this.initialSync.persistPage({
          accountId,
          accountEmail,
          checkpointId,
          expectedCheckpointUpdatedAt: checkpoint.updatedAt,
          mailbox,
          uidValidity: page.uidValidity,
          messages: page.messages,
          nextUid: checkpoint.reconciliationRequired
            ? nextCheckpointUid(page.hasMore, page.nextUid, checkpoint.targetUid ?? page.targetUid)
            : page.nextUid,
          hasMore: page.hasMore,
          incremental: true,
          emitAgentEvents: !checkpoint.reconciliationRequired,
          ...(checkpoint.reconciliationRequired ? {
            importanceTriageSource: 'uidvalidity_recovery' as const,
            importanceTriageCatchupCutoff: new Date(Date.now() - 24 * 60 * 60_000),
          } : {}),
          targetUid: checkpoint.targetUid,
          throughDate: checkpoint.throughDate,
          clearTargetUid: checkpoint.reconciliationRequired && !page.hasMore,
        });
      } else {
        const now = new Date();
        const saved = await this.prisma.syncCheckpoint.updateMany({
          where: { id: checkpointId, status: 'completed', updatedAt: checkpoint.updatedAt },
          data: {
            updatedAt: new Date(Math.max(now.getTime(), checkpoint.updatedAt.getTime() + 1)),
            uidValidity: page.uidValidity,
            lastUid: checkpoint.reconciliationRequired ? (checkpoint.targetUid ?? 0) : checkpoint.lastUid,
            lastPolledAt: now,
            lastSuccessfulSyncAt: now,
            lastErrorCode: null,
            reconciliationRequired: false,
            ...(checkpoint.reconciliationRequired ? { targetUid: null } : {}),
          },
        });
        if (!saved.count) return;
      }
      if (!page.hasMore) return;
    }
    // Bound one poll so a large backlog does not monopolize the worker; the next poll resumes by UID.
  }

  private configuredFolders(): string[] {
    const value = this.config.get<string>('IMAP_SYNC_FOLDERS', 'INBOX');
    return [...new Set(value.split(',').map((folder) => folder.trim()).filter(Boolean))];
  }

  private historyCutoff(now: Date, months: number): Date {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1, now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
    const days = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(now.getUTCDate(), days));
    return start;
  }
}
