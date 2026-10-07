import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockCrmRelationshipWrites } from './crm-relation-lock';

/**
 * Serialize writes that create or move facts under a project with project
 * deletion. A deleted project keeps its history but cannot receive new facts.
 */
export async function lockProjectForWrite(tx: Prisma.TransactionClient, projectId: string) {
  await lockCrmRelationshipWrites(tx);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id"=${projectId} FOR UPDATE`);
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, status: true, version: true } });
  if (!project || project.status === 'deleted') throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
  return project;
}

export async function lockProjectsForWrite(tx: Prisma.TransactionClient, projectIds: Array<string | null | undefined>) {
  const ids = [...new Set(projectIds.filter((id): id is string => typeof id === 'string' && Boolean(id)))].sort();
  const projects: Array<Awaited<ReturnType<typeof lockProjectForWrite>>> = [];
  for (const id of ids) projects.push(await lockProjectForWrite(tx, id));
  return projects;
}

export async function assertCompanyAvailable(tx: Prisma.TransactionClient, companyId: string) {
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true, status: true } });
  if (!company || company.status === 'deleted') throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'Company not found' });
  return company;
}
