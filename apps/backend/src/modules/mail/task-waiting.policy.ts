export type WaitingTaskSnapshot = {
  status: string;
  waitingOn: string;
  waitingSince: Date | null;
};

export function nextWaitingSince(current: WaitingTaskSnapshot, next: { status?: string; waitingOn?: string }, now = new Date()) {
  const status = next.status ?? current.status;
  const waitingOn = next.waitingOn ?? current.waitingOn;
  if (status !== 'waiting' || waitingOn === 'none') return null;
  if (current.status !== 'waiting' || current.waitingOn !== waitingOn || !current.waitingSince) return now;
  return current.waitingSince;
}
