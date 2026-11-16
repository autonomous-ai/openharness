/**
 * Herdr (docs/plans/2026-11-16-herdr-app-design.md): the window of Herdr.app, whose terminals run in Herdr Core (hc,
 * hcClient.ts). A tap opens Herdr, then switches its window to the agent's terminal; a rest with Herdr in front switches
 * it alone; the dial's words go over hc's socket. macOS only: Herdr's window elsewhere is not tried.
 *
 * A tap opens Herdr first: hc keeps running when Herdr's window is closed, and the window must be up to switch. `open`
 * runs by its own path, so no `open` earlier on PATH runs instead, and `herdr-app` with no shell, each value one
 * argument. The address came from a hook or from hc, so it is held to hc's form again before either runs. Once `open`
 * came back Herdr is in front, so a tap whose switch fails is still a tap that came: a window still opening may not take
 * the switch yet, and the log says so.
 *
 * Words do not wait for a tap, nor a tap for words: hc types by address, whatever the window shows.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { HC_TERMINAL, hcPaneKey, type HcClient, type HcPrompt } from './hcClient.js'
import { APP_BUNDLES } from './hostDetect.js'
import { OPEN } from './open.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { PaneSwitch } from './types.js'

/** Herdr.app's own binary, which ~/.local/bin/herdr-app links to. */
export const HERDR_APP = '/Applications/Herdr.app/Contents/MacOS/Herdr'

export interface HerdrAppDeps extends OrcaDeps {
  client: Pick<HcClient, 'prompt' | 'socketStamp'>
  /** Herdr is the app in front. */
  inFront(): boolean
  /** Whether Herdr's window shows that terminal: the hc source lists it (hcSource.ts shows). */
  shows(address: string): boolean
  log(line: string): void
}

export interface HerdrAppAdapter extends HostAdapter {
  canShow(pane: Pane): boolean
  show(pane: Pane, agentId: string): Promise<PaneSwitch>
  paneKey(pane: Pane): string
  /** The dial's words for that terminal: the hc source's door too (hcSource.ts). */
  prompt(address: string, kind: string, text: string): Promise<HcPrompt>
  /** Where `herdr-app` is: on PATH, else Herdr.app's own binary. None: Herdr is not installed. */
  binary(): string | null
}

/** What a run did: whether Herdr is forward, and whether its window switched to the terminal. */
interface Run { forward: boolean; switched: boolean }

export function createHerdrAppAdapter(deps: HerdrAppDeps): HerdrAppAdapter {
  const mac = deps.platform === 'darwin'
  // Per terminal, the run under way, which a second tap or a rest joins: a swipe's rest and a tap just after it switch
  // to the same terminal.
  const running = new Map<string, Promise<Run>>()
  // Per terminal, the words under way: two transcripts typed at once would mix in the agent's prompt.
  const prompting = new Set<string>()

  const binary = (): string | null => deps.onPath('herdr-app') ?? (deps.exists(HERDR_APP) ? HERDR_APP : null)

  const once = (address: string, start: () => Promise<Run>): Promise<Run> => {
    const under = running.get(address)
    if (under) return under
    const run = start().finally(() => running.delete(address))
    running.set(address, run)
    return run
  }

  // The line names no terminal: hc's addresses are a person's agents.
  const switchTo = async (address: string): Promise<boolean> => {
    const herdrApp = binary()
    const switched = herdrApp !== null
      && (await deps.run(herdrApp, ['do', 'agent.focus', '--terminal', address], RUN_TIMEOUT_MS)).code === 0
    if (!switched) deps.log('[herdr-app] focus · failed')
    return switched
  }

  const prompt = async (address: string, kind: string, text: string): Promise<HcPrompt> => {
    // Busy queues nothing: the dial asks again, never stacked behind.
    if (prompting.has(address)) return { outcome: 'busy' }
    prompting.add(address)
    try {
      return await deps.client.prompt(address, kind, text)
    } finally {
      prompting.delete(address)
    }
  }

  return {
    id: 'herdr-app',
    tap: 'instead',
    paneOf(place: Place): Pane | undefined {
      const id = place.hints.HC_TERMINAL_ID
      return mac && id && HC_TERMINAL.test(id) ? { adapter: 'herdr-app', id } : undefined
    },
    // Every hc terminal has HC_TERMINAL_ID, hidden `hc run` workers too, and the window shows those not.
    canFocus: (pane) => mac && deps.shows(pane.id),
    // Asked at each look: Herdr may have left the front since the last one.
    canShow: (pane) => mac && deps.inFront() && deps.shows(pane.id),
    async focus(pane) {
      if (!mac || !HC_TERMINAL.test(pane.id)) return false
      const run = await once(pane.id, async () => {
        if ((await deps.run(OPEN, ['-b', APP_BUNDLES.herdr], RUN_TIMEOUT_MS)).code !== 0) return { forward: false, switched: false }
        return { forward: true, switched: await switchTo(pane.id) }
      })
      return run.forward
    },
    async show(pane) {
      if (!mac || !HC_TERMINAL.test(pane.id)) return 'failed'
      // A rest runs only with Herdr in front (canShow), so a tap that joins it finds Herdr forward.
      const run = await once(pane.id, async () => ({ forward: true, switched: await switchTo(pane.id) }))
      return run.switched ? 'ok' : 'failed'
    },
    ...(mac ? {
      type: async (pane: Pane, text: string, engine: string) => (await prompt(pane.id, engine, text)).outcome === 'sent',
      canType: () => deps.client.socketStamp() !== undefined,
    } : {}),
    paneKey: (pane) => hcPaneKey(pane.id),
    prompt,
    binary,
  }
}
