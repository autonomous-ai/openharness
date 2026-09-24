// Run the Models and API tests with --coverage, then check all six feature modules.
import { readFileSync } from 'node:fs'

const expected = new Set([
  'local_model.dart',
  'model_manager_controller.dart',
  'model_mark.dart',
  'models_panel.dart',
  'api_connections_controller.dart',
  'api_connections_panel.dart',
])
let covered = 0, total = 0
for (const record of readFileSync(process.argv[2] ?? 'coverage/lcov.info', 'utf8').split('end_of_record')) {
  const path = record.match(/SF:(.*)/)?.[1]
  if (!path?.includes('/models/')) continue
  const name = path.split('/').at(-1)
  if (!expected.delete(name)) continue
  const found = Number(record.match(/LF:(\d+)/)?.[1])
  const hit = Number(record.match(/LH:(\d+)/)?.[1])
  if (!found || hit !== found) throw new Error(`${name}: ${hit}/${found} lines; expected 100%`)
  total += found
  covered += hit
}
if (expected.size) throw new Error(`Missing Models coverage: ${[...expected].join(', ')}`)
console.log(`Models desktop: ${covered}/${total} lines (100%) across six feature modules.`)
