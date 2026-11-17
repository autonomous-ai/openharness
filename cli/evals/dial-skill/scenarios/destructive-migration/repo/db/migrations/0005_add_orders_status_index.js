export function up(store) {
  store.indexes.push('orders.status')
}
