export function keepLog(log, nowMs) {
  if (!log.completed) {
    return log;
  }
  const ageMs = nowMs - log.completedAtMs;
  if (ageMs >= 14 * 86400000) {
    return null;
  }
  return log;
}
