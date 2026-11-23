/**
 * A herdr pane (docs/specs/2026-11-15-device-host-adapter.md, docs/specs/2026-11-16-device-herdr.md): a tap focuses its
 * agent by `herdr agent focus`, then the app around herdr comes forward as every app does. The pane id came from a hook
 * or from herdr, so it is checked against its form before the command, which runs with no shell.
 *
 * A tap stays the command on every platform: one way to focus. The dial's words go over herdr's socket, or on Windows
 * its pipe (herdrClient.ts), so this adapter types while that socket, or the pipe's marker, is there. It comes before
 * Orca's: herdr inside an Orca terminal takes the words into the agent's own pane, where Orca would type into whichever
 * pane herdr has in front.
 *
 * A rest runs the same command, only while the app holding the pane's herdr client is in front: the pane id carries
 * that app when observed.ts found it (`w1:p1:terminal-app`), and every verb takes the bare herdr id from it.
 *
 * A tap, a rest and the words take turns per pane, as Orca's switch and send do (orca.ts). The turn is held here, as
 * this file alone holds both the command and the client, and the herdr source's words come through it too: its bare
 * id and the id with its app share one turn.
 */
import { type HostAdapter, oncePerCaller, type Pane, type Place } from './adapter.js'
import { HERDR_PANE, HERDR_PANE_FORM, herdrPaneKey, type HerdrClient, type HerdrPrompt } from './herdrClient.js'
import { APP_IDS } from './hostDetect.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

export interface HerdrAdapterDeps extends OrcaDeps {
  client: Pick<HerdrClient, 'prompt' | 'socketStamp' | 'binary'>
  /** The app in front, which a rest asks for. */
  front(): string | undefined
  log(line: string): void
}

/** The bare herdr pane id (`HERDR_PANE`), then the app holding its client when the id carries one. */
const PANE_WITH_APP = new RegExp(`^(${HERDR_PANE_FORM})(?::([a-z-]{1,32}))?$`)
// A pane herdr did not make the agent's terminal for: it only holds the agent, and its id carries no app.
const HELD = 'held:'

function paneParts(pane: Pane): { id: string; app?: string; held?: true } | undefined {
  if (pane.id.startsWith(HELD)) {
    const id = pane.id.slice(HELD.length)
    return HERDR_PANE.test(id) ? { id, held: true } : undefined
  }
  const match = PANE_WITH_APP.exec(pane.id)
  if (!match) return undefined
  const [, id, app] = match
  if (app === undefined) return { id }
  return APP_IDS.includes(app) ? { id, app } : undefined
}

export interface HerdrAdapter extends HostAdapter {
  paneKey(pane: Pane): string
  /** The dial's words for that pane, in the pane's turn with a focus: the herdr source's door too (herdrSource.ts). */
  prompt(paneId: string, kind: string, text: string): Promise<HerdrPrompt>
}

export function createHerdrAdapter(deps: HerdrAdapterDeps): HerdrAdapter {
  // Per pane, the focus under way, which a second tap joins, and the words under way, beside which more are busy.
  const focusing = new Map<string, Promise<boolean>>()
  const prompting = new Map<string, Promise<HerdrPrompt>>()
  // A herdr release whose server or client runs under another name would leave every herdr pane held: the log shows it.
  const sayHeld = oncePerCaller((line) => deps.log(line), '[device] herdr · held')

  /** `herdr agent focus` for a bare pane id, in that pane's turn: a second joins the one under way, and words under way
   *  go first. */
  const turn = (id: string): Promise<boolean> => {
    const under = focusing.get(id)
    if (under) return under
    // herdr's zip on Windows puts it on no PATH: there the herdr that wrote the marker runs the command.
    const herdr = deps.onPath('herdr') ?? deps.client.binary()
    if (!herdr) return Promise.resolve(false)
    const command = async () => (await deps.run(herdr, ['agent', 'focus', id], RUN_TIMEOUT_MS)).code === 0
    const typing = prompting.get(id)
    const run = (typing ? typing.then(command) : command()).finally(() => focusing.delete(id))
    focusing.set(id, run)
    return run
  }

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
      if (!id || !HERDR_PANE.test(id)) return undefined
      // A terminal, an editor or a multiplexer started in a herdr pane keeps HERDR_PANE_ID, and words sent to that pane
      // land at its prompt: only a pane herdr made the agent's terminal for takes words. Any other only focuses. Windows
      // reads no maker (no `ps`): there the pane stays the agent's.
      if (deps.platform !== 'win32' && place.ptyOwner !== 'herdr') {
        if (place.ptyOwner !== undefined) sayHeld(place.pid)
        return { adapter: 'herdr', id: `${HELD}${id}`, held: true }
      }
      const app = place.outer && APP_IDS.includes(place.outer.app) ? `:${place.outer.app}` : ''
      return { adapter: 'herdr', id: `${id}${app}` }
    },
    canFocus: () => true,
    async focus(pane) {
      const parts = paneParts(pane)
      return parts ? turn(parts.id) : false
    },
    canShow(pane) {
      const app = paneParts(pane)?.app
      return app !== undefined && app === deps.front()
    },
    async show(pane) {
      const parts = paneParts(pane)
      return parts && !parts.held && (await turn(parts.id)) ? 'ok' : 'failed'
    },
    async type(pane, text, engine) {
      const parts = paneParts(pane)
      return !!parts && !parts.held && (await prompt(parts.id, engine, text)).outcome === 'sent'
    },
    // A daemon started by launchd or systemd may not have the shell's XDG_CONFIG_HOME, and so no socket where herdr
    // listens: the words then skip herdr, and no other app types into a multiplexer's pane (orca.ts), so the agent's
    // voice is its mod's or the Codex queue's alone.
    canType: () => deps.client.socketStamp() !== undefined,
    paneKey: (pane) => herdrPaneKey(paneParts(pane)?.id ?? pane.id),
    prompt,
  }
}
