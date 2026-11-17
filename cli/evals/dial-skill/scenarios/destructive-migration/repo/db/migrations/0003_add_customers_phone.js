export function up(store) {
  for (const customer of store.tables.customers) customer.phone = null
}
