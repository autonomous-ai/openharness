/**
 * VS Code, one adapter with two pane kinds told apart by the id's form. It is made once an editor, for VS Code and for
 * Cursor, a VS Code fork that runs the same Claude Code extension and Harness's own: each editor's adapter has the
 * editor's id, its bundle id and its link's scheme (docs/plans/2026-11-18-dial-cursor-design.md, §1).
 *
 * The extension's tab (docs/plans/2026-11-17-dial-vscode-follow-design.md): a Claude Code session the extension
 * started opens on its tab by the extension's `vscode://anthropic.claude-code/open?session=<id>` link (`cursor://` in
 * Cursor), sent to that editor alone by its bundle id (appLink.ts), on a tap and on a rest of the dial, a rest only while
 * that editor is in front. The link was read in the extension's code, not in any document, and may change with any
 * release. On Linux, which has no bundle id, the editor is the app the process scan named and the link opens by
 * `xdg-open` once its scheme has an app (docs/plans/2026-11-19-dial-linux-design.md § 1.6); on Windows the link goes
 * with the editor's bundle id to Windows' raise (windowsRaise.ts); elsewhere nothing runs.
 * Every value came from a hook, so each is checked against its form before it reaches the link.
 *
 * The integrated terminal (docs/plans/2026-11-17-dial-vscode-extension-design.md, §3): a Claude Code or Codex agent in a
 * terminal has the pane `term:<its pid>`, and Harness's own extension in the window that holds the terminal shows it on
 * a `{"show":<shell pid>}` line (vscodeTerminals.ts), a tap's with `"raise":true` so that window comes in front of
 * the editor's others. The terminal is asked for again at each verb, since a window comes and goes between looks. The
 * adapter's one `tap` is `'instead'`, for the tab's link, so a terminal's tap brings the editor itself once its line is
 * queued: by its own `open -b` on macOS, by the devices' raise of the pane's process on Linux (docs/plans/
 * 2026-11-19-dial-linux-design.md §§ 1.6, 2), by Windows' raise of the editor's bundle on Windows (windowsRaise.ts);
 * elsewhere the line alone is the tap. The dial's scroll sends that window the stroke's lines on a
 * `{"scroll":<lines>,"pid":<shell>}` line while the editor is in front (§4): the extension runs
 * them only while that terminal is the active one, so the adapter has no `onScreen`. A stroke whose `pageKeys` passed
 * carries `"page":true`, and the extension also presses Claude Code's page keys in that terminal
 * (docs/plans/2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md). The dial's words go to a terminal whose window
 * says it types: the terminals type them there, then press Enter after a settle, only while the agent is that terminal's
 * foreground job and the source says it is still at its prompt (vscodeTerminals.ts `type`,
 * docs/plans/2026-11-22-dial-vscode-cursor-voice-design.md). Cursor's terminals are typed into as VS Code's (U11);
 * Cursor's own agent takes no words, and its adapter's `voiceRefusal` says so (U10).
 *
 * The terminal holding a multiplexer's client (dial eval V12): an agent in the person's tmux runs under tmux's server,
 * whose chain reaches no window's shell, while the client the person attached from an integrated terminal does. Each
 * editor has a second adapter for it, as kitty and WezTerm have for theirs (createVscodeClientAdapter): its pane is the
 * client's process, and its window shows the shell on that client's chain, after the app came on a tap and before the
 * multiplexer's pane on a rest. A client under no shell a window lists has no terminal: never another one. Words and
 * strokes go to the multiplexer's pane, never here.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { createAppLink, type AppLinkDeps } from './appLink.js'
import { APP_BUNDLES, EXTENSION_TAB } from './hostDetect.js'
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS } from './orca.js'
import type { LinuxRaise } from './linuxRaise.js'
import { isPid, type VscodeTerminals } from './vscodeTerminals.js'

/** What tells the editors apart: the bundle id their hooks carry and `open -b` names, and the link's scheme. */
const EDITORS = {
  vscode: { bundle: APP_BUNDLES.vscode, scheme: 'vscode' },
  cursor: { bundle: APP_BUNDLES.cursor, scheme: 'cursor' },
} as const

/** A Claude Code session's own id, which the extension's link names. */
const VSCODE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A terminal pane's id: one form for each pid, so a pane's id and its pid read back the same. */
const TERM_PANE = /^term:([1-9][0-9]{0,9})$/
/** A multiplexer client's pane id, in the same one form for each pid. */
const CLIENT_PANE = /^client:([1-9][0-9]{0,9})$/

/** cursor-agent in a terminal, which sets TERM_PROGRAM. Cursor's own agent has the same engine but carries none, and its
 *  hook's pid may be a short-lived process: a pane for it would have the window stream's chain read it with `ps` every
 *  CHAIN_RETRY_MS, for nothing. */
function cursorInTerminal(place: Place): boolean {
  return place.engine === 'cursor' && !!place.hints.TERM_PROGRAM
}

/** Cursor's own agent, the chat inside Cursor (U10): Cursor's cursor engine out of any terminal, which a session the scan
 *  found is too until its first hook says TERM_PROGRAM. */
function cursorsOwnAgent(place: Place): boolean {
  return place.app === 'cursor' && place.engine === 'cursor' && !cursorInTerminal(place)
}

/** The engines an integrated terminal's pane is for: Claude Code, Codex, and cursor-agent in a terminal. */
function inTerminal(place: Place): boolean {
  return place.engine === 'claude' || place.engine === 'codex' || cursorInTerminal(place)
}

/** The agent's pid a terminal pane names (`term:<pid>`, 2..2^31-1); none for the panel's pane or any other id. */
export function termPid(paneId: string): number | undefined {
  const pid = Number(TERM_PANE.exec(paneId)?.[1])
  return isPid(pid) ? pid : undefined
}

export function createVscodeAdapter(
  editor: keyof typeof EDITORS,
  deps: AppLinkDeps & {
    terminals: Pick<VscodeTerminals, 'terminalOf' | 'show' | 'scroll' | 'pageKeys' | 'canType' | 'type'>
    /** Brings a window forward on Linux; none elsewhere. */
    raise?: LinuxRaise['raise']
  },
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const { bundle: editorBundle, scheme } = EDITORS[editor]
  const mac = deps.platform === 'darwin'
  const openBin = openPath(deps.bin)
  // No forward of its own: its pane exists only with its hook's own editor's bundle id, or with none in the editor the
  // caller's parents named, whose bundle the tap then carries (observed.ts placeApp), so a link that fails leaves the
  // opener's fallback to bring that editor (open.ts).
  const tab = createAppLink(deps, {
    session: VSCODE_SESSION,
    url: (session) => `${scheme}://anthropic.claude-code/open?session=${session}`,
    bundle: editorBundle,
  })

  return {
    id: editor,
    tap: 'instead',
    // A session the scan found has no bundle of its own until its first hook, and target() takes this one only from a
    // pane it can focus: a tap brings the editor only while a window's stream holds its terminal, else it does nothing.
    bundle: editorBundle,
    paneOf(place: Place): Pane | undefined {
      const { CLAUDE_CODE_ENTRYPOINT: entrypoint, __CFBundleIdentifier: bundle } = place.hints
      const session = place.sessionId
      // The extension says the same word in either editor, so each editor's own bundle id is what its adapter takes:
      // an app known by TERM_PROGRAM alone may be another fork. The link names Claude Code's sessions alone: an engine
      // Claude Code's tools ran from the tab (`codex exec`) inherits the word and the bundle id, and a Codex thread id
      // is a UUID too. Linux has no bundle id, and on macOS one an editor started from another app inherited is dropped
      // (hostDetect.ts ownHints): there the editor is the app the caller's parents named.
      const inEditor = bundle === editorBundle
        || ((mac || deps.platform === 'linux') && bundle === undefined && place.app === editor)
      if (place.engine === 'claude' && entrypoint === EXTENSION_TAB && inEditor && session
        && VSCODE_SESSION.test(session)) return { adapter: editor, id: session }
      // The tab's word, inherited by what its tools run, is never a terminal's: the tab has no shell a window reports.
      if (inTerminal(place) && place.app === editor && entrypoint !== EXTENSION_TAB && isPid(place.pid)) {
        return { adapter: editor, id: `term:${place.pid}` }
      }
      return undefined
    },
    canFocus(pane) {
      const pid = termPid(pane.id)
      return pid === undefined ? tab.canFocus(pane) : !!deps.terminals.terminalOf(pid)
    },
    async focus(pane) {
      const pid = termPid(pane.id)
      if (pid === undefined) return tab.focus(pane)
      const terminal = deps.terminals.terminalOf(pid)
      if (!terminal || !deps.terminals.show(terminal, true)) return false
      // The show is queued: the editor still has to come forward, and whether `open` or the raise did is not the
      // terminal's outcome, as the opener's own `open -b` after a pane is not.
      if (mac) await deps.run(openBin, ['-b', editorBundle], RUN_TIMEOUT_MS)
      else if (deps.windows) await deps.windows.app(editorBundle)
      else if (deps.raise) await deps.raise({ pid, app: editor })
      return true
    },
    canShow(pane) {
      const pid = termPid(pane.id)
      if (pid === undefined) return tab.canShow(pane)
      // The editor in front first: with it behind, no window is asked.
      return deps.inFront() && !!deps.terminals.terminalOf(pid)
    },
    async show(pane, agentId) {
      const pid = termPid(pane.id)
      if (pid === undefined) return tab.show(pane, agentId)
      const terminal = deps.terminals.terminalOf(pid)
      return terminal && deps.terminals.show(terminal, false) ? 'ok' : 'failed'
    },
    canScroll(pane) {
      const pid = termPid(pane.id)
      // A terminal's pane alone: the tab has no window stream. The editor in front first: with it behind, no window is
      // asked.
      return pid !== undefined && deps.inFront() && !!deps.terminals.terminalOf(pid)
    },
    pageKeys(pane, agent) {
      const pid = termPid(pane.id)
      // The tab draws no terminal: no key has anywhere to go.
      return pid === undefined ? false : deps.terminals.pageKeys(pid, agent)
    },
    scroll(pane, lines, page = false) {
      const pid = termPid(pane.id)
      const terminal = pid === undefined ? undefined : deps.terminals.terminalOf(pid)
      if (terminal) deps.terminals.scroll(terminal, lines, page)
    },
    canType(pane) {
      const pid = termPid(pane.id)
      // The tab has no shell a window reports: its words go to its mod, never here.
      return pid !== undefined && deps.terminals.canType(pid)
    },
    async type(pane, text, _engine, atPrompt) {
      const pid = termPid(pane.id)
      // The Enter waits a settle after the words: with no check that the agent is still at its prompt by then, it could
      // answer a question or start a turn the words were never meant for.
      if (pid === undefined || !atPrompt) return false
      const typed = await deps.terminals.type(pid, text, atPrompt)
      // Not in front (suspended, in the background): nothing was typed, and the person can bring it back (V9).
      if (typed === 'background') return { refused: 'Bring it to the front of its terminal.' }
      return typed === 'typed'
    },
    // Cursor documents no way to put words into one existing chat: its prompt link opens a new one, and its composer
    // commands act on whichever chat is focused (docs/plans/2026-11-22-dial-vscode-cursor-voice-design.md, §2).
    ...(editor === 'cursor' && {
      voiceRefusal: (place: Place) => (cursorsOwnAgent(place) ? 'Voice can\'t reach Cursor\'s agent. Type in Cursor.' : undefined),
    }),
  }
}

/** The client's pid a client pane names (`client:<pid>`, 2..2^31-1); none for any other id. */
export function clientPid(paneId: string): number | undefined {
  const pid = Number(CLIENT_PANE.exec(paneId)?.[1])
  return isPid(pid) ? pid : undefined
}

/** The integrated terminal holding a multiplexer's client, in [editor]'s windows: no `open -b` of its own, as the tap's
 *  opener already brought the editor by the agent's bundle (observed.ts placeApp names the client's app's). */
export function createVscodeClientAdapter(
  editor: keyof typeof EDITORS,
  deps: { inFront(): boolean; terminals: Pick<VscodeTerminals, 'terminalOf' | 'show'> },
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const id = `${editor}-tab`
  /** Asked again at each verb, as a window comes and goes between looks. */
  const terminalOf = (pane: Pane) => {
    const pid = clientPid(pane.id)
    return pid === undefined ? undefined : deps.terminals.terminalOf(pid)
  }
  return {
    id,
    tap: 'after',
    paneOf(place: Place): Pane | undefined {
      const pid = place.outer?.app === editor ? place.outer.pid : undefined
      return isPid(pid) ? { adapter: id, id: `client:${pid}` } : undefined
    },
    canFocus: (pane) => !!terminalOf(pane),
    async focus(pane) {
      const terminal = terminalOf(pane)
      return !!terminal && deps.terminals.show(terminal, true)
    },
    // The editor in front first: with it behind, no window is asked.
    canShow: (pane) => deps.inFront() && !!terminalOf(pane),
    async show(pane) {
      const terminal = terminalOf(pane)
      return terminal && deps.terminals.show(terminal, false) ? 'ok' : 'failed'
    },
  }
}
