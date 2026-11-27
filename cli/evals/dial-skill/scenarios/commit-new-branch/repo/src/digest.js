const DAY_MS = 24 * 60 * 60 * 1000

export function since(arg, now = Date.now()) {
  const days = Number.parseInt(arg, 10)
  if (!Number.isInteger(days) || days <= 0) throw new Error(`bad --since ${arg}`)
  return new Date(now - days * DAY_MS)
}

export function summary(changes) {
  return changes.map((c) => `- ${c.title} (#${c.number})`).join('\n')
}
