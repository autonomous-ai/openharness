/**
 * The core's process (`__run`), however it is started: from cli.js (entry.ts), from the lean bundle cli.js
 * carries (leanCoreEntry.ts) or from the sources (cli.ts). One start for all three, so a core started from the
 * lean bundle, which never loads cli.ts, starts exactly as one started from cli.js does.
 *
 * Its own module so the lean bundle can start the core on the core's own code: started on the whole
 * cli.js, the core parsed every command of the CLI, every service's code and the master's
 * (docs/design/2026-10-06-core-boundary-next.md, "The target, and its test").
 */
import { runCore } from './core/main.js'
import { ensureUtf8Locale } from './lib/childLocale.js'
import { ensureHnLauncher } from './lib/launchers.js'

/** Run the core, [scriptPath] being the CLI's own script (cli.js, or src/cli.ts from the sources). */
export function startCoreProcess(scriptPath: string): void {
  // What cli.ts does first for every command: a `ps` or `git` the core runs must not get mangled output.
  ensureUtf8Locale()
  // On entry to the installed bundle, a daemon handoff's included: machines installed before hn shipped
  // get it from whichever core runs first after the update (lib/launchers.ts).
  ensureHnLauncher(scriptPath)
  runCore(scriptPath)
}
