export function normalizeResolverText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function reviewDedupeKey(entityType: string, entityId: string, reasonCode: string, sourceMessageId?: string | null): string {
  return [entityType, entityId, reasonCode, sourceMessageId ?? ''].join(':');
}

export function stableReviewProposal(value: unknown): string {
  const sort = (item: any): any => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    return item;
  };
  return JSON.stringify(sort(value));
}

export function nextReviewCycle(latest: { cycle: number; status: string; proposedChangeJson: unknown; confidence: number } | null, proposal: unknown, confidence: number) {
  if (!latest) return { action: 'create' as const, cycle: 1 };
  if (stableReviewProposal(latest.proposedChangeJson) === stableReviewProposal(proposal) && latest.confidence === confidence) {
    return { action: 'reuse' as const, cycle: latest.cycle };
  }
  if (latest.status === 'pending') return { action: 'update' as const, cycle: latest.cycle };
  return { action: 'create' as const, cycle: latest.cycle + 1 };
}

export function chooseMergeCompany(sourceCompanyId: string | null, targetCompanyId: string | null) {
  if (sourceCompanyId && targetCompanyId && sourceCompanyId !== targetCompanyId) return { ok: false as const, companyId: null };
  return { ok: true as const, companyId: targetCompanyId ?? sourceCompanyId };
}

export function planContactEmailMerge(sourceEmails: Array<{ id: string; email: string }>, targetEmails: string[]) {
  const target = new Set(targetEmails.map((email) => email.trim().toLowerCase()));
  const deleteIds: string[] = [];
  const moveIds: string[] = [];
  for (const email of sourceEmails) {
    (target.has(email.email.trim().toLowerCase()) ? deleteIds : moveIds).push(email.id);
  }
  return { deleteIds, moveIds };
}
