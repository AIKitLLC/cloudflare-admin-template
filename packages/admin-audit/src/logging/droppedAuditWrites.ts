let droppedAuditWrites = 0

/** How many audit inserts have been dropped since this isolate started. */
export function droppedAuditWriteCount(): number {
  return droppedAuditWrites
}

export function noteDroppedAuditWrite(): number {
  droppedAuditWrites += 1
  return droppedAuditWrites
}
