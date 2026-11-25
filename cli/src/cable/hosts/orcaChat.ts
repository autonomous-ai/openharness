/**
 * Brings an Orca chat's worktree up, by the chat's Orca session id: ORCA_AGENT_SESSION_ID in hints that have no
 * ORCA_TERMINAL_HANDLE (docs/plans/2026-11-23-dial-orca-chats-design.md, "Dial to Orca"). A chat is a process Orca drives
 * over stream-json, on no terminal, and Orca 1.4.271's CLI has no command that opens a chat's tab. So a tap and a rest
 * both run `orca worktree activate` for the worktree Orca's own list gave the chat (orcaChatSource.ts), and Orca comes
 * forward as every app does (open.ts): the person sees the chat's worktree, not yet the chat. A rest activates too, as a
 * chat has no tab to switch to until Orca offers `orca agent reveal`.
 *
 * There is no `type`. A chat has no terminal to type into, and Orca's CLI puts no words in a chat until `orca agent
 * send`; words typed anywhere else would land in a held terminal, another pane or Orca's front window. For a chat no
 * other route reaches, the dial says `Type in Orca for chats.` (observed.ts voiceRefusal).
 *
 * The worktree id is outside text: Orca's, through the chat source. It is held to Orca's bounds and is one argument with
 * no shell. An agent in an Orca terminal keeps the terminal adapter (orca.ts).
 */
import { orcaBinary } from '../../devices/orcaHomes.js'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { ORCA_ACTIVATE_FAILED, type OrcaDeps, RUN_TIMEOUT_MS, worktreeIdOf } from './orca.js'
import type { PaneSwitch } from './types.js'

/** The adapter's id, and the word its pane and the dial's log lines say. */
export const ORCA_CHAT_ADAPTER = 'orca-chat'
/** What the dial says for words to a chat no route reaches. */
export const ORCA_CHAT_REFUSAL = 'Type in Orca for chats.'

// Orca's session ids are a UUID or `claude_` and one with underscores, 36 and 43 characters (2026-11-23): one past 128 or
// with a control character is none of Orca's.
const MAX_SESSION_ID = 128
const CONTROL_CHAR = /\p{Cc}/u

/** An Orca session id as a hook may carry one, or none. */
const sessionIdOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= MAX_SESSION_ID && !CONTROL_CHAR.test(value) ? value : undefined

/** The Orca chat a hook's hints name, or none. An agent in an Orca terminal carries the session id too, beside its
 *  terminal's handle: it is that terminal's (orca.ts), never a chat, also when its handle is out of form. */
export function orcaChatId(hints: Readonly<Record<string, string>>): string | undefined {
  if (hints.ORCA_TERMINAL_HANDLE) return undefined
  return sessionIdOf(hints.ORCA_AGENT_SESSION_ID)
}

export interface OrcaChatDeps extends OrcaDeps {
  /** A chat's worktree id in Orca, by its Orca session id, from the latest read of Orca's list of chats; none for a chat
   *  that read did not list. */
  worktreeOf(orcaId: string): string | undefined
  log(line: string): void
}

export type OrcaChatAdapter = HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show' | 'voiceRefusal'>> & {
  /** Runs `orca worktree activate` for that worktree: true once it exited 0. Also a resting chat's tap, through the chat
   *  source. Never throws. */
  activate(worktreeId: string): Promise<boolean>
}

/** An Orca chat, by its Orca session id: a rest or a tap activates its worktree before Orca comes forward. */
export function createOrcaChatAdapter(deps: OrcaChatDeps): OrcaChatAdapter {
  // Per worktree, the activate under way: a second is that same run. A swipe's rest and a tap 0.4 to 1 s after it each
  // activate the chat's worktree (orca.ts switchTo), and two chats of one worktree activate the same.
  const activating = new Map<string, Promise<boolean>>()

  const activate = (worktreeId: string): Promise<boolean> => {
    const id = worktreeIdOf(worktreeId)
    if (id === undefined) {
      deps.log(ORCA_ACTIVATE_FAILED)
      return Promise.resolve(false)
    }
    const under = activating.get(id)
    if (under) return under
    const run = (async (): Promise<boolean> => {
      const orca = orcaBinary(deps)
      // No Orca to ask: nothing ran, so nothing failed. A tap's opener says Orca came forward alone.
      if (orca === null) return false
      let code: number | null
      try {
        ({ code } = await deps.run(orca, ['worktree', 'activate', '--worktree', `id:${id}`, '--json'], RUN_TIMEOUT_MS))
      } catch {
        // A run that throws or rejects is one that failed.
        code = null
      }
      if (code !== 0) deps.log(ORCA_ACTIVATE_FAILED)
      return code === 0
    })().finally(() => activating.delete(id))
    activating.set(id, run)
    return run
  }

  /** The pane's worktree, from the latest read: none for a pane id out of a chat's form, asked nothing then. */
  const worktreeOfPane = (pane: Pane): string | undefined => {
    const orcaId = sessionIdOf(pane.id)
    return orcaId === undefined ? undefined : deps.worktreeOf(orcaId)
  }
  // A chat the latest read did not list has no worktree to bring up: neither a rest nor a tap runs anything, and a tap
  // brings Orca forward alone.
  const known = (pane: Pane): boolean => worktreeOfPane(pane) !== undefined
  const focus = async (pane: Pane): Promise<boolean> => {
    const worktreeId = worktreeOfPane(pane)
    return worktreeId === undefined ? false : activate(worktreeId)
  }
  const paneOf = (place: Place): Pane | undefined => {
    const id = orcaChatId(place.hints)
    return id === undefined ? undefined : { adapter: ORCA_CHAT_ADAPTER, id }
  }

  return {
    id: ORCA_CHAT_ADAPTER,
    tap: 'before',
    bundle: APP_BUNDLES.orca,
    paneOf,
    canFocus: known,
    canShow: known,
    focus,
    show: async (pane): Promise<PaneSwitch> => ((await focus(pane)) ? 'ok' : 'failed'),
    voiceRefusal: (place) => (paneOf(place) ? ORCA_CHAT_REFUSAL : undefined),
    activate,
  }
}
