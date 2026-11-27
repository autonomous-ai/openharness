import { applyDiscount, daysBetween } from '../utils.js'

// A customer of a year or more gets 10 % off.
export function loyaltyPrice(customer, cents, today) {
  return daysBetween(customer.since, today) >= 365 ? applyDiscount(cents, 10) : cents
}
