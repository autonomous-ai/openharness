/**
 * A herdr pane (docs/specs/2026-11-15-device-host-adapter.md, docs/specs/2026-11-16-device-herdr.md): a tap focuses its
 * agent by `herdr agent focus`, then the app around herdr comes forward as every app does. The pane id came from a hook
 * or from herdr, so it is checked against its form before the command, which runs with no shell.
 *
 * A tap stays the command on every platform: one way to focus, and on Windows, where herdr's socket is a named pipe the
 * client does not speak, a tap is not lost. The dial's words go over herdr's socket (herdrClient.ts), so off Windows
 * this adapter types. It comes before Orca's: herdr inside an Orca terminal takes the words into the agent's own pane,
 * where Orca would type into whichever pane herdr has in front.
 *
 * A tap and the words take turns per pane, as Orca's switch and send do (orca.ts). The turn is held here, as this file
 * alone holds both the command and the client, and the herdr source's words come through it too.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { HERDR_PANE, herdrPaneKey, type HerdrClient, type HerdrPrompt } from './herdrClient.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

export interface HerdrAdapterDeps extends OrcaDeps { client: Pick<HerdrClient, 'prompt'> }

export interface HerdrAdapter extends HostAdapter {
  paneKey(pane: Pane): string
  /** The dial's words for that pane, in the pane's turn with a focus: the herdr source's door too (herdrSource.ts). */
  prompt(paneId: string, kind: string, text: string): Promise<HerdrPrompt>
}

export function createHerdrAdapter(deps: HerdrAdapterDeps): HerdrAdapter {
  // Per pane, the focus under way, which a second tap joins, and the words under way, beside which more are busy.
  const focusing = new Map<string, Promise<boolean>>()
  const prompting = new Map<string, Promise<HerdrPrompt>>()

  const prompt = (paneId: string, kind: string, text: string): Promise<HerdrPrompt> => {
    // Busy queues nothing: the dial asks again, never stacked behind.
    if (prompting.has(paneId)) return Promise.resolve({ outcome: 'busy' })
    const shown = focusing.get(paneId)
    const send = () => deps.client.prompt(paneId, kind, text)
    const run = (shown ? shown.then(send) : send()).finally(() => prompting.delete(paneId))
    prompting.set(paneId, run)
    return run
  }

  return {
    id: 'herdr',
    tap: 'before',
    paneOf(place: Place): Pane | undefined {
      const id = place.hints.HERDR_PANE_ID
      return id && HERDR_PANE.test(id) ? { adapter: 'herdr', id } : undefined
    },
    canFocus: () => true,
    async focus(pane) {
      if (!HERDR_PANE.test(pane.id)) return false
      const under = focusing.get(pane.id)
      if (under) return under
      const herdr = deps.onPath('herdr')
      if (!herdr) return false
      const command = async () => (await deps.run(herdr, ['agent', 'focus', pane.id], RUN_TIMEOUT_MS)).code === 0
      const typing = prompting.get(pane.id)
      const run = (typing ? typing.then(command) : command()).finally(() => focusing.delete(pane.id))
      focusing.set(pane.id, run)
      return run
    },
    ...(deps.platform === 'win32' ? {} : {
      type: async (pane: Pane, text: string, engine: string) => (await prompt(pane.id, engine, text)).outcome === 'sent',
    }),
    paneKey: (pane) => herdrPaneKey(pane.id),
    prompt,
  }
}
