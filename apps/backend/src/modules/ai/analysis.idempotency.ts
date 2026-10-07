export function inspectAnalysisIdempotency(existing: { sourceMessageId: string } | null, requestedMessageId: string) {
  if (!existing) return { action: 'run' as const };
  return existing.sourceMessageId === requestedMessageId
    ? { action: 'reuse' as const }
    : { action: 'conflict' as const };
}
