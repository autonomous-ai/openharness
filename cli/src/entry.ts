#!/usr/bin/env node
/**
 * The bundle's entry (build-bundle.mjs): which process this is decides what it loads.
 *
 * Every daemon process runs the one `cli.js` the updater downloads and swaps, and every one used to
 * evaluate all of it at start: harnessd's master, each service in its own process and the CLI alike.
 * Measured from the bundle at idle on 2026-10-05, the master took 160 MiB resident and each service 115
 * to 160, so isolating the services cost more memory than everything else the daemon does. Here the
 * master and the services load only their own modules: esbuild, bundling without code splitting, turns
 * each dynamic import below into a module initialised the first time it is imported, so the code a
 * process never imports is parsed but never run. Everything else, the core (`__run`) included, is the
 * CLI as it always was.
 *
 * Nothing heavy may be imported statically here: it would be evaluated by every process.
 */
import { fileURLToPath } from 'node:url'

const [, , command, name] = process.argv
if (command === '__harnessd') {
  // This file is the bundle: the master starts the core from it, as cli.ts's own `SCRIPT_PATH` names it
  // for a master started from the sources, and itself and the services from the lean bundle it carries.
  (await import('./masterProcess.js')).startMasterFromBundle(fileURLToPath(import.meta.url))
} else if (command === '__harnessd-probe') {
  process.exitCode = (await import('./masterProcess.js')).probeThisMaster()
} else if (command === '__service') {
  await (await import('./serviceProcess.js')).startServiceProcess(name)
} else {
  await import('./cli.js')
}
