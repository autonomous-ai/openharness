import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const COLUMNS = ['invoice', 'customer_id', 'issued', 'amount', 'currency', 'status']

export function toCsv(invoices, month) {
  const rows = invoices.filter((invoice) => invoice.issued.startsWith(month))
  return [COLUMNS.join(','), ...rows.map((invoice) => COLUMNS.map((column) => invoice[column]).join(','))].join('\n') + '\n'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const month = process.argv[2]
  if (!/^\d{4}-\d{2}$/.test(month ?? '')) {
    console.error('usage: npm run export -- YYYY-MM')
    process.exit(1)
  }
  const invoices = JSON.parse(readFileSync('data/invoices.json', 'utf8'))
  mkdirSync('exports', { recursive: true })
  writeFileSync(`exports/invoices-${month}.csv`, toCsv(invoices, month))
  console.log(`exports/invoices-${month}.csv`)
}
