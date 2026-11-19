/**
 * VS Code, one adapter with two pane kinds told apart by the id's form. It is made once an editor, for VS Code and for
 * Cursor, a VS Code fork that runs the same Claude Code extension and Harness's own: each editor's adapter has the
 * editor's id, its bundle id and its link's scheme (docs/plans/2026-11-18-dial-cursor-design.md, §1).
 *
 * The extension's tab (docs/plans/2026-11-17-dial-vscode-follow-design.md): a Claude Code session the extension
 * started opens on its tab by the extension's `vscode://anthropic.claude-code/open?session=<id>` link (`cursor://` in
 * Cursor), sent to that editor alone by its bundle id (appLink.ts), on a tap and on a rest of the dial, a rest only while
 * that editor is in front. The link was read in the extension's code, not in any document, and may change with any
 * release. The link and `open` are macOS's, so elsewhere nothing runs. Every value came from a hook, so each is checked
 * against its form before it reaches the link.
 *
 * The integrated terminal (docs/plans/2026-11-17-dial-vscode-extension-design.md, §3): a Claude Code or Codex agent in a
 * terminal has the pane `term:<its pid>`, and Harness's own extension in the window that holds the terminal shows it on
 * a `{"show":<shell pid>}` line (vscodeTerminals.ts), a tap's with `"raise":true` so that window comes in front of
 * the editor's others. The terminal is asked for again at each verb, since a window comes and goes between looks. The
 * adapter's one `tap` is `'instead'`, for the tab's link, so a terminal's tap runs the editor's own `open -b` itself once
 * its line is queued; off macOS the line alone is the tap. The dial's scroll sends that window the stroke's lines on a
 * `{"scroll":<lines>,"pid":<shell>}` line while the editor is in front (§4): the extension runs them only while that
 * terminal is the active one, so the adapter has no `onScreen`. A stroke whose `pageKeys` passed carries `"page":true`,
 * and the extension also presses Claude Code's page keys in that terminal
 * (docs/plans/2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md).
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { createAppLink, type AppLinkDeps } from './appLink.js'
import { APP_BUNDLES } from './hostDetect.js'
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS } from './orca.js'
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

/** The engines an integrated terminal's pane is for: Claude Code, Codex, and cursor-agent only with TERM_PROGRAM, which
 *  a terminal sets. Cursor's own agent has the same engine but carries none, and its hook's pid may be a short-lived
 *  process: a pane for it would have the window stream's chain read it with `ps` every CHAIN_RETRY_MS, for nothing. */
function inTerminal(place: Place): boolean {
  return place.engine === 'claude' || place.engine === 'codex' || (place.engine === 'cursor' && !!place.hints.TERM_PROGRAM)
}

/** The agent's pid a terminal pane names (`term:<pid>`, 2..2^31-1); none for the panel's pane or any other id. */
export function termPid(paneId: string): number | undefined {
  const pid = Number(TERM_PANE.exec(paneId)?.[1])
  return isPid(pid) ? pid : undefined
}

export function createVscodeAdapter(
  editor: keyof typeof EDITORS,
  deps: AppLinkDeps & { terminals: Pick<VscodeTerminals, 'terminalOf' | 'show' | 'scroll' | 'pageKeys'> },
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const { bundle: editorBundle, scheme } = EDITORS[editor]
  const mac = deps.platform === 'darwin'
  const openBin = openPath(deps.bin)
  // No forward of its own: its pane exists only with its hook's own editor's bundle id, so a link that fails leaves
  // the opener's fallback to bring that editor (open.ts).
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
      // is a UUID too.
      if (place.engine === 'claude' && entrypoint === 'claude-vscode' && bundle === editorBundle && session
        && VSCODE_SESSION.test(session)) return { adapter: editor, id: session }
      // The tab's word, inherited by what its tools run, is never a terminal's: the tab has no shell a window reports.
      if (inTerminal(place) && place.app === editor && entrypoint !== 'claude-vscode' && isPid(place.pid)) {
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
      // The show is queued: the editor still has to come forward, and whether `open` did is not the terminal's outcome,
      // as the opener's own `open -b` after a pane is not.
      if (mac) await deps.run(openBin, ['-b', editorBundle], RUN_TIMEOUT_MS)
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
  }
}
