import * as utils from '../utils.js'

// Standard parcels arrive in five days, express in two.
const TRANSIT_DAYS = { standard: 5, express: 2 }

export function estimatedArrival(order) {
  return utils.formatDate(utils.addDays(order.placedAt, TRANSIT_DAYS[order.shipping]))
}
