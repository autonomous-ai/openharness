// Deprecated: the old formatter, kept until every report uses src/format/index.js.

export function money(cents) {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function day(date) {
  return date.toISOString().slice(0, 10)
}

export function pct(ratio) {
  return `${(ratio * 100).toFixed(1)}%`
}
