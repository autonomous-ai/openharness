// Run the resource picker tests with --coverage before checking these modules.
import { readFileSync } from 'node:fs'

const expected = new Set([
  'lib/models/model_search_catalog.dart',
  'lib/widgets/swarm_command_picker.dart',
  'lib/widgets/swarm_resource_preview.dart',
])
let total = 0
for (const record of readFileSync(process.argv[2] ?? 'coverage/lcov.info', 'utf8').split('end_of_record')) {
  const path = record.match(/SF:(.*)/)?.[1]
  const name = [...expected].find(name => path === name || path?.endsWith(`/${name}`))
  if (!name) continue
  expected.delete(name)
  const found = Number(record.match(/LF:(\d+)/)?.[1])
  const hit = Number(record.match(/LH:(\d+)/)?.[1])
  if (!found || hit !== found) throw new Error(`${name}: ${hit}/${found} lines; expected 100%`)
  total += found
}
if (expected.size) throw new Error(`Missing resource picker coverage: ${[...expected].join(', ')}`)
console.log(`Resource picker: ${total}/${total} lines (100%) across three new feature modules.`)
