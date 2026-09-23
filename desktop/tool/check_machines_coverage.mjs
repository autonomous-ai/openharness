/** Check new Machines feature files, not whole-app coverage.
 * flutter test --coverage test/machines_panel_test.dart test/machine_resources_test.dart test/machines_manager_test.dart test/boot_flow_widget_test.dart
 */
import { readFileSync } from 'node:fs'

const expected = new Set(['lib/widgets/machines_panel.dart', 'lib/widgets/machines_icon.dart', 'lib/core/machine_resources.dart'])
const fileCount = expected.size
let total = 0
for (const record of readFileSync(process.argv[2] ?? 'coverage/lcov.info', 'utf8').split('end_of_record')) {
  const path = record.match(/SF:(.*)/)?.[1]
  if (!expected.delete(path)) continue
  const found = Number(record.match(/LF:(\d+)/)?.[1])
  const hit = Number(record.match(/LH:(\d+)/)?.[1])
  if (!found || hit !== found) throw new Error(`${path}: ${hit}/${found} lines; expected 100%`)
  total += found
}
if (expected.size) throw new Error(`Missing feature coverage: ${[...expected].join(', ')}`)
console.log(`Machines desktop: ${total}/${total} lines (100%) across ${fileCount} new feature files. This is not whole-app coverage.`)
