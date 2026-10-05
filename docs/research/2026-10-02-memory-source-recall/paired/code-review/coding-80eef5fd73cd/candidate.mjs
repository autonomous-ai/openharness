export function keepLog(log, nowMs) {
  if (!log.completed) {
    return log;
  }
  const ageMs = nowMs - log.completedAtMs;
  const retentionMs = 14 * 86400000;
  if (ageMs >= retentionMs) {
    return null;
  }
  return log;
}
