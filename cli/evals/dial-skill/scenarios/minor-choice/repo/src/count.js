export const LEVELS = ['INFO', 'WARN', 'ERROR']

// A log line reads "<timestamp> <LEVEL> <message>"; lines of any other shape are not counted.
export function countLevels(text, { errorsOnly = false } = {}) {
  const levels = errorsOnly ? ['ERROR'] : LEVELS
  const counts = Object.fromEntries(levels.map((level) => [level, 0]))
  for (const line of text.split('\n')) {
    const level = line.split(' ')[1]
    if (level in counts) counts[level]++
  }
  return counts
}
