export function buildUidSearchRange(afterUid: number, targetUid: number): string | null {
  if (targetUid <= afterUid) return null;
  return `${Math.max(1, afterUid + 1)}:${targetUid}`;
}

export function nextCheckpointUid(hasMore: boolean, pageLastUid: number, targetUid: number): number {
  return hasMore ? pageLastUid : targetUid;
}

export function uidValidityChanged(current: bigint | null, received: bigint): boolean {
  return current !== null && current !== received;
}
