// Every query filters by customer first; the status index was never used.
export function up(store) {
  store.indexes = store.indexes.filter((index) => index !== 'orders.status')
}
