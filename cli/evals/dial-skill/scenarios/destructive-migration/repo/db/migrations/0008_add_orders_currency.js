export function up(store) {
  for (const order of store.tables.orders) order.currency = 'EUR'
}
