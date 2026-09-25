// Run the desktop launch tests with --coverage before checking both complete modules.
import { readFileSync } from 'node:fs'

const expected = new Set([
  'lib/state/new_harness.dart',
  'lib/widgets/new_harness_form.dart',
])
let total = 0
for (const record of readFileSync(process.argv[2] ?? 'coverage/lcov.info', 'utf8').split('end_of_record')) {
  const path = record.match(/SF:(.*)/)?.[1]
  const name = [...expected].find(name => path === name || path?.endsWith(`/${name}`))
  if (!name) continue
  expected.delete(name)
  const found = Number(record.match(/LF:(\d+)/)?.[1])
  const hit = Number(record.match(/LH:(\d+)/)?.[1])
  const missing = [...record.matchAll(/^DA:(\d+),0$/gm)].map(match => match[1])
  if (!found || hit !== found || missing.length) {
    throw new Error(`${name}: ${hit}/${found} lines; expected 100%. Uncovered: ${missing.join(', ')}`)
  }
  console.log(`${name}: ${hit}/${found} lines (100%)`)
  total += found
}
if (expected.size) throw new Error(`Missing New Harness coverage: ${[...expected].join(', ')}`)
console.log(`New Harness: ${total}/${total} executable lines (100%) across the entire form and controller.`)
