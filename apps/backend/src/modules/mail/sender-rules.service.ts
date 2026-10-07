import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { domainToASCII } from 'node:url';
import { PrismaService } from '../../database/prisma.service';
import { executeAuditedMutation } from './business-operation';

export type SenderRuleAction = 'blacklist' | 'whitelist';
export type SenderRuleMatchType = 'address' | 'domain';
export type SenderRuleSnapshot = {
  version: 1;
  evaluatedAt: string;
  action: SenderRuleAction | 'none';
  matchedRule: null | { id: string; action: SenderRuleAction; matchType: SenderRuleMatchType; pattern: string };
  matchingRules: Array<{ id: string; action: SenderRuleAction; matchType: SenderRuleMatchType; pattern: string }>;
};

type RuleClient = Prisma.TransactionClient | PrismaService;
type RuleView = {
  id: string;
  action: string;
  matchType: string;
  pattern: string;
  actorId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

@Injectable()
export class SenderRulesService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async list() {
    const account = await this.account();
    const rules = await this.prisma.senderRule.findMany({
      where: { mailAccountId: account.id, deletedAt: null },
      orderBy: [{ action: 'asc' }, { matchType: 'asc' }, { pattern: 'asc' }],
      select: { id: true, action: true, matchType: true, pattern: true, actorId: true, createdAt: true, updatedAt: true, deletedAt: true },
    });
    return { rules };
  }

  async upsert(input: unknown) {
    const body = this.body(input, ['action', 'matchType', 'pattern', 'actorId', 'operationId']);
    const action = this.enumValue(body.action, 'action', ['blacklist', 'whitelist']) as SenderRuleAction;
    const matchType = this.enumValue(body.matchType, 'matchType', ['address', 'domain']) as SenderRuleMatchType;
    const pattern = this.normalizePattern(body.pattern, matchType);
    const actorId = this.requiredText(body.actorId, 'actorId', 160);
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const account = await this.account();
    const where = { mailAccountId_matchType_pattern: { mailAccountId: account.id, matchType, pattern } };

    return executeAuditedMutation(this.prisma, {
      operationId,
      actorId,
      entityType: 'sender_rule',
      action: 'upsert',
      input: { mailAccountId: account.id, action, matchType, pattern, actorId },
      execute: async (tx) => {
        const before = await tx.senderRule.findUnique({ where, select: { id: true, action: true, matchType: true, pattern: true, actorId: true, createdAt: true, updatedAt: true, deletedAt: true } });
        const saved = await tx.senderRule.upsert({
          where,
          create: { mailAccountId: account.id, action, matchType, pattern, actorId },
          update: { action, actorId, deletedAt: null },
        });
        return { entityId: saved.id, value: this.view(saved), before, after: saved };
      },
      load: async (client, id) => {
        const rule = await client.senderRule.findFirst({ where: { id, mailAccountId: account.id } });
        if (!rule) throw new NotFoundException('Sender rule not found');
        return this.view(rule);
      },
    });
  }

  async remove(idInput: unknown, input: unknown) {
    const id = this.requiredText(idInput, 'id', 100);
    const body = this.body(input, ['actorId', 'operationId']);
    const actorId = this.requiredText(body.actorId, 'actorId', 160);
    const operationId = this.requiredText(body.operationId, 'operationId', 200);
    const account = await this.account();
    return executeAuditedMutation(this.prisma, {
      operationId,
      actorId,
      entityType: 'sender_rule',
      action: 'delete',
      input: { mailAccountId: account.id, id, actorId },
      execute: async (tx) => {
        const before = await tx.senderRule.findFirst({ where: { id, mailAccountId: account.id } });
        if (!before) throw new NotFoundException('Sender rule not found');
        const saved = before.deletedAt ? before : await tx.senderRule.update({ where: { id }, data: { deletedAt: new Date(), actorId } });
        return { entityId: saved.id, value: this.view(saved), before, after: saved };
      },
      load: async (client, ruleId) => {
        const rule = await client.senderRule.findFirst({ where: { id: ruleId, mailAccountId: account.id } });
        if (!rule) throw new NotFoundException('Sender rule not found');
        return this.view(rule);
      },
    });
  }

  async snapshotForNewMessage(client: RuleClient, mailAccountId: string, fromJson: unknown): Promise<SenderRuleSnapshot> {
    const addresses = this.senderAddresses(fromJson);
    const domains = new Set([...addresses].map((address) => address.slice(address.lastIndexOf('@') + 1)));
    const rules = await client.senderRule.findMany({
      where: { mailAccountId, deletedAt: null },
      select: { id: true, action: true, matchType: true, pattern: true },
    });
    const matches = rules.filter((rule) => {
      if (rule.matchType === 'address') return addresses.has(rule.pattern);
      if (rule.matchType === 'domain') return domains.has(rule.pattern);
      return false;
    }).filter((rule): rule is typeof rule & { action: SenderRuleAction; matchType: SenderRuleMatchType } =>
      ['blacklist', 'whitelist'].includes(rule.action) && ['address', 'domain'].includes(rule.matchType),
    ).sort((left, right) => {
      const actionOrder = (left.action === 'blacklist' ? 0 : 1) - (right.action === 'blacklist' ? 0 : 1);
      if (actionOrder) return actionOrder;
      const typeOrder = (left.matchType === 'address' ? 0 : 1) - (right.matchType === 'address' ? 0 : 1);
      return typeOrder || left.pattern.localeCompare(right.pattern) || left.id.localeCompare(right.id);
    });
    const matchingRules = matches.map(({ id, action, matchType, pattern }) => ({ id, action, matchType, pattern }));
    const winner = matchingRules[0] ?? null;
    return {
      version: 1,
      evaluatedAt: new Date().toISOString(),
      action: winner?.action ?? 'none',
      matchedRule: winner,
      matchingRules,
    };
  }

  private senderAddresses(fromJson: unknown): Set<string> {
    const values = Array.isArray(fromJson) ? fromJson : [fromJson];
    const addresses = new Set<string>();
    for (const value of values) {
      if (!value || typeof value !== 'object' || !('address' in value) || typeof value.address !== 'string') continue;
      const normalized = this.normalizeAddress(value.address);
      if (normalized) addresses.add(normalized);
    }
    return addresses;
  }

  private normalizePattern(value: unknown, matchType: SenderRuleMatchType): string {
    const raw = this.requiredText(value, 'pattern', 320);
    if (/[?*]/.test(raw)) throw new BadRequestException('Wildcard sender rules are not supported');
    if (matchType === 'address') {
      const address = this.normalizeAddress(raw);
      if (!address) throw new BadRequestException('pattern must be a valid exact email address');
      return address;
    }
    const domain = this.normalizeDomain(raw);
    if (!domain) throw new BadRequestException('pattern must be a valid exact domain');
    return domain;
  }

  private normalizeAddress(value: string): string | null {
    const address = value.trim().toLowerCase();
    const at = address.lastIndexOf('@');
    if (at <= 0 || at !== address.indexOf('@')) return null;
    const local = address.slice(0, at);
    if (local.length > 64 || !/^[a-z0-9.!#$%&'+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
    const domain = this.normalizeDomain(address.slice(at + 1));
    return domain ? `${local}@${domain}` : null;
  }

  private normalizeDomain(value: string): string | null {
    const ascii = domainToASCII(value.trim().replace(/\.$/, '').toLowerCase()).toLowerCase();
    if (!ascii || ascii.length > 253 || ascii.includes('*')) return null;
    const labels = ascii.split('.');
    if (labels.length < 2 || labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
    return ascii;
  }

  private body(value: unknown, allowed: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Request body must be an object');
    const body = value as Record<string, unknown>;
    for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new BadRequestException(`Unsupported field ${key}`);
    return body;
  }

  private enumValue(value: unknown, name: string, allowed: string[]): string {
    if (typeof value !== 'string' || !allowed.includes(value)) throw new BadRequestException(`${name} is invalid`);
    return value;
  }

  private requiredText(value: unknown, name: string, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new BadRequestException(`${name} is invalid`);
    return value.trim();
  }

  private view(rule: RuleView) {
    return {
      id: rule.id, action: rule.action, matchType: rule.matchType, pattern: rule.pattern,
      actorId: rule.actorId, createdAt: rule.createdAt, updatedAt: rule.updatedAt, deletedAt: rule.deletedAt,
    };
  }

  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) {
      throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED', message: 'IMAP is not configured' });
    }
    const account = await this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY', message: 'IMAP account configuration is not ready' });
    return account;
  }
}
