import {
  BadRequestException,
  Injectable,
  HttpException,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ImapFlow, type FetchMessageObject, type SearchObject } from 'imapflow';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../database/prisma.service';
import { decryptCredential, encryptCredential } from './credential-cipher';
import { buildUidSearchRange } from './sync-cursor.policy';

type AccountConfig = {
  email: string;
  host: string;
  port: number;
  tlsMode: 'implicit' | 'starttls';
  username: string;
  password: string;
  mailbox: string;
  encryptionKey: string;
};

type StoredAccount = {
  id: string;
  email: string;
  host: string;
  port: number;
  tlsMode: string;
  username: string;
  passwordCiphertext: string;
  mailbox: string;
};

@Injectable()
export class ImapMailService implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @InjectPinoLogger(ImapMailService.name)
    private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    const config = this.readConfig();
    if (!config) return;

    const passwordCiphertext = encryptCredential(config.password, config.encryptionKey);
    await this.prisma.mailAccount.upsert({
      where: { email: config.email },
      create: {
        email: config.email,
        host: config.host,
        port: config.port,
        tlsMode: config.tlsMode,
        username: config.username,
        passwordCiphertext,
        mailbox: config.mailbox,
        status: 'disconnected',
      },
      update: {
        host: config.host,
        port: config.port,
        tlsMode: config.tlsMode,
        username: config.username,
        passwordCiphertext,
        mailbox: config.mailbox,
        status: 'disconnected',
        lastErrorCode: null,
      },
    });
    this.logger.info({ event: 'imap.account_configured' }, 'IMAP account configured');
  }

  async status(): Promise<Record<string, unknown>> {
    const config = this.readConfig();
    if (!config) {
      return { configured: false, status: 'not_configured' };
    }
    const account = await this.prisma.mailAccount.findUnique({
      where: { email: config.email },
      select: {
        email: true,
        provider: true,
        status: true,
        lastErrorCode: true,
        lastConnectedAt: true,
        mailbox: true,
      },
    });
    return { configured: true, account };
  }

  async getMessage(uid: number, mailbox?: string) {
    const selectedMailbox = mailbox ?? this.config.get<string>('IMAP_MAILBOX', 'INBOX');
    return this.withClient(async (client, account) => {
      const lock = await client.getMailboxLock(selectedMailbox, { readOnly: true });
      try {
        const message = await client.fetchOne(
          uid,
          { uid: true, envelope: true, source: true, internalDate: true },
          { uid: true },
        );
        if (!message) throw new NotFoundException('IMAP message not found');
        return this.toMessage(message, account.email, selectedMailbox);
      } finally {
        lock.release();
      }
    });
  }

  async getThread(threadId: string, mailbox?: string) {
    const normalizedId = threadId.trim();
    if (!normalizedId || normalizedId.length > 998 || /[\r\n]/.test(normalizedId)) {
      throw new BadRequestException('Invalid IMAP thread identifier');
    }
    const selectedMailbox = mailbox ?? this.config.get<string>('IMAP_MAILBOX', 'INBOX');
    return this.withClient(async (client, account) => {
      const lock = await client.getMailboxLock(selectedMailbox, { readOnly: true });
      try {
        const queries: SearchObject[] = [
          { header: { References: normalizedId } },
          { header: { 'In-Reply-To': normalizedId } },
          { header: { 'Message-ID': normalizedId } },
        ];
        const uidSet = new Set<number>();
        for (const query of queries) {
          const matches = await client.search(query, { uid: true });
          if (Array.isArray(matches)) {
            for (const uid of matches) uidSet.add(uid);
          }
        }
        const uids = [...uidSet].sort((a, b) => a - b).slice(-100);
        if (uids.length === 0) return { threadId: normalizedId, messages: [] };
        const messages = await client.fetchAll(
          uids.join(','),
          { uid: true, envelope: true, source: true, internalDate: true },
          { uid: true },
        );
        return {
          threadId: normalizedId,
          messages: messages.map((message) => this.toMessage(message, account.email, selectedMailbox)),
        };
      } finally {
        lock.release();
      }
    });
  }

  async fetchPage(
    mailbox: string,
    fromDate: Date,
    throughDate: Date,
    afterUid: number,
    pageSize: number,
    targetUid?: number | null,
  ) {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const mailboxState = client.mailbox;
        if (!mailboxState) throw new Error('IMAP mailbox is not selected');
        const snapshotUid = targetUid ?? Math.max(0, mailboxState.uidNext - 1);
        const snapshotThroughDate = targetUid === undefined || targetUid === null ? new Date() : throughDate;
        const beforeInclusive = new Date(snapshotThroughDate);
        beforeInclusive.setUTCDate(beforeInclusive.getUTCDate() + 1);
        const uidRange = buildUidSearchRange(afterUid, snapshotUid);
        const found = uidRange
          ? await client.search({
              since: fromDate,
              before: beforeInclusive,
              uid: uidRange,
            }, { uid: true })
          : [];
        const allUids = Array.isArray(found) ? found.sort((a, b) => a - b) : [];
        const selectedUids = allUids.slice(0, pageSize + 1);
        const hasMore = selectedUids.length > pageSize;
        const pageUids = selectedUids.slice(0, pageSize);
        if (pageUids.length === 0) {
          return {
            uidValidity: mailboxState.uidValidity,
            messages: [],
            nextUid: afterUid,
            targetUid: snapshotUid,
            throughDate: snapshotThroughDate,
            hasMore: false,
          };
        }
        const messages = await client.fetchAll(
          pageUids.join(','),
          { uid: true, source: true, internalDate: true },
          { uid: true },
        );
        return {
          uidValidity: mailboxState.uidValidity,
          messages: messages.map((message) => ({
            uid: message.uid,
            receivedAt: message.internalDate ? new Date(message.internalDate) : null,
            rawSourceBase64: message.source?.toString('base64') ?? '',
          })),
          nextUid: pageUids.at(-1) ?? afterUid,
          targetUid: snapshotUid,
          throughDate: snapshotThroughDate,
          hasMore,
        };
      } finally {
        lock.release();
      }
    });
  }

  async fetchIncrementalPage(
    accountId: string,
    mailbox: string,
    afterUid: number,
    pageSize: number,
    range?: { fromDate: Date; throughDate: Date },
    targetUid?: number | null,
  ) {
    return this.withStoredAccountClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const mailboxState = client.mailbox;
        if (!mailboxState) throw new Error('IMAP mailbox is not selected');
        const snapshotUid = targetUid ?? Math.max(0, mailboxState.uidNext - 1);
        const snapshotThroughDate = range?.throughDate ?? new Date();
        const uidRange = buildUidSearchRange(afterUid, snapshotUid);
        const found = uidRange
          ? await client.search({
              uid: uidRange,
              ...(range ? {
                since: range.fromDate,
                before: new Date(range.throughDate.getTime() + 24 * 60 * 60 * 1000),
              } : {}),
            }, { uid: true })
          : [];
        const allUids = Array.isArray(found) ? found.sort((a, b) => a - b) : [];
        const pageUids = allUids.slice(0, pageSize);
        const messages = pageUids.length
          ? await client.fetchAll(pageUids.join(','), { uid: true, source: true, internalDate: true }, { uid: true })
          : [];
        return {
          uidValidity: mailboxState.uidValidity,
          messages: messages.map((message) => ({
            uid: message.uid,
            receivedAt: message.internalDate ? new Date(message.internalDate) : null,
            rawSource: message.source ?? Buffer.alloc(0),
          })),
          nextUid: pageUids.at(-1) ?? afterUid,
          targetUid: snapshotUid,
          throughDate: snapshotThroughDate,
          hasMore: allUids.length > pageSize,
        };
      } finally {
        lock.release();
      }
    });
  }

  async listMailboxUidSnapshot(accountId: string, mailbox: string): Promise<{
    uidValidity: bigint;
    snapshotMaxUid: number;
    uids: number[];
  }> {
    return this.withStoredAccountClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const mailboxState = client.mailbox;
        if (!mailboxState) throw new Error('IMAP mailbox is not selected');
        if (mailboxState.uidValidity === null || mailboxState.uidValidity === undefined) {
          throw new Error('IMAP did not return UIDVALIDITY');
        }
        if (!Number.isSafeInteger(mailboxState.uidNext) || mailboxState.uidNext < 1) {
          throw new Error('IMAP did not return a valid UIDNEXT');
        }
        const snapshotMaxUid = mailboxState.uidNext - 1;

        // Search the full folder without a date limit, while treating messages
        // marked \Deleted but not yet expunged as absent from the user's mailbox.
        const found = mailboxState.exists === 0
          ? []
          : await client.search({ all: true, deleted: false }, { uid: true });
        if (!Array.isArray(found)) {
          throw new Error('IMAP did not return a complete UID snapshot');
        }
        if (found.some((uid) => !Number.isSafeInteger(uid) || uid < 1)) {
          throw new Error('IMAP returned an invalid UID');
        }
        return {
          uidValidity: mailboxState.uidValidity,
          snapshotMaxUid,
          uids: found.filter((uid) => uid <= snapshotMaxUid).sort((a, b) => a - b),
        };
      } finally {
        lock.release();
      }
    });
  }

  async listMailboxSourceHashes(accountId: string, mailbox: string): Promise<{ uidValidity: bigint; hashes: Map<string, number>; scannedCount: number }> {
    return this.withStoredAccountClient(accountId, async (client) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const state = client.mailbox;
        if (!state || state.uidValidity == null || !Number.isSafeInteger(state.uidNext) || state.uidNext < 1) throw new Error('INVALID_IMAP_SNAPSHOT');
        const uidValidity = state.uidValidity;
        const uidNext = state.uidNext;
        const found = state.exists === 0 ? [] : await client.search({ all: true, deleted: false }, { uid: true });
        if (!Array.isArray(found) || found.some((uid) => !Number.isSafeInteger(uid) || uid < 1 || uid >= uidNext)) throw new Error('INVALID_IMAP_SNAPSHOT');
        const uids = [...found].sort((a, b) => a - b);
        if (new Set(uids).size !== uids.length) throw new Error('INVALID_IMAP_SNAPSHOT');
        const hashes = new Map<string, number>();
        const seen = new Set<number>();
        for (let start = 0; start < uids.length; start += 50) {
          const batch = uids.slice(start, start + 50);
          const messages = await client.fetchAll(batch.join(','), { uid: true, source: true }, { uid: true });
          const expected = new Set(batch);
          for (const message of messages) {
            if (!expected.has(message.uid) || seen.has(message.uid) || !message.source) throw new Error('INCOMPLETE_IMAP_SNAPSHOT');
            seen.add(message.uid);
            const hash = createHash('sha256').update(message.source).digest('hex');
            hashes.set(hash, (hashes.get(hash) ?? 0) + 1);
          }
          if (batch.some((uid) => !seen.has(uid))) throw new Error('INCOMPLETE_IMAP_SNAPSHOT');
        }
        const latest = client.mailbox;
        const after = latest && latest.exists === 0 ? [] : await client.search({ all: true, deleted: false }, { uid: true });
        if (!latest || latest.uidValidity !== uidValidity || latest.uidNext !== uidNext || !Array.isArray(after) ||
          after.length !== uids.length || after.sort((a, b) => a - b).some((uid, index) => uid !== uids[index])) throw new Error('MAILBOX_CHANGED_DURING_AUDIT');
        return { uidValidity, hashes, scannedCount: uids.length };
      } finally { lock.release(); }
    });
  }

  private async withClient<T>(
    operation: (client: ImapFlow, account: StoredAccount) => Promise<T>,
  ): Promise<T> {
    const config = this.readConfig();
    if (!config) {
      throw new ServiceUnavailableException({
        code: 'IMAP_NOT_CONFIGURED',
        message: 'IMAP is not configured',
      });
    }
    const account = await this.prisma.mailAccount.findUnique({ where: { email: config.email } });
    if (!account) {
      throw new ServiceUnavailableException({
        code: 'IMAP_ACCOUNT_NOT_READY',
        message: 'IMAP account configuration is not ready',
      });
    }
    return this.connectAndRun(account, config.encryptionKey, operation);
  }

  private async withStoredAccountClient<T>(
    accountId: string,
    operation: (client: ImapFlow, account: StoredAccount) => Promise<T>,
  ): Promise<T> {
    const encryptionKey = this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY');
    if (!encryptionKey) {
      throw new ServiceUnavailableException({
        code: 'CREDENTIAL_ENCRYPTION_KEY_NOT_CONFIGURED',
        message: 'Worker credential decryption key is not configured',
      });
    }
    const account = await this.prisma.mailAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new ServiceUnavailableException({
        code: 'IMAP_ACCOUNT_NOT_READY',
        message: 'IMAP account configuration is not ready',
      });
    }
    return this.connectAndRun(account, encryptionKey, operation);
  }

  private async connectAndRun<T>(
    account: StoredAccount,
    encryptionKey: string,
    operation: (client: ImapFlow, account: StoredAccount) => Promise<T>,
  ): Promise<T> {
    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.tlsMode === 'implicit',
      doSTARTTLS: account.tlsMode === 'starttls',
      tls: { rejectUnauthorized: true },
      auth: {
        user: account.username,
        pass: decryptCredential(account.passwordCiphertext, encryptionKey),
      },
      logger: false,
      disableAutoIdle: true,
    });
    try {
      await client.connect();
      const result = await operation(client, account);
      await this.prisma.mailAccount.update({
        where: { id: account.id },
        data: { status: 'connected', lastErrorCode: null, lastConnectedAt: new Date() },
      });
      return result;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        throw error;
      }
      const code = this.safeErrorCode(error);
      try {
        await this.prisma.mailAccount.update({
          where: { id: account.id },
          data: {
            status: code === 'AUTHENTICATION_FAILED' ? 'reconnect_required' : 'disconnected',
            lastErrorCode: code,
          },
        });
      } catch {
        this.logger.error({ event: 'imap.status_update_failed', code }, 'Could not persist IMAP status');
      }
      this.logger.warn({ event: 'imap.operation_failed', code }, 'IMAP operation failed');
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({
        code,
        message:
          code === 'AUTHENTICATION_FAILED'
            ? 'IMAP authentication failed; reconnect with valid credentials'
            : code === 'SERVER_UNREACHABLE'
              ? 'IMAP server is unreachable; retry after checking its address and TLS settings'
              : 'IMAP operation failed; check the account connection status',
      });
    } finally {
      if (client.usable) {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      }
    }
  }

  private readConfig(): AccountConfig | null {
    const email = this.config.get<string>('IMAP_EMAIL');
    const host = this.config.get<string>('IMAP_HOST');
    const username = this.config.get<string>('IMAP_USERNAME');
    const password = this.config.get<string>('IMAP_PASSWORD');
    const encryptionKey = this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY');
    if (!email || !host || !username || !password || !encryptionKey) return null;
    return {
      email,
      host,
      username,
      password,
      encryptionKey,
      port: this.config.get<number>('IMAP_PORT', 993),
      tlsMode: this.config.get<'implicit' | 'starttls'>('IMAP_TLS_MODE', 'implicit'),
      mailbox: this.config.get<string>('IMAP_MAILBOX', 'INBOX'),
    };
  }

  private safeErrorCode(error: unknown): string {
    const value = error as { code?: unknown; response?: { status?: unknown; text?: unknown }; message?: unknown };
    const combined = [value?.code, value?.response?.status, value?.response?.text, value?.message]
      .filter((part) => typeof part === 'string')
      .join(' ')
      .toUpperCase();
    if (/AUTHENTICATIONFAILED|AUTHENTICATION FAILED|INVALID CREDENTIAL|AUTHENTICATE FAILED/.test(combined)) {
      return 'AUTHENTICATION_FAILED';
    }
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|TLS/.test(combined)) {
      return 'SERVER_UNREACHABLE';
    }
    return 'IMAP_OPERATION_FAILED';
  }

  private toMessage(message: FetchMessageObject, email: string, mailbox: string) {
    const source = message.source?.toString('utf8') ?? '';
    const references = this.header(source, 'References');
    const inReplyTo = this.header(source, 'In-Reply-To');
    const messageId = message.envelope?.messageId ?? this.header(source, 'Message-ID');
    const threadId = references?.match(/<[^>]+>/)?.[0] ?? inReplyTo?.match(/<[^>]+>/)?.[0] ?? messageId ?? `imap:${email}:${message.uid}`;
    return {
      uid: message.uid,
      mailbox,
      threadId,
      messageId,
      inReplyTo,
      references,
      date: message.internalDate ?? message.envelope?.date ?? null,
      envelope: message.envelope,
      rawSource: source,
    };
  }

  private header(source: string, name: string): string | undefined {
    const match = source.match(new RegExp(`^${name}:([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im'));
    return match?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim();
  }
}
