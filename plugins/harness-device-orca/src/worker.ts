// The plugin's worker: Orca starts it as the person running Orca. It runs the loop on Node's own inputs and tells the
// panel and the status bar item each change of the dial's state. It is read only.
import type { OrcaWorkerApi } from 'orca/worker'
import { startDial } from './dial'
import { nodeInputs, type DialInputs } from './inputs'
import type { DialState } from './protocol'

let stop: () => Promise<void> = async () => {}

/** The loop wired to Orca: `dial.get`, `dial.changed`, the status bar item and the log. Returns its stop. */
export function wire(orca: OrcaWorkerApi, inputs: DialInputs): () => Promise<void> {
  let barRefused = false

  function showBar(state: DialState): void {
    const item = state.state === 'attached' ? { id: 'dial', visible: true, text: state.agent?.name ?? 'Dial' } : { id: 'dial', visible: false }
    // An Orca without the status bar refuses each update: said once, and the panel is still told.
    orca.host.call('statusBar.update', item).catch(() => {
      if (barRefused) return
      barRefused = true
      orca.log('dial: status bar unavailable')
    })
  }

  const dial = startDial(inputs, {
    changed(state) {
      orca.panels.post('dial.changed', state)
      showBar(state)
    },
    log: (line) => orca.log(line),
  })
  const handler = orca.panels.handle('dial.get', () => dial.state())
  showBar(dial.state())

  return async () => {
    handler.dispose()
    await dial.stop()
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  stop = wire(orca, nodeInputs())
}

export async function deactivate(): Promise<void> {
  await stop()
}
