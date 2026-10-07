export type ImportanceTriageStatus = 'high' | 'urgent' | 'quiet' | 'review';

export function decideImportanceTriage(
  result: { importance: string; intent: string; confidence: number; review_required: boolean },
  minimumConfidence = 0.75,
): ImportanceTriageStatus {
  if (!Number.isFinite(result.confidence) || result.confidence < minimumConfidence || result.review_required || result.importance === 'uncertain' || result.intent === 'uncertain') return 'review';
  const actionableIntent = ['customer_inquiry', 'materials_request', 'reply_request', 'important_change', 'deadline'].includes(result.intent);
  if (!actionableIntent || result.intent === 'non_actionable' || result.intent === 'routine') return 'quiet';
  return result.importance === 'urgent' ? 'urgent' : 'high';
}

export function retryImportanceTriage(attempts: number, maxAttempts: number): { status: 'pending' | 'failed'; delaySeconds: number } {
  if (attempts >= maxAttempts) return { status: 'failed', delaySeconds: 0 };
  return { status: 'pending', delaySeconds: Math.min(900, 30 * 2 ** Math.max(0, attempts - 1)) };
}
