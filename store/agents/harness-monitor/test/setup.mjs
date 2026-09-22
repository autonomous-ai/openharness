/**
 * Every test process gets its own config and state directories.
 *
 * The rules and tickets live in the person's real `~/.config/harness/` and `~/.harness/monitor/`. A test
 * that forgot to redirect them once wrote fake pins and a fake ticket into a real machine's files — so
 * the redirect is not left to each test to remember. It happens here, before any module loads, and the
 * real paths are refused outright if anything still reaches for them.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'harness-monitor-test-'))
process.env.HARNESS_MONITOR_CONFIG = join(root, 'config', 'policy.jsonc')
process.env.HARNESS_MONITOR_STATE = join(root, 'state')
process.env.HARNESS_MONITOR_TEST_ROOT = root

const real = [join(homedir(), '.config', 'harness'), join(homedir(), '.harness', 'monitor')]
export function assertNotReal(path) {
  for (const dir of real) if (String(path).startsWith(dir)) throw new Error(`A test reached a real path: ${path}`)
}
assertNotReal(process.env.HARNESS_MONITOR_CONFIG)
assertNotReal(process.env.HARNESS_MONITOR_STATE)
