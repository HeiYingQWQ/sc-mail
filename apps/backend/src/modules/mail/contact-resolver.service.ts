import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { normalizeEmail } from './contact-resolver.policy';
import { executeAuditedMutation } from './business-operation';
import { lockCrmRelationshipWrites } from './crm-relation-lock';
import { ProjectEmailAnalysisService } from './project-email-analysis.service';

type SenderAddress = { name?: unknown; address?: unknown };
type LegacyContactCleanupReport = {
  operationId: string;
  retiredCount: number;
  records: Array<{
    id: string;
    previousStatus: string;
    previousConfidence: number;
    previousReason: string | null;
    previousVersion: number;
    retiredVersion: number;
    emails: Array<{ email: string; isPrimary: boolean; verified: boolean }>;
  }>;
};

type ContactEmailSnapshot = { email: string; isPrimary: boolean; verified: boolean };
type EmailTakeoverAudit = {
  sourceContactId: string;
  retirementOperationId: string;
  sourceVersionBefore: number;
  sourceVersionAfter: number;
  selectedEmails: string[];
  sourceMappingsBefore: ContactEmailSnapshot[];
};
type ContactDeletionReceipt = { id: string; status: 'deleted'; version: number; deleted: true };
type CompanyDeletionReceipt = { id: string; status: 'deleted'; version: number; detachedContactIds: string[]; deleted: true };

type RetirementRecord = LegacyContactCleanupReport['records'][number];

@Injectable()
export class ContactResolverService {
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly projectAnalysis: ProjectEmailAnalysisService,
  ) {}

  async resolveImported(messageIds?: string[]) {
    if (this.running) return { status: 'running', processed: 0, matched: 0, unresolved: 0, ambiguous: 0 };
    this.running = true;
    try {
      const account = await this.account();
      let processed = 0;
      let matched = 0;
      let unresolved = 0;
      let ambiguous = 0;
      let cursor: string | undefined;
      while (true) {
        const messages = await this.prisma.emailMessage.findMany({
          where: {
            mailAccountId: account.id,
            ...(messageIds ? { id: { in: messageIds } } : {}),
            direction: 'inbound',
            classification: 'BUSINESS_HUMAN',
            contactResolutionStatus: 'unresolved',
            contactId: null,
          },
          orderBy: { id: 'asc' },
          take: 50,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: { id: true, fromJson: true },
        });
        if (!messages.length) break;
        for (const message of messages) {
          const senders = this.senderAddresses(message.fromJson);
          if (senders.length !== 1) {
            ambiguous += 1;
            processed += 1;
            continue;
          }
          const sender = senders[0];
          const email = sender.address;
          const displayName = sender.name || email;
          try {
            const result = await this.resolveOne(account.id, message.id, email, displayName);
            if (result === 'matched') matched += 1;
            else unresolved += 1;
          } catch (error) {
            if (!this.isUniqueConflict(error)) throw error;
            // Another backend may have resolved the same sender concurrently. Retry from the committed mapping.
            const result = await this.resolveOne(account.id, message.id, email, displayName);
            if (result === 'matched') matched += 1;
            else unresolved += 1;
          }
          processed += 1;
        }
        cursor = messages.at(-1)?.id;
        if (messages.length < 50) break;
      }
      return { status: 'completed', processed, matched, unresolved, ambiguous, createdContacts: 0 };
    } finally {
      this.running = false;
    }
  }

  async createCompany(input: { name: unknown; domain?: unknown; website?: unknown; address?: unknown; notes?: unknown; contactIds?: unknown; actorId?: unknown; operationId?: unknown }) {
    const name = this.requiredText(input.name, 'Company name', 200);
    const domain = input.domain === undefined || input.domain === null || input.domain === '' ? null : this.normalizeDomain(input.domain);
    const website = this.normalizeWebsite(input.website);
    const address = this.optionalText(input.address, 1000);
    const notes = this.optionalText(input.notes, 4000);
    const contactIds = this.normalizeContactIds(input.contactIds);
    if (!contactIds.length) throw new BadRequestException('Select at least one existing contact for the company');
    const operationId = this.requiredOperationId(input.operationId);
    try {
      return await executeAuditedMutation(this.prisma, {
        operationId, actorId: input.actorId, entityType: 'company', action: 'create',
        input: { name, domain, website, address, notes, contactIds },
        load: (client, id) => client.company.findUniqueOrThrow({ where: { id }, include: this.companyInclude() }),
        execute: async (tx) => {
          await lockCrmRelationshipWrites(tx);
          const company = await tx.company.create({ data: { name, domain, website, address, notes, status: 'confirmed' } });
          await this.setCompanyMembers(tx, company.id, contactIds);
          const value = await tx.company.findUniqueOrThrow({ where: { id: company.id }, include: this.companyInclude() });
          return { entityId: company.id, value, before: null, after: { company: value, contactIds } };
        },
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) throw new ConflictException({ code: 'COMPANY_DOMAIN_CONFLICT', message: 'Company domain is already in use' });
      throw error;
    }
  }

  async getCompany(companyId: string) {
    const company = await this.prisma.company.findFirst({ where: { id: companyId, status: 'confirmed' }, include: this.companyInclude() });
    if (!company) throw new NotFoundException('Company not found');
    return { company, contacts: company.contacts, projects: company.projects };
  }

  async updateCompany(companyId: string, input: Record<string, unknown>) {
    this.assertAllowedFields(input, ['name', 'domain', 'website', 'address', 'notes', 'contactIds', 'expectedVersion', 'actorId', 'operationId']);
    const expectedVersion = this.requiredVersion(input.expectedVersion);
    const operationId = this.requiredOperationId(input.operationId);
    const patch: Record<string, unknown> = {};
    if (Object.hasOwn(input, 'name')) patch.name = this.requiredText(input.name, 'Company name', 200);
    if (Object.hasOwn(input, 'domain')) patch.domain = input.domain === null || input.domain === '' ? null : this.normalizeDomain(input.domain);
    if (Object.hasOwn(input, 'website')) patch.website = this.normalizeWebsite(input.website);
    if (Object.hasOwn(input, 'address')) patch.address = this.optionalText(input.address, 1000);
    if (Object.hasOwn(input, 'notes')) patch.notes = this.optionalText(input.notes, 4000);
    const requestedContactIds = Object.hasOwn(input, 'contactIds') ? this.normalizeContactIds(input.contactIds) : undefined;
    if (requestedContactIds && !requestedContactIds.length) throw new BadRequestException('A company must have at least one contact');
    const hashInput = { companyId, expectedVersion, patch, requestedContactIds };
    try {
      return await executeAuditedMutation(this.prisma, {
        operationId, actorId: input.actorId, entityType: 'company', action: 'update', input: hashInput,
        load: async (client, id) => {
          const company = await client.company.findUniqueOrThrow({ where: { id }, include: this.companyInclude() });
          return { company, contacts: company.contacts, projects: company.projects };
        },
        execute: async (tx) => {
          await lockCrmRelationshipWrites(tx);
          const current = await tx.company.findUnique({ where: { id: companyId }, include: { contacts: { select: { id: true } } } });
          if (!current || current.status !== 'confirmed') throw new NotFoundException('Company not found');
          if (current.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: current.version });
          const affectedProjects = await tx.project.findMany({ where: { companyId, status: { not: 'deleted' } }, select: { id: true } });
          const nextContactIds = requestedContactIds ?? current.contacts.map((contact) => contact.id);
          if (requestedContactIds) await this.setCompanyMembers(tx, companyId, nextContactIds);
          const changed = await tx.company.updateMany({ where: { id: companyId, version: expectedVersion, status: 'confirmed' }, data: { ...patch, version: { increment: 1 } } });
          if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
          const value = await tx.company.findUniqueOrThrow({ where: { id: companyId }, include: this.companyInclude() });
          await this.projectAnalysis.invalidateProjectSummaries(tx, affectedProjects.map((project) => project.id), 'company_context_changed');
          return { entityId: companyId, value: { company: value, contacts: value.contacts, projects: value.projects }, before: current, after: value };
        },
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) throw new ConflictException({ code: 'COMPANY_DOMAIN_CONFLICT', message: 'Company domain is already in use' });
      throw error;
    }
  }

  async deleteCompany(companyId: string, input: Record<string, unknown>) {
    this.assertAllowedFields(input, ['expectedVersion', 'actorId', 'operationId']);
    const expectedVersion = this.requiredVersion(input.expectedVersion);
    const operationId = this.requiredOperationId(input.operationId);
    return executeAuditedMutation(this.prisma, {
      operationId,
      actorId: input.actorId,
      entityType: 'company',
      action: 'delete',
      input: { companyId, expectedVersion },
      load: async (client) => {
        const operation = await client.businessOperation.findUnique({ where: { operationId }, select: { afterJson: true } });
        const after = this.jsonRecord(operation?.afterJson);
        if (!after || after.id !== companyId || after.status !== 'deleted' || after.deleted !== true) throw new NotFoundException('Company deletion receipt not found');
        return after as unknown as CompanyDeletionReceipt;
      },
      execute: async (tx) => {
        await lockCrmRelationshipWrites(tx);
        const before = await tx.company.findUnique({ where: { id: companyId }, include: { contacts: { select: { id: true, version: true, status: true } } } });
        if (!before || before.status !== 'confirmed') throw new NotFoundException('Company not found');
        if (before.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: before.version });

        const contactIds = before.contacts.map((contact) => contact.id).sort();
        await this.lockContacts(tx, contactIds);
        await this.lockCompanies(tx, [companyId]);
        const current = await tx.company.findUnique({ where: { id: companyId }, include: { contacts: { select: { id: true, version: true, status: true } } } });
        if (!current || current.status !== 'confirmed') throw new NotFoundException('Company not found');
        if (current.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: current.version });

        const projects = await tx.project.findMany({ where: { companyId, status: { not: 'deleted' } }, select: { id: true, name: true, status: true } });
        if (projects.length) throw new ConflictException({
          code: 'COMPANY_HAS_PROJECTS',
          message: 'Remove or soft-delete the company projects before deleting this company',
          projects: projects.map(({ id, name, status }) => ({ id, name, status })),
        });

        const detachedContactIds: string[] = [];
        for (const contact of current.contacts) {
          const detached = await tx.contact.updateMany({
            where: { id: contact.id, companyId, version: contact.version },
            data: { companyId: null, version: { increment: 1 } },
          });
          if (!detached.count) throw new ConflictException({ code: 'CONCURRENT_UPDATE', contactId: contact.id });
          detachedContactIds.push(contact.id);
        }
        const changed = await tx.company.updateMany({
          where: { id: companyId, version: expectedVersion, status: 'confirmed' },
          data: { status: 'deleted', version: { increment: 1 } },
        });
        if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
        const receipt: CompanyDeletionReceipt = { id: companyId, status: 'deleted', version: expectedVersion + 1, detachedContactIds: detachedContactIds.sort(), deleted: true };
        return { entityId: companyId, value: receipt, before, after: receipt };
      },
    });
  }

  async createContact(input: { email?: unknown; emails?: unknown; primaryEmail?: unknown; displayName?: unknown; companyId?: unknown; notes?: unknown; actorId?: unknown; operationId?: unknown }) {
    const emails = this.normalizeEmails(input.emails ?? input.email);
    const primaryEmail = this.normalizePrimaryEmail(input.primaryEmail, emails);
    const displayName = this.requiredText(input.displayName, 'Contact name', 200);
    const companyId = this.optionalId(input.companyId);
    const notes = this.optionalText(input.notes, 4000);
    const operationId = this.requiredOperationId(input.operationId);
    try {
      return await executeAuditedMutation(this.prisma, {
        operationId, actorId: input.actorId, entityType: 'contact', action: 'create_or_restore',
        input: { displayName, emails, primaryEmail, companyId, notes },
        load: (client, id) => client.contact.findUniqueOrThrow({ where: { id }, include: this.contactInclude() }),
        execute: async (tx) => {
          await lockCrmRelationshipWrites(tx);
          if (companyId && !(await tx.company.findFirst({ where: { id: companyId, status: 'confirmed' }, select: { id: true } }))) throw new NotFoundException('Company not found');
          const mappings = await tx.contactEmail.findMany({ where: { email: { in: emails } }, select: { email: true, contactId: true } });
          const mappedIds = [...new Set(mappings.map((row) => row.contactId))];
          await this.lockContacts(tx, mappedIds);
          const refreshedMappings = mappedIds.length ? await tx.contactEmail.findMany({ where: { email: { in: emails } }, include: { contact: true } }) : [];
          if (refreshedMappings.some((row) => !mappedIds.includes(row.contactId)) ||
            refreshedMappings.some((row) => !mappings.some((old) => old.email === row.email && old.contactId === row.contactId))) {
            throw new ConflictException({ code: 'CONCURRENT_UPDATE' });
          }
          const owners = [...new Set(refreshedMappings.map((row) => row.contactId))];
          const ownerContacts = [...new Map(refreshedMappings.map((row) => [row.contactId, row.contact])).values()];
          const affectedProjects = ownerContacts.length === 1
            ? await tx.projectContact.findMany({ where: { contactId: ownerContacts[0].id, project: { status: { not: 'deleted' } } }, select: { projectId: true } })
            : [];
          let previousCompanyId: string | null = null;
          let contactId: string;
          let emailTakeovers: EmailTakeoverAudit[] = [];
          if (!owners.length) {
            const created = await tx.contact.create({
              data: { displayName, status: 'confirmed', confidence: 1, companyId, notes,
                emails: { create: emails.map((email) => ({ email, isPrimary: email === primaryEmail, verified: true })) } },
              select: { id: true },
            });
            contactId = created.id;
          } else if (ownerContacts.length === 1 && ownerContacts[0].status === 'provisional' && !ownerContacts[0].mergedIntoId) {
            const existing = ownerContacts[0];
            previousCompanyId = existing.companyId;
            if (!(await this.isEligibleAutomaticProvisional(tx, existing.id))) {
              throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'This provisional contact contains protected or manually maintained data', contactId: existing.id });
            }
            const oldEmails = await tx.contactEmail.findMany({ where: { contactId: existing.id }, select: { email: true } });
            if (oldEmails.some((item) => !emails.includes(item.email))) throw new ConflictException({ code: 'CONTACT_EMAIL_RESTORE_CONFLICT', message: 'Include every existing automatic address when confirming this contact', contactId: existing.id });
            const update = await tx.contact.updateMany({ where: { id: existing.id, version: existing.version, status: 'provisional', notes: null, companyId: null, mergedIntoId: null }, data: { displayName, status: 'confirmed', confidence: 1, provisionalReason: null, companyId, notes, version: { increment: 1 } } });
            if (!update.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
            await tx.contactEmail.updateMany({ where: { contactId: existing.id }, data: { verified: true, isPrimary: false } });
            for (const email of emails) {
              await tx.contactEmail.upsert({ where: { email }, create: { contactId: existing.id, email, isPrimary: email === primaryEmail, verified: true }, update: { isPrimary: email === primaryEmail, verified: true } });
            }
            contactId = existing.id;
            await tx.reviewItem.updateMany({ where: { entityType: 'contact', entityId: existing.id, reasonCode: 'CONTACT_PROVISIONAL', status: 'pending' }, data: { status: 'resolved', resolvedBy: 'api-token-client', resolvedAt: new Date(), resolutionJson: { action: 'explicit_contact_restore', operationId } } });
          } else if (ownerContacts.length === owners.length && ownerContacts.every((contact) => contact.status === 'retired' && !contact.mergedIntoId)) {
            emailTakeovers = await this.prepareRetiredEmailTakeovers(tx, owners, emails);
            const created = await tx.contact.create({ data: { displayName, status: 'confirmed', confidence: 1, companyId, notes }, select: { id: true } });
            contactId = created.id;
            await this.applyEmailTakeovers(tx, contactId, emails, primaryEmail, refreshedMappings, emailTakeovers);
          } else {
            throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'These addresses belong to protected or different contacts', contactIds: owners });
          }
          const contact = await tx.contact.findUniqueOrThrow({ where: { id: contactId }, include: this.contactInclude() });
          await this.assertContactCompanyCompatibility(tx, [contact.id], companyId);
          await this.bumpCompanyVersions(tx, [previousCompanyId, companyId]);
          await this.projectAnalysis.invalidateProjectSummaries(tx, affectedProjects.map((item) => item.projectId), 'contact_context_changed');
          return { entityId: contact.id, value: contact, after: { ...contact, emailTakeovers } };
        },
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'Email is already registered to a contact' });
      throw error;
    }
  }

  async getContact(contactId: string) {
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, status: 'confirmed' }, include: this.contactInclude() });
    if (!contact) throw new NotFoundException('Contact not found');
    return { contact, version: contact.version };
  }

  async deleteContact(contactId: string, input: Record<string, unknown>) {
    this.assertAllowedFields(input, ['expectedVersion', 'actorId', 'operationId']);
    const expectedVersion = this.requiredVersion(input.expectedVersion);
    const operationId = this.requiredOperationId(input.operationId);
    return executeAuditedMutation(this.prisma, {
      operationId,
      actorId: input.actorId,
      entityType: 'contact',
      action: 'delete',
      input: { contactId, expectedVersion },
      load: async (client) => {
        const operation = await client.businessOperation.findUnique({ where: { operationId }, select: { afterJson: true } });
        const after = this.jsonRecord(operation?.afterJson);
        if (!after || after.id !== contactId || after.status !== 'deleted' || after.deleted !== true) throw new NotFoundException('Contact deletion receipt not found');
        return after as unknown as ContactDeletionReceipt;
      },
      execute: async (tx) => {
        await lockCrmRelationshipWrites(tx);
        const current = await tx.contact.findUnique({ where: { id: contactId }, select: { id: true, status: true, version: true, companyId: true } });
        if (!current || current.status !== 'confirmed') throw new NotFoundException('Contact not found');
        if (current.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: current.version });
        await this.lockContacts(tx, [contactId]);
        await this.lockCompanies(tx, [current.companyId]);
        const refreshed = await tx.contact.findUnique({ where: { id: contactId }, select: { id: true, status: true, version: true, companyId: true } });
        if (!refreshed || refreshed.status !== 'confirmed') throw new NotFoundException('Contact not found');
        if (refreshed.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: refreshed.version });
        if (refreshed.companyId) throw new ConflictException({
          code: 'CONTACT_HAS_COMPANY_MEMBERSHIP',
          message: 'Remove this contact from its company before deleting it',
          companyId: refreshed.companyId,
        });
        const memberships = await tx.projectContact.findMany({
          where: { contactId, project: { status: { not: 'deleted' } } },
          select: { project: { select: { id: true, name: true, status: true } } },
        });
        if (memberships.length) throw new ConflictException({
          code: 'CONTACT_HAS_PROJECT_MEMBERSHIPS',
          message: 'Remove this contact from active projects before deleting it',
          projects: memberships.map(({ project }) => project),
        });
        const changed = await tx.contact.updateMany({
          where: { id: contactId, version: expectedVersion, status: 'confirmed', companyId: null },
          data: { status: 'deleted', version: { increment: 1 } },
        });
        if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
        const receipt: ContactDeletionReceipt = { id: contactId, status: 'deleted', version: expectedVersion + 1, deleted: true };
        return { entityId: contactId, value: receipt, before: refreshed, after: receipt };
      },
    });
  }

  async updateContact(contactId: string, input: Record<string, unknown>) {
    this.assertAllowedFields(input, ['displayName', 'emails', 'primaryEmail', 'companyId', 'notes', 'expectedVersion', 'actorId', 'operationId']);
    const expectedVersion = this.requiredVersion(input.expectedVersion);
    const operationId = this.requiredOperationId(input.operationId);
    const patch: Record<string, unknown> = {};
    if (Object.hasOwn(input, 'displayName')) patch.displayName = this.requiredText(input.displayName, 'Contact name', 200);
    if (Object.hasOwn(input, 'notes')) patch.notes = this.optionalText(input.notes, 4000);
    if (Object.hasOwn(input, 'companyId')) patch.companyId = this.optionalId(input.companyId);
    const emails = Object.hasOwn(input, 'emails') ? this.normalizeEmails(input.emails) : undefined;
    const hashInput = { contactId, expectedVersion, patch, emails, primaryEmail: input.primaryEmail };
    try {
      return await executeAuditedMutation(this.prisma, {
      operationId, actorId: input.actorId, entityType: 'contact', action: 'update', input: hashInput,
      load: (client, id) => client.contact.findUniqueOrThrow({ where: { id }, include: this.contactInclude() }),
      execute: async (tx) => {
        await lockCrmRelationshipWrites(tx);
        const initial = await tx.contact.findUnique({ where: { id: contactId }, select: { id: true, status: true } });
        if (!initial || initial.status !== 'confirmed') throw new NotFoundException('Contact not found');
        const initialMappings = emails?.length ? await tx.contactEmail.findMany({ where: { email: { in: emails } }, select: { email: true, contactId: true } }) : [];
        const initialOwnerIds = [...new Set(initialMappings.map((row) => row.contactId))];
        await this.lockContacts(tx, [contactId, ...initialOwnerIds]);
        const current = await tx.contact.findUnique({ where: { id: contactId }, include: { emails: true } });
        if (!current || current.status !== 'confirmed') throw new NotFoundException('Contact not found');
        if (current.version !== expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', currentVersion: current.version });
        const emailMappings = emails?.length ? await tx.contactEmail.findMany({ where: { email: { in: emails } }, select: { email: true, contactId: true, isPrimary: true, verified: true } }) : [];
        if (emailMappings.some((row) => !initialOwnerIds.includes(row.contactId)) ||
          emailMappings.some((row) => !initialMappings.some((old) => old.email === row.email && old.contactId === row.contactId))) {
          throw new ConflictException({ code: 'CONCURRENT_UPDATE' });
        }
        const nextCompanyId = Object.hasOwn(patch, 'companyId') ? patch.companyId as string | null : current.companyId;
        if (nextCompanyId && !(await tx.company.findFirst({ where: { id: nextCompanyId, status: 'confirmed' }, select: { id: true } }))) throw new NotFoundException('Company not found');
        await this.assertContactCompanyCompatibility(tx, [contactId], nextCompanyId);
        const affectedProjects = await tx.projectContact.findMany({ where: { contactId, project: { status: { not: 'deleted' } } }, select: { projectId: true } });
        let emailTakeovers: EmailTakeoverAudit[] = [];
        if (emails) {
          const oldPrimary = current.emails.find((item) => item.isPrimary)?.email;
          const primaryEmail = this.normalizePrimaryEmail(input.primaryEmail, emails, oldPrimary && emails.includes(oldPrimary) ? oldPrimary : emails[0]);
          if (!emails.length) throw new BadRequestException('A contact must have at least one email address');
          const foreignOwnerIds = [...new Set(emailMappings.filter((row) => row.contactId !== contactId).map((row) => row.contactId))];
          if (foreignOwnerIds.length) emailTakeovers = await this.prepareRetiredEmailTakeovers(tx, foreignOwnerIds, emails);
          await tx.contactEmail.deleteMany({ where: { contactId, email: { notIn: emails } } });
          await this.applyEmailTakeovers(tx, contactId, emails, primaryEmail, emailMappings, emailTakeovers);
        } else if (Object.hasOwn(input, 'primaryEmail')) {
          const primary = this.normalizePrimaryEmail(input.primaryEmail, current.emails.map((item) => item.email));
          await tx.contactEmail.updateMany({ where: { contactId }, data: { isPrimary: false } });
          await tx.contactEmail.update({ where: { email: primary }, data: { isPrimary: true } });
        }
        if (current.companyId !== nextCompanyId) await this.bumpCompanyVersions(tx, [current.companyId, nextCompanyId]);
        const changed = await tx.contact.updateMany({ where: { id: contactId, version: expectedVersion, status: 'confirmed' }, data: { ...patch, version: { increment: 1 } } });
        if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT' });
        const value = await tx.contact.findUniqueOrThrow({ where: { id: contactId }, include: this.contactInclude() });
        await this.projectAnalysis.invalidateProjectSummaries(tx, affectedProjects.map((item) => item.projectId), 'contact_context_changed');
        return { entityId: contactId, value, before: current, after: { ...value, emailTakeovers } };
      },
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'One or more email addresses are already registered to another contact' });
      throw error;
    }
  }

  async listContacts(limit: number, offset: number, search?: string, companyId?: string) {
    const term = search?.trim();
    if (term && (term.length < 1 || term.length > 100)) throw new BadRequestException('search must contain 1 to 100 characters');
    const selectedCompanyId = companyId?.trim() || undefined;
    if (selectedCompanyId && !(await this.prisma.company.findFirst({ where: { id: selectedCompanyId, status: 'confirmed' }, select: { id: true } }))) throw new NotFoundException('Company not found');
    const where: Prisma.ContactWhereInput = { status: 'confirmed', ...(selectedCompanyId ? { companyId: selectedCompanyId } : {}), ...(term ? { OR: [
      { displayName: { contains: term, mode: 'insensitive' } },
      { emails: { some: { email: { contains: term, mode: 'insensitive' } } } },
    ] } : {}) };
    const [total, contacts] = await this.prisma.$transaction([
      this.prisma.contact.count({ where }),
      this.prisma.contact.findMany({ where, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: limit, skip: offset, include: this.contactInclude() }),
    ]);
    return { total, offset, limit, contacts };
  }

  async listCompanies(limit: number, offset: number) {
    const [total, companies] = await this.prisma.$transaction([
      this.prisma.company.count({ where: { status: { not: 'deleted' } } }),
      this.prisma.company.findMany({ where: { status: { not: 'deleted' } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: limit, skip: offset, include: this.companyInclude() }),
    ]);
    return { total, offset, limit, companies };
  }

  async legacyContactCleanupPreview(client: Prisma.TransactionClient | PrismaService = this.prisma) {
    const candidates = await client.contact.findMany({
      where: { status: 'provisional' }, include: { emails: true, _count: { select: { messages: true, decisions: true, projectContacts: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2000,
    });
    const items = await Promise.all(candidates.map(async (contact) => {
      const [manualMessage, operation, reviews] = await Promise.all([
        client.emailMessage.findFirst({ where: { contactId: contact.id, OR: [
          { projectManualOverride: true }, { topicManualOverride: true }, { classificationManualOverride: true }, { projectId: { not: null } }, { topicId: { not: null } },
        ] }, select: { id: true } }),
        client.businessOperation.findFirst({ where: { entityType: 'contact', entityId: contact.id }, select: { id: true } }),
        client.reviewItem.findMany({ where: { entityType: 'contact', entityId: contact.id, status: 'pending' }, select: { id: true, reasonCode: true } }),
      ]);
      const untouched = contact.version === 1 && !contact.notes && contact.updatedAt.getTime() === contact.createdAt.getTime();
      const automatic = untouched && contact.confidence === 0.25 && Boolean(contact.provisionalReason?.startsWith('Unmapped inbound human sender')) && !contact.companyId && !contact.mergedIntoId && contact.emails.length > 0 && contact.emails.every((item) => !item.verified);
      const eligible = automatic && !manualMessage && !operation && contact._count.decisions === 0 && contact._count.projectContacts === 0 && reviews.every((item) => item.reasonCode === 'CONTACT_PROVISIONAL');
      const reasons = [
        !automatic ? 'not_pure_automatic_contact' : null,
        !untouched ? 'contact_was_edited_after_creation' : null,
        manualMessage ? 'manual_email_assignment_or_business_dependency' : null,
        operation ? 'audited_manual_contact_operation' : null,
        contact._count.decisions ? 'contact_decisions_exist' : null,
        contact._count.projectContacts ? 'project_membership_exists' : null,
        reviews.some((item) => item.reasonCode !== 'CONTACT_PROVISIONAL') ? 'non_contact_confirmation_review_exists' : null,
      ].filter(Boolean);
      return { id: contact.id, displayName: contact.displayName, emails: contact.emails.map(({ email }) => email), status: contact.status, version: contact.version, linkedMessageCount: contact._count.messages, eligible, reasons };
    }));
    return { generatedAt: new Date().toISOString(), total: candidates.length, truncated: candidates.length === 2000, eligibleCount: items.filter((item) => item.eligible).length, items };
  }

  async retireLegacyContacts(input: Record<string, unknown>) {
    this.assertAllowedFields(input, ['contacts', 'actorId', 'operationId']);
    if (!Array.isArray(input.contacts) || !input.contacts.length || input.contacts.length > 500) throw new BadRequestException('contacts must contain 1 to 500 contact/version entries');
    const selected = input.contacts.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BadRequestException('Each contact entry must include id and expectedVersion');
      const row = item as Record<string, unknown>;
      return { id: this.requiredText(row.id, 'Contact id', 100), expectedVersion: this.requiredVersion(row.expectedVersion) };
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(selected.map((item) => item.id)).size !== selected.length) throw new BadRequestException('contacts contains duplicate ids');
    const operationId = this.requiredOperationId(input.operationId);
    return executeAuditedMutation<LegacyContactCleanupReport>(this.prisma, {
      operationId, actorId: input.actorId, entityType: 'contact_legacy_cleanup', action: 'retire_automatic', input: { selected },
      load: async (client) => (await client.businessOperation.findUniqueOrThrow({ where: { operationId } })).afterJson as unknown as LegacyContactCleanupReport,
      execute: async (tx) => {
        await lockCrmRelationshipWrites(tx);
        await this.lockContacts(tx, selected.map((item) => item.id));
        const preview = await this.legacyContactCleanupPreview(tx);
        const eligible = new Map(preview.items.filter((item) => item.eligible).map((item) => [item.id, item]));
        for (const item of selected) {
          const candidate = eligible.get(item.id);
          if (!candidate) throw new ConflictException({ code: 'CONTACT_CLEANUP_NOT_ELIGIBLE', contactId: item.id, reasons: preview.items.find((row) => row.id === item.id)?.reasons ?? ['not_found'] });
          if (candidate.version !== item.expectedVersion) throw new ConflictException({ code: 'VERSION_CONFLICT', contactId: item.id, currentVersion: candidate.version });
        }
        const records: LegacyContactCleanupReport['records'] = [];
        for (const item of selected) {
          const current = await tx.contact.findUnique({ where: { id: item.id }, include: { emails: true } });
          if (!current || current.version !== item.expectedVersion || current.status !== 'provisional') throw new ConflictException({ code: 'VERSION_CONFLICT', contactId: item.id });
          const changed = await tx.contact.updateMany({ where: { id: item.id, status: 'provisional', version: item.expectedVersion }, data: { status: 'retired', version: { increment: 1 } } });
          if (!changed.count) throw new ConflictException({ code: 'VERSION_CONFLICT', contactId: item.id });
          await tx.reviewItem.updateMany({ where: { entityType: 'contact', entityId: item.id, reasonCode: 'CONTACT_PROVISIONAL', status: 'pending' }, data: { status: 'resolved', resolvedBy: String(input.actorId ?? 'api-token-client'), resolvedAt: new Date(), resolutionJson: { action: 'retire_automatic_contact', operationId, reason: 'Pure automatic contact removed from the normal CRM list; addresses and linked evidence are retained' } } });
          records.push({ id: item.id, previousStatus: current.status, previousConfidence: current.confidence, previousReason: current.provisionalReason, previousVersion: current.version, retiredVersion: current.version + 1, emails: current.emails.map(({ email, isPrimary, verified }) => ({ email, isPrimary, verified })) });
        }
        const report = { operationId, retiredCount: records.length, records };
        return { entityId: operationId, value: report, before: { selected }, after: report };
      },
    });
  }

  async restoreLegacyContacts(input: Record<string, unknown>) {
    this.assertAllowedFields(input, ['sourceOperationId', 'actorId', 'operationId']);
    const sourceOperationId = this.requiredOperationId(input.sourceOperationId);
    const operationId = this.requiredOperationId(input.operationId);
    return executeAuditedMutation(this.prisma, {
      operationId, actorId: input.actorId, entityType: 'contact_legacy_cleanup', action: 'restore_automatic', input: { sourceOperationId },
      load: async (client) => (await client.businessOperation.findUniqueOrThrow({ where: { operationId } })).afterJson as Prisma.JsonObject,
      execute: async (tx) => {
        await lockCrmRelationshipWrites(tx);
        const prior = await tx.businessOperation.findUnique({ where: { operationId: sourceOperationId } });
        if (!prior || prior.entityType !== 'contact_legacy_cleanup' || prior.action !== 'retire_automatic' || !prior.afterJson || typeof prior.afterJson !== 'object' || Array.isArray(prior.afterJson)) throw new NotFoundException('Contact retirement audit not found');
        const records = (prior.afterJson as Record<string, unknown>).records;
        if (!Array.isArray(records) || !records.length) throw new ConflictException({ code: 'CONTACT_RETIREMENT_AUDIT_INVALID' });
        const restored: string[] = [];
        for (const raw of records) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const record = raw as Record<string, unknown>;
          const id = this.requiredText(record.id, 'Contact id', 100);
          await this.lockContacts(tx, [id]);
          const current = await tx.contact.findUnique({ where: { id } });
          if (!current || current.status !== 'retired' || current.version !== record.retiredVersion) throw new ConflictException({ code: 'CONTACT_RESTORE_CONFLICT', contactId: id, currentVersion: current?.version ?? null });
          const updated = await tx.contact.updateMany({ where: { id, version: current.version, status: 'retired' }, data: { status: String(record.previousStatus), confidence: Number(record.previousConfidence), provisionalReason: typeof record.previousReason === 'string' ? record.previousReason : null, version: { increment: 1 } } });
          if (!updated.count) throw new ConflictException({ code: 'CONTACT_RESTORE_CONFLICT', contactId: id });
          restored.push(id);
        }
        const report = { sourceOperationId, operationId, restoredCount: restored.length, restoredContactIds: restored };
        return { entityId: operationId, value: report, before: { sourceOperationId }, after: report };
      },
    });
  }

  private async isEligibleAutomaticProvisional(tx: Prisma.TransactionClient, contactId: string): Promise<boolean> {
    const contact = await tx.contact.findUnique({
      where: { id: contactId },
      include: { emails: true, _count: { select: { decisions: true, projectContacts: true, mergedContacts: true } } },
    });
    if (!contact || contact.status !== 'provisional' || contact.notes !== null || contact.companyId !== null || contact.mergedIntoId !== null ||
      contact.confidence !== 0.25 || !contact.provisionalReason?.startsWith('Unmapped inbound human sender') ||
      contact._count.decisions !== 0 || contact._count.projectContacts !== 0 || contact._count.mergedContacts !== 0 ||
      contact.emails.length === 0 || contact.emails.some((email) => email.verified)) return false;
    if (!(await this.hasNoManualContactDependencies(tx, contactId))) return false;

    if (contact.version === 1 && contact.createdAt.getTime() === contact.updatedAt.getTime()) {
      const preview = await this.legacyContactCleanupPreview(tx);
      return preview.items.some((item) => item.id === contactId && item.eligible);
    }

    const retirement = await this.findRetirementRecord(tx, contactId);
    if (!retirement || retirement.record.retiredVersion + 1 !== contact.version) return false;
    const restores = await tx.$queryRaw<Array<{ operationId: string; afterJson: Prisma.JsonValue }>>(Prisma.sql`
      SELECT "operationId", "afterJson"
      FROM "BusinessOperation"
      WHERE "entityType" = 'contact_legacy_cleanup'
        AND "action" = 'restore_automatic'
        AND "afterJson"->>'sourceOperationId' = ${retirement.operation.operationId}
      ORDER BY "id"
      LIMIT 5001
    `);
    if (restores.length > 5000) return false;
    const matchingRestores = restores.filter((operation) => {
      const after = this.jsonRecord(operation.afterJson);
      return Array.isArray(after?.restoredContactIds) && after.restoredContactIds.includes(contactId);
    });
    if (matchingRestores.length !== 1 || contact.status !== retirement.record.previousStatus ||
      !this.emailSnapshotsEqual(contact.emails, retirement.record.emails)) return false;
    const contactOperations = await tx.businessOperation.count({ where: { entityType: 'contact', entityId: contactId } });
    return contactOperations === 0;
  }

  private async prepareRetiredEmailTakeovers(
    tx: Prisma.TransactionClient,
    sourceContactIds: string[],
    selectedEmails: string[],
  ): Promise<EmailTakeoverAudit[]> {
    const ids = [...new Set(sourceContactIds)].sort();
    if (!ids.length) return [];
    const contacts = await tx.contact.findMany({
      where: { id: { in: ids } },
      include: { emails: true, _count: { select: { decisions: true, projectContacts: true, mergedContacts: true } } },
    });
    if (contacts.length !== ids.length) throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'A selected address has no eligible retired source' });
    const retirementOperations = await tx.businessOperation.findMany({
      where: { entityType: 'contact_legacy_cleanup', action: 'retire_automatic' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { operationId: true, createdAt: true, afterJson: true },
    });
    const takeoverAudits: EmailTakeoverAudit[] = [];
    for (const contact of contacts) {
      const candidates = retirementOperations.flatMap((operation) => {
        const after = this.jsonRecord(operation.afterJson);
        const rows = after?.records;
        if (!Array.isArray(rows)) return [];
        const record = rows.find((item) => this.jsonRecord(item)?.id === contact.id);
        return record ? [{ operation, record: this.parseRetirementRecord(record) }] : [];
      });
      if (candidates.length !== 1 || !candidates[0].record) throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'Retired source lacks one valid automatic-retirement audit', contactId: contact.id });
      const { operation, record } = candidates[0] as { operation: typeof retirementOperations[number]; record: RetirementRecord };
      if (!this.isPureAutomaticRetirementRecord(record) || contact.status !== 'retired' || contact.version < record.retiredVersion ||
        contact.notes !== null || contact.companyId !== null || contact.mergedIntoId !== null ||
        contact.confidence !== record.previousConfidence || contact.provisionalReason !== record.previousReason ||
        contact._count.decisions !== 0 || contact._count.projectContacts !== 0 || contact._count.mergedContacts !== 0 ||
        !(await this.hasNoManualContactDependencies(tx, contact.id))) {
        throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'Retired source has manual edits or business dependencies', contactId: contact.id });
      }

      const operations = await tx.$queryRaw<Array<{ operationId: string; entityId: string; afterJson: Prisma.JsonValue }>>(Prisma.sql`
        SELECT "operationId", "entityId", "afterJson"
        FROM "BusinessOperation" AS bo
        WHERE bo."entityType" = 'contact'
          AND (
            bo."entityId" = ${contact.id}
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(bo."afterJson"->'emailTakeovers') = 'array'
                  THEN bo."afterJson"->'emailTakeovers'
                  ELSE '[]'::jsonb
                END
              ) AS transfer_entries(transfer_entry)
              WHERE transfer_entries.transfer_entry->>'sourceContactId' = ${contact.id}
                AND transfer_entries.transfer_entry->>'retirementOperationId' = ${operation.operationId}
            )
          )
        ORDER BY bo."id"
        LIMIT 5001
      `);
      if (operations.length > 5000 || operations.some((item) => item.entityId === contact.id)) {
        throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'Retired source has a later manual contact operation', contactId: contact.id });
      }
      const history: Array<EmailTakeoverAudit & { operationId: string }> = [];
      for (const item of operations) {
        const after = this.jsonRecord(item.afterJson);
        if (!Array.isArray(after?.emailTakeovers)) continue;
        const entries = after.emailTakeovers.filter((entry) => this.jsonRecord(entry)?.sourceContactId === contact.id);
        if (entries.length > 1) throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'Retired source audit chain is ambiguous', contactId: contact.id });
        if (entries.length === 1) {
          const parsed = this.parseEmailTakeoverAudit(entries[0]);
          if (!parsed) throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'Retired source audit chain is invalid', contactId: contact.id });
          history.push({ ...parsed, operationId: item.operationId });
        }
      }
      history.sort((left, right) => left.sourceVersionBefore - right.sourceVersionBefore);
      const expectedEmails = new Map(record.emails.map((item) => [item.email, item]));
      let expectedVersion = record.retiredVersion;
      for (const entry of history) {
        if (entry.retirementOperationId !== operation.operationId || entry.sourceVersionBefore !== expectedVersion ||
          entry.sourceVersionAfter !== expectedVersion + 1 || !entry.operationId ||
          !this.emailSnapshotsEqual([...expectedEmails.values()], entry.sourceMappingsBefore) ||
          !entry.selectedEmails.length || new Set(entry.selectedEmails).size !== entry.selectedEmails.length ||
          entry.selectedEmails.some((email) => !expectedEmails.has(email))) {
          throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'Retired source audit chain does not match its current email mappings', contactId: contact.id });
        }
        for (const email of entry.selectedEmails) expectedEmails.delete(email);
        expectedVersion = entry.sourceVersionAfter;
      }
      if (contact.version !== expectedVersion || !this.emailSnapshotsEqual(contact.emails, [...expectedEmails.values()])) {
        throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'Retired source has changed since its audited retirement', contactId: contact.id });
      }
      const selected = selectedEmails.filter((email) => expectedEmails.has(email));
      if (!selected.length) throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', message: 'No selected email remains on this retired source', contactId: contact.id });
      takeoverAudits.push({
        sourceContactId: contact.id,
        retirementOperationId: operation.operationId,
        sourceVersionBefore: contact.version,
        sourceVersionAfter: contact.version + 1,
        selectedEmails: selected.sort(),
        sourceMappingsBefore: contact.emails.map(({ email, isPrimary, verified }) => ({ email, isPrimary, verified })).sort((left, right) => left.email.localeCompare(right.email)),
      });
    }
    return takeoverAudits;
  }

  private async applyEmailTakeovers(
    tx: Prisma.TransactionClient,
    targetContactId: string,
    emails: string[],
    primaryEmail: string,
    mappings: Array<{ email: string; contactId: string; isPrimary?: boolean; verified?: boolean }>,
    takeovers: EmailTakeoverAudit[],
  ) {
    const sourceByEmail = new Map<string, EmailTakeoverAudit>();
    for (const takeover of takeovers) for (const email of takeover.selectedEmails) sourceByEmail.set(email, takeover);
    const mappingByEmail = new Map(mappings.map((item) => [item.email, item]));
    for (const email of emails) {
      const mapping = mappingByEmail.get(email);
      if (mapping?.contactId === targetContactId) {
        await tx.contactEmail.update({ where: { email }, data: { isPrimary: email === primaryEmail, verified: true } });
      } else if (mapping) {
        const source = sourceByEmail.get(email);
        if (!source || source.sourceContactId !== mapping.contactId) throw new ConflictException({ code: 'EMAIL_CONTACT_CONFLICT', emails: [email], contactId: mapping.contactId });
        const moved = await tx.contactEmail.updateMany({ where: { email, contactId: mapping.contactId }, data: { contactId: targetContactId, isPrimary: email === primaryEmail, verified: true } });
        if (!moved.count) throw new ConflictException({ code: 'CONCURRENT_UPDATE', email });
      } else {
        await tx.contactEmail.create({ data: { contactId: targetContactId, email, isPrimary: email === primaryEmail, verified: true } });
      }
    }
    for (const takeover of takeovers) {
      const updated = await tx.contact.updateMany({
        where: { id: takeover.sourceContactId, version: takeover.sourceVersionBefore, status: 'retired', notes: null, companyId: null, mergedIntoId: null },
        data: { version: { increment: 1 } },
      });
      if (!updated.count) throw new ConflictException({ code: 'VERSION_CONFLICT', contactId: takeover.sourceContactId });
    }
  }

  private async hasNoManualContactDependencies(tx: Prisma.TransactionClient, contactId: string): Promise<boolean> {
    const [manualMessage, nonAutomaticReview] = await Promise.all([
      tx.emailMessage.findFirst({
        where: { contactId, OR: [
          { projectManualOverride: true }, { topicManualOverride: true }, { classificationManualOverride: true },
          { projectId: { not: null } }, { topicId: { not: null } },
        ] },
        select: { id: true },
      }),
      tx.reviewItem.findFirst({ where: { entityType: 'contact', entityId: contactId, reasonCode: { not: 'CONTACT_PROVISIONAL' } }, select: { id: true } }),
    ]);
    return !manualMessage && !nonAutomaticReview;
  }

  private async findRetirementRecord(tx: Prisma.TransactionClient, contactId: string) {
    const operations = await tx.businessOperation.findMany({
      where: { entityType: 'contact_legacy_cleanup', action: 'retire_automatic' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { operationId: true, createdAt: true, afterJson: true },
    });
    const candidates = operations.flatMap((operation) => {
      const after = this.jsonRecord(operation.afterJson);
      const records = after?.records;
      if (!Array.isArray(records)) return [];
      return records.filter((record) => this.jsonRecord(record)?.id === contactId).map((record) => ({ operation, record: this.parseRetirementRecord(record) }));
    });
    if (candidates.length !== 1 || !candidates[0].record || !this.isPureAutomaticRetirementRecord(candidates[0].record)) return null;
    return candidates[0] as { operation: typeof operations[number]; record: RetirementRecord };
  }

  private parseRetirementRecord(value: unknown): RetirementRecord | null {
    const record = this.jsonRecord(value);
    if (!record || typeof record.id !== 'string' || typeof record.previousStatus !== 'string' ||
      typeof record.previousConfidence !== 'number' ||
      (record.previousReason !== null && typeof record.previousReason !== 'string') ||
      !Number.isSafeInteger(record.previousVersion) || !Number.isSafeInteger(record.retiredVersion) || !Array.isArray(record.emails)) return null;
    const emails: ContactEmailSnapshot[] = [];
    for (const item of record.emails) {
      const row = this.jsonRecord(item);
      if (!row || typeof row.email !== 'string' || typeof row.isPrimary !== 'boolean' || typeof row.verified !== 'boolean') return null;
      emails.push({ email: row.email, isPrimary: row.isPrimary, verified: row.verified });
    }
    return {
      id: record.id,
      previousStatus: record.previousStatus,
      previousConfidence: record.previousConfidence,
      previousReason: typeof record.previousReason === 'string' ? record.previousReason : null,
      previousVersion: record.previousVersion as number,
      retiredVersion: record.retiredVersion as number,
      emails,
    };
  }

  private isPureAutomaticRetirementRecord(record: RetirementRecord): boolean {
    return record.previousStatus === 'provisional' && record.previousVersion === 1 && record.retiredVersion === 2 &&
      record.previousConfidence === 0.25 && Boolean(record.previousReason?.startsWith('Unmapped inbound human sender')) &&
      record.emails.length > 0 && record.emails.every((item) => !item.verified) &&
      new Set(record.emails.map((item) => item.email)).size === record.emails.length;
  }

  private parseEmailTakeoverAudit(value: unknown): EmailTakeoverAudit | null {
    const row = this.jsonRecord(value);
    if (!row || typeof row.sourceContactId !== 'string' || typeof row.retirementOperationId !== 'string' ||
      !Number.isSafeInteger(row.sourceVersionBefore) || !Number.isSafeInteger(row.sourceVersionAfter) ||
      !Array.isArray(row.selectedEmails) || row.selectedEmails.some((email) => typeof email !== 'string') ||
      !Array.isArray(row.sourceMappingsBefore)) return null;
    const snapshots: ContactEmailSnapshot[] = [];
    for (const item of row.sourceMappingsBefore) {
      const snapshot = this.jsonRecord(item);
      if (!snapshot || typeof snapshot.email !== 'string' || typeof snapshot.isPrimary !== 'boolean' || typeof snapshot.verified !== 'boolean') return null;
      snapshots.push({ email: snapshot.email, isPrimary: snapshot.isPrimary, verified: snapshot.verified });
    }
    return {
      sourceContactId: row.sourceContactId,
      retirementOperationId: row.retirementOperationId,
      sourceVersionBefore: row.sourceVersionBefore as number,
      sourceVersionAfter: row.sourceVersionAfter as number,
      selectedEmails: row.selectedEmails as string[],
      sourceMappingsBefore: snapshots,
    };
  }

  private emailSnapshotsEqual(left: readonly ContactEmailSnapshot[], right: readonly ContactEmailSnapshot[]): boolean {
    const normalize = (items: readonly ContactEmailSnapshot[]) => items.map(({ email, isPrimary, verified }) => ({ email, isPrimary, verified })).sort((a, b) => a.email.localeCompare(b.email));
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }

  private jsonRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  private contactInclude() {
    return { emails: { orderBy: [{ isPrimary: 'desc' as const }, { email: 'asc' as const }] }, company: { select: { id: true, name: true, domain: true, website: true, address: true, notes: true } } };
  }

  private companyInclude() {
    return {
      contacts: { where: { status: 'confirmed' }, orderBy: [{ displayName: 'asc' as const }, { id: 'asc' as const }], include: { emails: { orderBy: [{ isPrimary: 'desc' as const }, { email: 'asc' as const }] } } },
      projects: { where: { status: { not: 'deleted' } }, orderBy: [{ name: 'asc' as const }, { id: 'asc' as const }], include: { projectContacts: { orderBy: [{ isPrimary: 'desc' as const }, { contact: { displayName: 'asc' as const } }], include: { contact: { include: { emails: true } } } } } },
      _count: { select: { contacts: { where: { status: 'confirmed' } }, messages: true, projects: { where: { status: { not: 'deleted' } } } } },
    };
  }

  private async lockContacts(tx: Prisma.TransactionClient, contactIds: string[]) {
    const ids = [...new Set(contactIds)].sort();
    if (ids.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Contact" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
  }

  private async lockCompanies(tx: Prisma.TransactionClient, companyIds: Array<string | null>) {
    const ids = [...new Set(companyIds.filter((id): id is string => Boolean(id)))].sort();
    if (ids.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Company" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
  }

  private async setCompanyMembers(tx: Prisma.TransactionClient, companyId: string, nextContactIds: string[]) {
    const current = await tx.contact.findMany({ where: { companyId, status: 'confirmed' }, select: { id: true } });
    const allIds = [...new Set([...current.map((item) => item.id), ...nextContactIds])].sort();
    await this.lockContacts(tx, allIds);
    const contacts = await tx.contact.findMany({ where: { id: { in: allIds } }, select: { id: true, companyId: true, status: true, version: true } });
    if (contacts.length !== allIds.length) throw new NotFoundException('One or more contacts were not found');
    const invalid = contacts.filter((item) => nextContactIds.includes(item.id) && item.status !== 'confirmed').map((item) => item.id);
    if (invalid.length) throw new ConflictException({ code: 'CONTACT_NOT_ACTIVE', contactIds: invalid });
    const assignedElsewhere = contacts.filter((item) => nextContactIds.includes(item.id) && item.companyId && item.companyId !== companyId);
    if (assignedElsewhere.length) throw new ConflictException({ code: 'CONTACT_BELONGS_TO_ANOTHER_COMPANY', contacts: assignedElsewhere.map((item) => ({ id: item.id, currentCompanyId: item.companyId })) });
    const nextCompany = new Map(contacts.map((item) => [item.id, nextContactIds.includes(item.id) ? companyId : item.companyId === companyId ? null : item.companyId]));
    const memberships = allIds.length ? await tx.projectContact.findMany({ where: { contactId: { in: allIds }, project: { status: { not: 'deleted' } } }, select: { contactId: true, project: { select: { id: true, companyId: true } } } }) : [];
    const conflicts = memberships.filter((item) => item.project.companyId !== nextCompany.get(item.contactId));
    if (conflicts.length) throw new ConflictException({ code: 'PROJECT_CONTACT_COMPANY_CONFLICT', memberships: conflicts.map((item) => ({ contactId: item.contactId, projectId: item.project.id, projectCompanyId: item.project.companyId, nextCompanyId: nextCompany.get(item.contactId) })) });
    const oldCompanyIds = contacts.filter((item) => item.companyId && item.companyId !== nextCompany.get(item.id)).map((item) => item.companyId);
    await this.lockCompanies(tx, [...oldCompanyIds, companyId]);
    for (const contact of contacts) {
      const nextCompanyId = nextCompany.get(contact.id) ?? null;
      if (contact.companyId === nextCompanyId) continue;
      const updated = await tx.contact.updateMany({ where: { id: contact.id, version: contact.version, status: 'confirmed' }, data: { companyId: nextCompanyId, version: { increment: 1 } } });
      if (!updated.count) throw new ConflictException({ code: 'CONCURRENT_UPDATE', contactId: contact.id });
    }
    for (const oldCompanyId of [...new Set(contacts.filter((item) => item.companyId && item.companyId !== companyId && nextContactIds.includes(item.id)).map((item) => item.companyId!))]) {
      await tx.company.updateMany({ where: { id: oldCompanyId }, data: { version: { increment: 1 } } });
    }
  }

  private async assertContactCompanyCompatibility(tx: Prisma.TransactionClient, contactIds: string[], companyId: string | null) {
    const ids = [...new Set(contactIds)].sort();
    await this.lockContacts(tx, ids);
    if (!ids.length) return;
    const rows = await tx.projectContact.findMany({ where: { contactId: { in: ids }, project: { status: { not: 'deleted' } } }, select: { contactId: true, project: { select: { id: true, companyId: true } } } });
    const conflicts = rows.filter((row) => row.project.companyId !== companyId);
    if (conflicts.length) throw new ConflictException({ code: 'PROJECT_CONTACT_COMPANY_CONFLICT', memberships: conflicts.map((row) => ({ contactId: row.contactId, projectId: row.project.id, projectCompanyId: row.project.companyId, nextCompanyId: companyId })) });
  }

  private async assertCompanyContacts(tx: Prisma.TransactionClient, companyId: string, contactIds: string[]) {
    await this.lockContacts(tx, contactIds);
    if (!contactIds.length) throw new BadRequestException('Select at least one project contact');
    const rows = await tx.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, companyId: true, status: true } });
    const invalid = rows.filter((row) => row.status !== 'confirmed' || row.companyId !== companyId).map((row) => ({ id: row.id, companyId: row.companyId, status: row.status }));
    if (rows.length !== contactIds.length || invalid.length) throw new ConflictException({ code: 'PROJECT_CONTACT_MUST_BELONG_TO_COMPANY', companyId, invalidContactIds: invalid });
  }

  private async bumpCompanyVersions(tx: Prisma.TransactionClient, companyIds: Array<string | null>) {
    const ids = [...new Set(companyIds.filter((id): id is string => Boolean(id)))].sort();
    await this.lockCompanies(tx, ids);
    for (const id of ids) await tx.company.updateMany({ where: { id }, data: { version: { increment: 1 } } });
  }

  private normalizeEmails(value: unknown): string[] {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    if (!values.length || values.some((item) => typeof item !== 'string')) throw new BadRequestException('A contact must have at least one valid email address');
    const emails = values.map((item) => this.normalizeEmail(item));
    if (new Set(emails).size !== emails.length) throw new BadRequestException('Email addresses must be unique within a contact');
    return emails.sort();
  }

  private normalizePrimaryEmail(value: unknown, emails: string[], fallback?: string): string {
    const primary = value === undefined || value === null || value === '' ? fallback ?? emails[0] : this.normalizeEmail(value);
    if (!emails.includes(primary)) throw new BadRequestException('primaryEmail must be one of the registered emails');
    return primary;
  }

  private normalizeContactIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 100)) throw new BadRequestException('contactIds must be an array of contact ids');
    const ids = value.map((item) => (item as string).trim());
    if (new Set(ids).size !== ids.length) throw new BadRequestException('contactIds must not contain duplicates');
    return ids.sort();
  }

  private normalizeWebsite(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.trim().length > 2048) throw new BadRequestException('website must be an http or https URL under 2048 characters');
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new BadRequestException('website must be an http or https URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new BadRequestException('website must be an http or https URL without credentials');
    return url.toString();
  }

  private requiredText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new BadRequestException(`${label} is required and must be at most ${maxLength} characters`);
    return value.trim();
  }

  private optionalText(value: unknown, maxLength: number): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.trim().length > maxLength) throw new BadRequestException(`Text must be at most ${maxLength} characters`);
    return value.trim() || null;
  }

  private optionalId(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new BadRequestException('Invalid relation id');
    return value.trim();
  }

  private requiredVersion(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new BadRequestException('expectedVersion must be a positive integer');
    return value as number;
  }

  private requiredOperationId(value: unknown): string {
    return this.requiredText(value, 'operationId', 200);
  }

  private assertAllowedFields(input: Record<string, unknown>, allowed: string[]) {
    for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new BadRequestException(`Unsupported field ${key}`);
  }

  private async resolveOne(accountId: string, messageId: string, email: string, _displayName: string): Promise<'matched' | 'unresolved'> {
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.emailMessage.findUnique({
        where: { id: messageId },
        select: { contactId: true, contactResolutionStatus: true },
      });
      if (!message || message.contactId || message.contactResolutionStatus !== 'unresolved') return 'matched';
      const mapping = await tx.contactEmail.findUnique({
        where: { email }, select: { verified: true, contact: { select: { id: true, companyId: true, status: true, mergedIntoId: true } } },
      });
      if (!mapping || mapping.contact.status !== 'confirmed' || mapping.contact.mergedIntoId) {
        await tx.emailMessage.updateMany({
          where: { id: messageId, mailAccountId: accountId, contactId: null, contactResolutionStatus: 'unresolved' },
          data: { contactResolutionReason: 'Sender address is not registered to an active manual contact', companyResolutionReason: 'No company association was attempted' },
        });
        return 'unresolved';
      }
      await tx.emailMessage.updateMany({
        where: { id: messageId, mailAccountId: accountId, contactId: null, contactResolutionStatus: 'unresolved' },
        data: {
          contactId: mapping.contact.id,
          companyId: mapping.contact.companyId,
          contactResolutionStatus: 'matched',
          contactResolutionConfidence: 1,
          contactResolutionReason: mapping.verified ? 'Exact match to a user-registered contact email' : 'Exact match to a manually registered contact email',
          companyResolutionReason: mapping.contact.companyId ? 'Company comes from the user-selected contact relationship' : 'Contact has no manually selected company',
        },
      });
      return 'matched';
    });
  }

  private senderAddresses(value: unknown): Array<{ name: string; address: string }> {
    if (!Array.isArray(value)) return [];
    const results = new Map<string, string>();
    for (const item of value as SenderAddress[]) {
      if (typeof item?.address !== 'string') continue;
      const address = item.address.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) continue;
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 200) : '';
      results.set(address, name || address);
    }
    return [...results].map(([address, name]) => ({ address, name }));
  }

  private normalizeEmail(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException('A valid email address is required');
    const email = normalizeEmail(value);
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required');
    }
    return email;
  }

  private normalizeDomain(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException('Company domain must be a valid DNS name');
    const domain = value.trim().toLowerCase().replace(/\.$/, '');
    if (domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      throw new BadRequestException('Company domain must be a valid DNS name');
    }
    return domain;
  }

  private async account() {
    const email = this.config.get<string>('IMAP_EMAIL');
    if (!email || !this.config.get<string>('IMAP_HOST')) {
      throw new ServiceUnavailableException({ code: 'IMAP_NOT_CONFIGURED', message: 'IMAP is not configured' });
    }
    const account = await this.prisma.mailAccount.findUnique({ where: { email }, select: { id: true } });
    if (!account) throw new ServiceUnavailableException({ code: 'IMAP_ACCOUNT_NOT_READY', message: 'IMAP account is not ready' });
    return account;
  }

  private isUniqueConflict(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
  }
}
