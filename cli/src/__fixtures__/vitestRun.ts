/**
 * Names this Vitest run for its workers' temporary folders (cli/vitest.tmpdir.ts), and removes those folders when the run ends.
 *
 * Runs going at once shared vw1, vw2… before, and each one's mkdtemp and rm there changed an ancestor of the others' fixtures:
 * three core gates ran at once on one Mac on 2026-11-10, and every run left its fixtures in vw1 for good (24,592 entries). This
 * process runs the whole run, and no other process running at the same time has its id. A run killed before its end leaves its
 * folders behind.
 */
import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function nameRun(): () => void {
  const base = tmpdir(), run = `v${process.pid.toString(36)}`
  // The workers start after this and inherit it.
  process.env.HARNESS_TEST_RUN = run
  return () => {
    for (const name of readdirSync(base)) {
      if (!name.startsWith(`${run}-`)) continue
      try { rmSync(join(base, name), { recursive: true, force: true }) }
      catch (error) { console.warn(`vitestRun.ts could not remove ${join(base, name)}: ${(error as NodeJS.ErrnoException).code ?? error}`) }
    }
  }
}
