/**
 * cmux (docs/plans/2026-11-17-dial-cmux-design.md): an agent in a cmux terminal, by the workspace and surface its hook
 * sent, and the cmux source's rows by theirs. macOS only, where cmux runs.
 *
 * A tap and a rest open `cmux://workspace/<w>/surface/<s>` (appLink.ts). The link needs no socket, so it works in
 * cmux's default mode; it goes to cmux alone by its bundle id, so cmux NIGHTLY, which registers the same scheme, never
 * gets it; and it brings cmux itself, opening it when it is closed.
 *
 * The dial's words go through cmux's own command line (cmuxCli.ts), only to a Claude Code or Codex agent, the only ones
 * whose prompt cmux reads, at an idle, empty prompt of the agent the dial means, and only in a mode that lets a process
 * outside cmux in. The mode is read when the words are said, so turning
 * Automation mode on works at once. Words do not wait for a tap, nor a tap for words: a paste goes to a surface by its
 * id, whatever cmux shows.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { createAppLink, type AppLinkDeps } from './appLink.js'
import {
  CMUX_AUTOMATION_OFF, cmuxPaneId, cmuxPaneKey, cmuxPaneOf, cmuxTakesWords, type CmuxClient, type CmuxPrompt,
} from './cmuxCli.js'
import { APP_BUNDLES, CMUX_UUID, inCmux } from './hostDetect.js'
import { CONTROL, MAX_TEXT } from './orca.js'
import type { PaneSwitch, TypeResult } from './types.js'

/** A pane's id, `<workspace>/<surface>`: checked again before every command. */
const CMUX_PANE = new RegExp(`^${CMUX_UUID}/${CMUX_UUID}$`)
/** The modes that let a process not started inside cmux use its socket. `password` would need a secret Harness never
 *  reads. */
const OPEN_MODES: ReadonlySet<string> = new Set(['automation', 'allowAll'])

/** `run`, `platform`, `inFront` (cmux is the app in front) and `bin` (the raw `HARNESS_OPEN_BIN`) are appLink.ts's. */
export type CmuxAppDeps = AppLinkDeps & {
  client: Pick<CmuxClient, 'mode' | 'inputState' | 'paste'>
  /** cmux is installed, as the last attach found it (devices.ts). */
  found(): boolean
  /** The kind of the agent the cmux source lists at that surface; none when it lists none there (CmuxSource.kindAt). */
  kindAt(surface: string): string | undefined
}

export interface CmuxAppAdapter extends HostAdapter {
  canShow(pane: Pane): boolean
  show(pane: Pane, agentId: string): Promise<PaneSwitch>
  paneKey(pane: Pane): string
  type(pane: Pane, text: string, engine: string): Promise<TypeResult>
  canType(pane: Pane): boolean
  /** The dial's words for that pane (`<workspace>/<surface>`): the cmux source's door too. */
  prompt(pane: string, kind: string, text: string): Promise<CmuxPrompt>
}

export function createCmuxAppAdapter(deps: CmuxAppDeps): CmuxAppAdapter {
  const mac = deps.platform === 'darwin'
  // Per surface, whatever the case of its id, the words under way: two transcripts pasted at once would mix in the
  // agent's prompt.
  const prompting = new Set<string>()

  // The four checks of the prompt, in order; the paste runs only once every one has said yes.
  const ask = async (workspace: string, surface: string, kind: string, line: string): Promise<CmuxPrompt> => {
    const mode = await deps.client.mode()
    // A mode that could not be read is not known to be off: the dial does not say to turn it on.
    if (mode === undefined) return 'no-answer'
    if (!OPEN_MODES.has(mode)) return 'automation-off'
    // The mode is the saved setting: a cmux that has not applied it yet refuses this read, and nothing is pasted.
    const input = await deps.client.inputState(surface)
    if (!input?.terminal || !input.agent) return 'no-answer'
    if (input.lifecycle === 'needsInput') return 'waiting'
    if (input.lifecycle === 'running' || input.state === 'draft' || input.state === 'dialog') return 'busy'
    if (input.lifecycle !== 'idle' || input.state !== 'empty' || input.blocksTyping) return 'no-answer'
    // Read last, just before the paste: the source may list another agent at that surface since the words were said.
    const listed = deps.kindAt(surface)
    if (listed !== undefined && listed !== kind) return 'no-answer'
    // Once: a paste cmux refused may have left the words at the prompt already.
    return (await deps.client.paste(workspace, surface, line)) ? 'sent' : 'no-answer'
  }

  const prompt = async (pane: string, kind: string, text: string): Promise<CmuxPrompt> => {
    // A newline would submit part of the text and an escape would steer the agent's screen.
    const line = text.replace(CONTROL, ' ')
    const ids = cmuxPaneOf(pane)
    // An agent cmux lists nothing for yet is known by the engine the dial means.
    if (!mac || !ids || !cmuxTakesWords(kind) || text.length > MAX_TEXT || line.trim() === '') return 'no-answer'
    // Busy queues nothing: the dial asks again, never stacked behind.
    const key = ids.surface.toLowerCase()
    if (prompting.has(key)) return 'busy'
    prompting.add(key)
    try {
      return await ask(ids.workspace, ids.surface, kind, line)
    } finally {
      prompting.delete(key)
    }
  }

  return {
    id: 'cmux',
    tap: 'instead',
    bundle: APP_BUNDLES.cmux,
    // A program started in a cmux terminal inherits its ids: they are cmux's only in cmux's own terminal (inCmux).
    paneOf(place: Place): Pane | undefined {
      if (!mac || place.host !== 'cmux' || !inCmux(place.hints)) return undefined
      return { adapter: 'cmux', id: cmuxPaneId(place.hints.CMUX_WORKSPACE_ID, place.hints.CMUX_SURFACE_ID) }
    },
    // No forward of its own: a cmux pane comes from a cmux terminal or a cmux row alone, so a link that fails leaves the
    // opener's fallback to bring cmux (open.ts).
    ...createAppLink(deps, {
      session: CMUX_PANE,
      // appLink.ts names only an id CMUX_PANE took, which cmuxPaneOf takes too.
      url: (pane) => {
        const { workspace, surface } = cmuxPaneOf(pane)!
        return `cmux://workspace/${workspace}/surface/${surface}`
      },
      bundle: APP_BUNDLES.cmux,
    }),
    // The mode is prompt's to read, when the words are said. Where cmux lists an agent whose prompt it does not read, none
    // are offered: the observed source knows the engine, the pane alone does not.
    canType: (pane) => {
      const ids = cmuxPaneOf(pane.id)
      const listed = ids && deps.kindAt(ids.surface)
      return mac && deps.found() && (listed === undefined || cmuxTakesWords(listed))
    },
    async type(pane, text, engine) {
      const answer = await prompt(pane.id, engine, text)
      if (answer === 'sent') return true
      if (answer === 'busy' || answer === 'waiting') return answer
      return answer === 'automation-off' ? { refused: CMUX_AUTOMATION_OFF } : false
    },
    paneKey: (pane) => cmuxPaneKey(pane.id.slice(pane.id.indexOf('/') + 1)),
    prompt,
  }
}
