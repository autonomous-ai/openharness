// Strings

export function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function titleCase(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// Dates, always in UTC so a report reads the same on every machine.

const DAY_MS = 24 * 60 * 60 * 1000

export function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS)
}

export function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS)
}

// Money, in whole cents so sums never drift.

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function sumCents(amounts) {
  return amounts.reduce((total, cents) => total + cents, 0)
}

export function applyDiscount(cents, percent) {
  return Math.round((cents * (100 - percent)) / 100)
}
