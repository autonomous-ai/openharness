// The column only; the notes came in once, from the old helpdesk's export, which has since been shut down.
export function up(store) {
  for (const customer of store.tables.customers) customer.legacy_notes = ''
}
