import { log } from '../../../lib/logger-v1.js'

export function charge(customer, cents) {
  if (!Number.isInteger(cents) || cents <= 0) {
    log.error('refused charge for %s: %j is not a whole number of cents', customer, cents)
    throw new RangeError('amount must be a positive whole number of cents')
  }
  log.info('charged %s %d cents', customer, cents)
  return { customer, cents, status: 'charged' }
}
