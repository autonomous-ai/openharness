/**
 * The Orca plugin's own loop, outside Orca (dialStream.e2e.ts): each state it tells is a JSON line on stdout, each log
 * line a line on stderr. A script, not a module: vitest cannot load the plugin's files, whose tsconfig extends one that
 * Orca generates, and in a process of its own `nodeInputs()` reads only the home and PATH the test hands it.
 *
 * Each line of stdin is what Orca hands `front()`: the worktree on screen's terminal ids as a JSON array, or null; or
 * `{"terminals":[…]|null,"workspace":"…"}`, those ids with Orca's id of that worktree, as the worker hands both from
 * `workspace.changed`. Its end stops the loop. No exit and no signal handler: the process ending by itself, with code 0,
 * says `stop()` left no stream, send, watcher or timer.
 */
import { startDial } from '../../../plugins/harness-device-orca/src/dial.ts'
import { nodeInputs } from '../../../plugins/harness-device-orca/src/inputs.ts'

const dial = startDial(nodeInputs(), {
  changed: (state) => process.stdout.write(`${JSON.stringify(state)}\n`),
  log: (line) => process.stderr.write(`${line}\n`),
})
let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  const lines = (rest + chunk).split('\n')
  rest = lines.pop()!
  for (const line of lines) {
    const told = JSON.parse(line) as string[] | null | { terminals: string[] | null; workspace?: string | null }
    if (told === null || Array.isArray(told)) dial.front(told)
    else dial.front(told.terminals, told.workspace)
  }
})
process.stdin.once('end', () => { void dial.stop() })
