import { readFileSync } from 'node:fs'
import { invoiceTotals } from '../src/invoice.js'

const [region, date] = process.argv.slice(2)
if (!region || !date) {
  console.error('usage: npm run preview -- <region> <invoice date>')
  process.exit(2)
}
const order = JSON.parse(readFileSync(new URL('../examples/order.json', import.meta.url), 'utf8'))
try {
  const { net, tax, total } = invoiceTotals(order, region, date)
  console.log(`net ${net}  tax ${tax}  total ${total}  (cents, ${region}, ${date})`)
} catch (error) {
  console.error(`error: ${error.message}`)
  process.exit(1)
}
