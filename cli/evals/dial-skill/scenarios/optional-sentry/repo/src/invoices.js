const INVOICES = [
  { id: 'inv_1001', customer: 'Ada', cents: 12000, status: 'paid' },
  { id: 'inv_1002', customer: 'Grace', cents: 4550, status: 'open' },
  { id: 'inv_1003', customer: 'Linus', cents: 9999, status: 'void' },
]

export function listInvoices({ status } = {}) {
  return INVOICES.filter((invoice) => status === undefined || invoice.status === status)
}
