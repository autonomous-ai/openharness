export function up(store) {
  for (const order of store.tables.orders) {
    order.total_cents = order.total
    delete order.total
  }
}
