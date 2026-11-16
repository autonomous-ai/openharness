// The plugin's worker: Orca starts it as the person running Orca. It runs the loop on Node's own inputs and tells the
// panel and the status bar item each change of the dial's state. It is read only.
import type { OrcaWorkerApi } from 'orca/worker'
import { startDial } from './dial'
import { nodeInputs, type DialInputs } from './inputs'
import type { DialState } from './protocol'

let stop: () => Promise<void> = async () => {}

// The wait before an update Orca refused for now is sent again, when Orca names none.
const RETRY_MS = 1_000

type BarItem = { id: 'dial'; visible: boolean; text?: string }

/** The loop wired to Orca: `dial.get`, `dial.changed`, the status bar item and the log. Returns its stop. */
export function wire(orca: OrcaWorkerApi, inputs: DialInputs): () => Promise<void> {
  let barRefused = false
  let latest: BarItem | null = null
  let cancelRetry = () => {}

  function showBar(state: DialState): void {
    latest = state.state === 'attached' ? { id: 'dial', visible: true, text: state.agent?.name ?? 'Dial' } : { id: 'dial', visible: false }
    send(latest, true)
  }

  // The item is only ever changed by the next one, so a dropped update would stay wrong: one refused for now (rate
  // limited) is sent again once, if it is still the latest.
  function send(item: BarItem, retry: boolean): void {
    orca.host.call('statusBar.update', item).catch((error: { retryable?: boolean; retryAfterMs?: number }) => {
      if (retry && error.retryable) {
        if (item !== latest) return
        cancelRetry()
        cancelRetry = inputs.after(error.retryAfterMs ?? RETRY_MS, () => {
          if (item === latest) send(item, false)
        })
        return
      }
      // An Orca without the status bar refuses each update: said once, and the panel is still told.
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
    // A refusal that arrives after this sends nothing again.
    latest = null
    cancelRetry()
    await dial.stop()
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  stop = wire(orca, nodeInputs())
}

export async function deactivate(): Promise<void> {
  await stop()
}
