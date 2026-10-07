export type ActiveTaskState = {
  status: string;
  kind: string;
  ownerType: string | null;
  waitingOn: string;
  deadlineAt: Date | null;
};

export function deriveProjectState(tasks: ActiveTaskState[]) {
  const parties = [...new Set(tasks.map((task) =>
    task.status === 'waiting' && task.waitingOn !== 'none' ? task.waitingOn : task.ownerType,
  ).filter((party): party is string => typeof party === 'string' && party !== 'none'))].sort();
  const waitingOn = parties.length === 0 ? 'none' : parties.length > 1 || parties.includes('mixed') ? 'mixed' : parties[0]!;
  const waitingParties = parties.filter((party) => party !== 'mixed');
  const replyRequired = tasks.some((task) =>
    ['reply', 'confirmation'].includes(task.kind) && task.ownerType === 'us'
    && !(task.status === 'waiting' && ['customer', 'third_party'].includes(task.waitingOn)),
  );
  const followUpAt = tasks.map((task) => task.deadlineAt).filter((date): date is Date => date !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return { waitingOn, waitingParties, replyRequired, followUpAt };
}
