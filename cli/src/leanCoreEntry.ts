/**
 * The core's entry in the lean bundle (harnessd/leanBundle.ts `LEAN_CORE_ENTRY`): the core's own code,
 * and nothing else.
 *
 * Started on the whole cli.js, the core parsed every command of the CLI, every service's code and the
 * master's. Built apart from leanEntry.ts, and not as one more of its entries, because a build splits
 * the code its entries share into files they all load, each holding what any of them uses: built
 * together, the master and every service loaded the parts of the files they share that only the core
 * uses, Node's http and net among them, and paid about 5 MiB each for it, which the core's own saving
 * did not cover (measured 2026-10-06). Built apart, the master and the services load exactly what they
 * did before, and the core loads only its own files (`core-*`).
 *
 * Started from here only by a master that read this bundle out of cli.js and says which
 * (harnessd/master.ts). To everything the core hands on, its script is that cli.js, never this file: the
 * hooks it installs find notify.mjs beside it, the CLI it writes into agents' panes runs commands this
 * file does not have (lib/daemonCommand.ts reads it as process.argv[1]), and a successor it starts on an
 * update runs it. Without it this core cannot know the CLI, and dies before it beats: its master then
 * starts it from cli.js (harnessd/leanServices.ts).
 */
import { LEAN_CORE_SCRIPT_ENV } from './harnessd/protocol.js'

const [, , command] = process.argv
const cli = process.env[LEAN_CORE_SCRIPT_ENV]
if (command !== '__run') {
  console.error(`[harnessd] the lean bundle's core entry runs the core (__run); ${command ?? 'nothing'} is the CLI's (cli.js)`)
  process.exit(2)
} else if (!cli) {
  console.error('[harnessd] the lean bundle runs a core only for the cli.js its master read it from, which hands over its path')
  process.exit(2)
} else {
  delete process.env[LEAN_CORE_SCRIPT_ENV]
  process.argv[1] = cli
  ;(await import('./coreProcess.js')).startCoreProcess(cli)
}
