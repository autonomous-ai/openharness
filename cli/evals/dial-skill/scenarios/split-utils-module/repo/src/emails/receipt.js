import { displayName } from '../customers/profile.js'
import { formatCents, titleCase, truncate } from '../utils.js'

export function receiptSubject(customer, order) {
  return truncate(`Thanks, ${displayName(customer)}: ${titleCase(order.items[0].name)} and more`, 48)
}

export function receiptTotal(order) {
  return `You paid ${formatCents(order.paidCents)}`
}
