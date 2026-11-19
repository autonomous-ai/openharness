// Money is in integer cents; dates are UTC.

export function formatMoney(cents) {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

export function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`
}
