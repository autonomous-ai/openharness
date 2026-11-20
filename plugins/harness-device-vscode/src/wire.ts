// The extension's parts put together. Nothing of `vscode` is loaded here (extension.ts passes it), so tests run it on a
// fake API.
import { windowFacade } from './facade'
import type { LoopInputs } from './inputs'
import { startLoop } from './loop'
import type { VscodeApi } from './vscodeApi'

/** The loop on that API and those inputs, its lines in an output channel named Harness Device. Returns its stop. */
export function wire(api: VscodeApi, inputs: LoopInputs): () => Promise<void> {
  // The loop would not start there either, but the window's listeners and the channel are made before it is asked.
  if (api.env.remoteName !== undefined) return () => Promise.resolve()
  const window = windowFacade(api)
  const channel = api.window.createOutputChannel('Harness Device')
  // A change of state is told in its own line already.
  const loop = startLoop(inputs, window, { changed: () => {}, log: (line) => channel.appendLine(line) })
  return async () => {
    await loop?.stop()
    window.dispose()
    channel.dispose()
  }
}
