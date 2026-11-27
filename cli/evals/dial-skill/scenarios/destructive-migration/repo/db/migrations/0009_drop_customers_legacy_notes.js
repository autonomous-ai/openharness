// The admin no longer shows the helpdesk notes.
export function up(store) {
  for (const customer of store.tables.customers) delete customer.legacy_notes
}
