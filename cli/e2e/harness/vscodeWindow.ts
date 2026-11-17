/**
 * Harness's VS Code extension's own loop, outside VS Code (dialVscode.e2e.ts), over a fake window: each line on stdin is
 * a `Partial<WindowState>` the window takes, as VS Code tells it of its terminals; each line on stdout is
 * `{"state":…}`, `{"show":<pid>}` or `{"log":…}`. A script, not a module, as pluginDial.ts is: in a process of its own
 * `nodeInputs()` reads only the home and PATH the test hands it.
 *
 * Stdin's end stops the loop. No exit and no signal handler: the process ending by itself, with code 0, says `stop()`
 * left no stream, watcher or timer.
 */
import { createInterface } from 'node:readline'
import { nodeInputs } from '../../../plugins/harness-device-vscode/src/inputs.ts'
import { startLoop } from '../../../plugins/harness-device-vscode/src/loop.ts'
import { fakeWindow } from '../../../plugins/harness-device-vscode/src/testing/fakeWindow.ts'

const say = (line: object): void => { process.stdout.write(`${JSON.stringify(line)}\n`) }

const fake = fakeWindow()
const loop = startLoop(nodeInputs(), {
  ...fake.window,
  show: (pid) => {
    say({ show: pid })
    return fake.window.show(pid)
  },
}, {
  changed: (state) => say({ state }),
  log: (line) => say({ log: line }),
})
createInterface({ input: process.stdin })
  .on('line', (line) => fake.set(JSON.parse(line)))
  .once('close', () => { void loop?.stop() })
