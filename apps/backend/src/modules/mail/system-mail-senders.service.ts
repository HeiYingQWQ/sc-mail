import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { domainToASCII } from 'node:url';
import { PrismaService } from '../../database/prisma.service';
import { executeAuditedMutation } from './business-operation';

type SenderClient = Prisma.TransactionClient | PrismaService;
type SystemMailSenderView = { id: string; email: string; createdAt: Date; updatedAt: Date };
type DeletedSystemMailSender = { id: string; email: string; deleted: true };

export const DEFAULT_SYSTEM_MAIL_SENDERS = [
  'mailer-daemon@googlemail.com',
  'mailer-daemon@zmail.tsnet.it',
  'mailer-daemon@mail.ni8.com',
] as const;

@Injectable()
export class SystemMailSendersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const senders = await this.prisma.systemMailSender.findMany({ orderBy: [{ email: 'asc' }, { id: 'asc' }] });
    return { senders, total: senders.length };
  }

  async systemSenderAddresses(client: SenderClient = this.prisma): Promise<string[]> {
    const rows = await client.systemMailSender.findMany({ orderBy: { email: 'asc' }, select: { email: true } });
    return rows.map((row) => row.email);
  }

  async matchSystemSenderAddresses(addresses: string[], client: SenderClient = this.prisma): Promise<string[]> {
    const normalized = [...new Set(addresses.map((address) => this.normalizeForMatch(address)).filter(Boolean))];
    if (!normalized.length) return [];
    const rows = await client.systemMailSender.findMany({ where: { email: { in: normalized } }, select: { email: true }, orderBy: { email: 'asc' } });
    return rows.map((row) => row.email);
  }

  async isSystemSenderAddress(address: string, client: SenderClient = this.prisma): Promise<boolean> {
    return (await this.matchSystemSenderAddresses([address], client)).length > 0;
  }

  async upsert(input: unknown) {
    const body = this.body(input, ['email', 'operationId', 'actorId']);
    const email = this.normalizeEmail(body.email);
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const actorId = this.optionalText(body.actorId, 'actorId', 160);
    try {
      return await executeAuditedMutation<SystemMailSenderView>(this.prisma, {
      operationId,
      actorId,
      entityType: 'system_mail_sender',
      action: 'upsert',
      input: { email },
      execute: async (tx) => {
        const before = await tx.systemMailSender.findUnique({ where: { email } });
        const sender = await tx.systemMailSender.upsert({ where: { email }, create: { email }, update: { email } });
        const value = this.view(sender);
        return { entityId: sender.id, value, before, after: value };
      },
      load: async (client) => this.operationResult<SystemMailSenderView>(client, operationId),
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException({ code: 'SYSTEM_MAIL_SENDER_EMAIL_CONFLICT', message: 'A system sender with this email already exists' });
      }
      throw error;
    }
  }

  async remove(idInput: unknown, input: unknown) {
    const id = this.requiredText(idInput, 'id', 100);
    const body = this.body(input, ['operationId', 'actorId']);
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const actorId = this.optionalText(body.actorId, 'actorId', 160);
    return executeAuditedMutation<DeletedSystemMailSender>(this.prisma, {
      operationId,
      actorId,
      entityType: 'system_mail_sender',
      action: 'delete',
      input: { id },
      execute: async (tx) => {
        const before = await tx.systemMailSender.findUnique({ where: { id } });
        if (!before) throw new NotFoundException({ code: 'SYSTEM_MAIL_SENDER_NOT_FOUND', message: 'System mail sender not found' });
        await tx.systemMailSender.delete({ where: { id } });
        const value = { id, email: before.email, deleted: true as const };
        return { entityId: id, value, before, after: value };
      },
      load: async (client) => this.operationResult<DeletedSystemMailSender>(client, operationId),
    });
  }

  private async operationResult<T>(client: SenderClient, operationId: string): Promise<T> {
    const operation = await client.businessOperation.findUnique({ where: { operationId }, select: { afterJson: true } });
    if (!operation) throw new NotFoundException('System sender operation audit not found');
    return operation.afterJson as T;
  }

  private view(sender: SystemMailSenderView): SystemMailSenderView {
    return { id: sender.id, email: sender.email, createdAt: sender.createdAt, updatedAt: sender.updatedAt };
  }

  private normalizeEmail(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException({ code: 'SYSTEM_MAIL_SENDER_INVALID_EMAIL', message: 'email must be a valid email address' });
    const email = value.trim().toLowerCase();
    const at = email.lastIndexOf('@');
    const local = email.slice(0, at);
    const domain = domainToASCII(email.slice(at + 1)).toLowerCase();
    const labels = domain.split('.');
    if (email.length > 320 || at < 1 || at !== email.indexOf('@') || local.length > 64 ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !domain || domain.length > 253 || labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      throw new BadRequestException({ code: 'SYSTEM_MAIL_SENDER_INVALID_EMAIL', message: 'email must be a valid email address' });
    }
    return `${local}@${domain}`;
  }

  private normalizeForMatch(value: string): string {
    if (typeof value !== 'string') return '';
    try { return this.normalizeEmail(value); } catch { return ''; }
  }

  private body(value: unknown, allowed: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Request body must be an object');
    const body = value as Record<string, unknown>;
    for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new BadRequestException(`Unsupported field ${key}`);
    return body;
  }

  private requiredText(value: unknown, name: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new BadRequestException(`${name} is required and must be at most ${maxLength} characters`);
    return value.trim();
  }

  private optionalText(value: unknown, name: string, maxLength: number): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return this.requiredText(value, name, maxLength);
  }
}
