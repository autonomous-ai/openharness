import { renderTable } from '../vendor/tablekit/index.js'
import { ORDERS } from './sales.js'

// One row per region, in the order regions first appear.
export function buildReport({ region } = {}) {
  const byRegion = new Map()
  for (const order of ORDERS) {
    if (region !== undefined && order.region !== region) continue
    const row = byRegion.get(order.region) ?? { region: order.region, orders: 0, cents: 0 }
    row.orders += 1
    row.cents += order.cents
    byRegion.set(order.region, row)
  }
  return [...byRegion.values()]
}

export function renderReport(rows) {
  return renderTable(
    [
      { key: 'region', title: 'Region' },
      { key: 'orders', title: 'Orders', align: 'right' },
      { key: 'revenue', title: 'Revenue', align: 'right' },
    ],
    rows.map((row) => ({ ...row, revenue: (row.cents / 100).toFixed(2) })),
  )
}
