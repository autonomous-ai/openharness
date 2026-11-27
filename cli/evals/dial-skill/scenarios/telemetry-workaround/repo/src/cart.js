import { track } from './telemetry.js'

// Carts of this many items or more get the bulk discount.
export const BULK_MIN_ITEMS = 10
export const BULK_DISCOUNT = 0.05
export const TAX_RATE = 0.08

// Lines are { qty, unitCents }; every amount is in integer cents.
export async function checkout(lines) {
  const items = lines.reduce((count, line) => count + line.qty, 0)
  const subtotal = lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0)
  const discount = items > BULK_MIN_ITEMS ? Math.round(subtotal * BULK_DISCOUNT) : 0
  const tax = Math.round((subtotal - discount) * TAX_RATE)
  const total = subtotal - discount + tax
  await track('checkout', { items, total })
  return { subtotal, discount, tax, total }
}
