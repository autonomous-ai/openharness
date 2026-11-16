/**
 * The Orca plugin's own loop, outside Orca (dialStream.e2e.ts): each state it tells is a JSON line on stdout, each log
 * line a line on stderr. A script, not a module: vitest cannot load the plugin's files, whose tsconfig extends one that
 * Orca generates, and in a process of its own `nodeInputs()` reads only the home and PATH the test hands it.
 *
 * Stdin is read only to hold the process open; its end stops the loop. No exit and no signal handler: the process
 * ending by itself, with code 0, says `stop()` left no stream, watcher or timer.
 */
import { startDial } from '../../../plugins/harness-device-orca/src/dial.ts'
import { nodeInputs } from '../../../plugins/harness-device-orca/src/inputs.ts'

const dial = startDial(nodeInputs(), {
  changed: (state) => process.stdout.write(`${JSON.stringify(state)}\n`),
  log: (line) => process.stderr.write(`${line}\n`),
})
process.stdin.resume()
process.stdin.once('end', () => { void dial.stop() })
