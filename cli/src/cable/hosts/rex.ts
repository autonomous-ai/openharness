/**
 * A Rex block (docs/specs/2026-11-25-dial-rex.md): a tap or a rest focuses it with `rex block focus` and asks the Rex app
 * to show its session on its tab (`session.select`), then, for a tap, Rex comes forward as every app does. The dial's
 * words are typed into it with `rex send`, then, after the settle every typed host waits, `rex send-key enter`. The
 * daemon runs outside Rex, so every command names the session and the block. Both came from a hook, so each is checked
 * against its form before a command, which runs with no shell.
 *
 * Beside the adapter, the reads (createRexReads) the devices order Rex's ring by, name its agents by and follow its focus
 * with (services/devices.ts).
 *
 * Only the Rex Server app's own `rex` is run: the one in the folder the Rex app installs it in, found on this process's
 * PATH or at its fixed path under this home. A bare `rex` elsewhere is another program's name. That `rex` reaches this
 * home's own server, the one a block's REX_SESSION names when the hook sends it (hook/notify.mjs onOwnRexServer). Rex ids
 * never change and are never reused (Rex's CLI docs), so a block of another server names none here. macOS only, where the
 * Rex app runs.
 */
import { statSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { binaryFinder } from '../../lib/binaryFinder.js'
import { INJECT_PASTE_DELAY_BASE_MS, INJECT_PASTE_DELAY_MAX_MS } from '../../lib/submitTiming.js'
import type { TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { PaneSwitch } from './types.js'

/** A Rex id's uuid, as `rex … --json` prints it (lower-case, RECORDED_REX). */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const BLOCK = new RegExp(`^block:${UUID}$`)
const SESSION = new RegExp(`^session:${UUID}$`)
const WINDOW_ID = new RegExp(`^window:${UUID}$`)
/** A pid a hook gave: the agent's own process, the one Rex must name as the block's foreground before words go. */
const PID = '[1-9][0-9]{0,9}'
/** A block that holds the agent's terminal but whose pseudo-terminal Rex did not make (a multiplexer in it): a tap only. */
const HELD = 'held:'
/** `<session>/<block>/<pid>`: the agent's own block, which takes words. Neither id holds a `/`. */
const OWN_PANE = new RegExp(`^(session:${UUID})/(block:${UUID})/(${PID})$`)
/** Either form: `held:<session>/<block>` or an own pane. */
const ANY_PANE = new RegExp(`^(?:${HELD}(session:${UUID})/(block:${UUID})|(session:${UUID})/(block:${UUID})/${PID})$`)

/** Where the Rex app puts the server's `rex`, under the home (the spike, and Rex's CLI docs: the directory REX_BIN_DIR
 *  names in every Rex terminal). `Versions/Current` follows the app's updates. */
export const REX_BIN = join('Library', 'Application Support', 'com.superlogical.rex', 'RexServer', 'Versions', 'Current',
  'Rex Server.app', 'Contents', 'MacOS', 'rex')
/** The tail of every path the Rex Server app's `rex` has, a version's folder or `Current`. */
const REX_APP_TAIL = '/Rex Server.app/Contents/MacOS/rex'

/** How long a session switch in the app may wait for its answer (Rex's client.perform `timeout_ms`), within the command's
 *  own RUN_TIMEOUT_MS. */
const SELECT_TIMEOUT_MS = 5_000

export interface RexFinderDeps {
  env: NodeJS.ProcessEnv
  home: string
  platform: NodeJS.Platform
  /** This process's uid: the binary must be the person's own. */
  uid: number
  stat(path: string): Stats | undefined
}

const defaultFinderDeps = (): RexFinderDeps => ({
  env: process.env,
  home: homedir(),
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  stat: (path) => { try { return statSync(path) } catch { return undefined } },
})

/** The Rex Server app's `rex`: a regular, executable file this user owns, on PATH or at REX_BIN. Undefined for any other. */
function rexBinary(deps: RexFinderDeps): string | undefined {
  if (deps.platform !== 'darwin') return undefined
  const own = (path: string): boolean => {
    const st = deps.stat(path)
    return !!st && st.isFile() && (st.mode & 0o111) !== 0 && st.uid === deps.uid
  }
  // Only a PATH entry of the Rex Server app's (a Rex terminal's REX_BIN_DIR): a bare `rex` elsewhere is another program.
  const onPath = (deps.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'rex'))
    .find((path) => path.endsWith(REX_APP_TAIL) && own(path))
  if (onPath) return onPath
  const fixed = join(deps.home, REX_BIN)
  return own(fixed) ? fixed : undefined
}

/** `rex` as above, found at its first call and shared by every caller; none is asked again once one is there
 *  (binaryFinder), as a Rex installed after the devices started. */
export function rexFinder(deps: RexFinderDeps = defaultFinderDeps()): () => Promise<TmuxPathOutcome> {
  return binaryFinder(async () => {
    const path = rexBinary(deps)
    return path ? { state: 'adopted', path, from: 'standard install location' } : { state: 'absent', reason: 'rex was not found' }
  }, () => rexBinary(deps) !== undefined)
}

export interface RexDeps {
  run: OrcaDeps['run']
  /** Where `rex` is (rexFinder); it never rejects. */
  rex(): Promise<TmuxPathOutcome>
  platform: NodeJS.Platform
  /** This process's uid: only this user's Rex app is asked to show a session. */
  uid: number
  /** The app the devices settled in front (cableHost.latestFront): a rest moves Rex only while it is there. */
  front(): string | undefined
  log(line: string): void
  /** Waits [ms]: the settle between the words and their Enter, and the gap between two page keys. */
  wait?(ms: number): Promise<void>
  /** Whether Claude Code's settings draw that folder's session fullscreen (claudeRenderer.ts readFullscreen): its view
   *  then keeps no scrollback for Rex to scroll, and its own page keys scroll it. Absent: never. */
  fullscreen?(cwd: string, transcriptPath: string | undefined): Promise<boolean>
  /** A monotonic clock in ms, for a scroll's remainder going stale. */
  now?(): number
}

/** The dial lines one page stands for, a page key's or a page of Rex's scrollback: Herdr's, as the PM set it for Claude
 *  Code (herdrApp.ts SCROLL_PAGE_LINES, 2026-11-18), about half a screen of Claude Code for about 8 lines of the finger. */
export const REX_SCROLL_PAGE_LINES = 8
/** The gap after each page, as Herdr's (SCROLL_KEY_GAP_MS): at most 10 a second. */
export const REX_SCROLL_GAP_MS = 100
/** The most pages that wait, either way, as Herdr's (SCROLL_KEYS_PENDING_MAX): a fling stops with the finger. */
export const REX_SCROLL_PAGES_MAX = 4
/** A pane's remainder short of a page is forgotten once no line came for this long, as VS Code's (PAGE_IDLE_MS). */
export const REX_SCROLL_IDLE_MS = 1_000
/** How long a stroke's `pageKeys` may take, settings and the foreground read together. */
export const REX_PAGE_KEYS_MS = 1_000

/** The session and the block the hints name, each in its form. A hint with no REX_SESSION names no pane: an older hook's,
 *  or a block on another server (hook/notify.mjs onOwnRexServer). */
function hinted(platform: NodeJS.Platform, hints: Readonly<Record<string, string>>): { session: string; block: string } | undefined {
  if (platform !== 'darwin') return undefined
  const session = hints.REX_SESSION
  const block = hints.REX_BLOCK
  return session && block && SESSION.test(session) && BLOCK.test(block) ? { session, block } : undefined
}

/** The session and the block of any pane of this adapter's, from its id; none for an id not in form. */
function located(pane: Pane): { session: string; block: string } | undefined {
  const found = ANY_PANE.exec(pane.id)
  if (!found) return undefined
  return found[1] ? { session: found[1], block: found[2] } : { session: found[3], block: found[4] }
}

/** One block as the Rex app shows it, in the order its sidebar does: its session, its window (a tab), the block's own
 *  id, the pid of its foreground process, and the title its program set, which the app names the pane and the tab by
 *  (Rex's Settings ▸ Terminal ▸ Titles). */
export interface RexPane {
  session: string
  window: string
  block: string
  pid?: number
  title?: string
}

/** What a read of Rex's focus found in one session: the block focused in the window the session shows, or null. */
export type RexFocus = ReadonlyMap<string, string | null>

export interface RexReads {
  /** Every block of every session, in Rex's order: sessions as `session.list` orders them ("New sessions go at the end,
   *  and session.move changes the order"), windows as `session.view` does ("Rex.app shows them as tabs in this order"),
   *  and blocks layer by layer, back to front, each layer's "in layout order". Null when a read failed. */
  layout(): Promise<RexPane[] | null>
  /** Each of [sessions], its focused block in the window it shows (`session.view`): undefined when every read failed. */
  focused(sessions: readonly string[], signal?: AbortSignal): Promise<RexFocus | undefined>
}

/** Bounds on a layout read, so a server with many sessions costs a bounded number of `rex` runs. */
export const REX_MAX_SESSIONS = 16
export const REX_MAX_BLOCKS = 64

interface View { active?: string; windows: Array<{ id: string; focused?: string; blocks: string[] }> }

/** A `session.view` answer in form, ids checked; undefined for any other. */
function viewOf(stdout: string): View | undefined {
  try {
    const parsed = JSON.parse(stdout) as { active_window_id?: unknown; windows?: unknown }
    const windows = Array.isArray(parsed.windows) ? parsed.windows as Array<Record<string, unknown>> : []
    const view: View = { windows: [] }
    if (typeof parsed.active_window_id === 'string' && WINDOW_ID.test(parsed.active_window_id)) view.active = parsed.active_window_id
    for (const w of windows) {
      if (typeof w.window_id !== 'string' || !WINDOW_ID.test(w.window_id)) continue
      const layers = Array.isArray(w.layers) ? w.layers as Array<{ blocks?: unknown }> : []
      const blocks = layers.flatMap((layer) => (Array.isArray(layer.blocks) ? layer.blocks as Array<{ block_id?: unknown }> : [])
        .flatMap(({ block_id }) => (typeof block_id === 'string' && BLOCK.test(block_id) ? [block_id] : [])))
      const focused = typeof w.focused_block_id === 'string' && BLOCK.test(w.focused_block_id) ? w.focused_block_id : undefined
      view.windows.push({ id: w.window_id, ...(focused ? { focused } : {}), blocks })
    }
    return view
  } catch {
    return undefined
  }
}

export function createRexReads(deps: Pick<RexDeps, 'run' | 'rex'>): RexReads {
  const rex = async (args: string[]): Promise<{ code: number | null; stdout: string } | undefined> => {
    const found = await deps.rex()
    if (found.state !== 'adopted') return undefined
    return deps.run(found.path, args, RUN_TIMEOUT_MS)
  }
  const view = async (session: string): Promise<View | undefined> => {
    const answer = await rex(['api', 'call', '-s', session, 'session.view'])
    return answer?.code === 0 ? viewOf(answer.stdout) : undefined
  }
  /** One block method's JSON answer, or undefined. */
  const call = async (session: string, block: string, method: 'process' | 'title'): Promise<Record<string, unknown> | undefined> => {
    const answer = await rex(['block', 'call', '-s', session, '-b', block, method])
    if (answer?.code !== 0) return undefined
    try {
      const parsed: unknown = JSON.parse(answer.stdout)
      return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }
  return {
    async layout() {
      const listed = await rex(['ls', '--json'])
      if (listed?.code !== 0) return null
      let sessions: string[]
      try {
        const parsed = JSON.parse(listed.stdout) as { sessions?: unknown }
        sessions = (Array.isArray(parsed.sessions) ? parsed.sessions as Array<{ session_id?: unknown }> : [])
          .flatMap(({ session_id }) => (typeof session_id === 'string' && SESSION.test(session_id) ? [session_id] : []))
          .slice(0, REX_MAX_SESSIONS)
      } catch {
        return null
      }
      const panes: RexPane[] = []
      for (const session of sessions) {
        const seen = await view(session)
        if (!seen) return null
        for (const window of seen.windows) {
          for (const block of window.blocks) {
            if (panes.length === REX_MAX_BLOCKS) return panes
            const [process, titled] = await Promise.all([call(session, block, 'process'), call(session, block, 'title')])
            const foreground = (process?.foreground as { pid?: unknown } | undefined)?.pid
            const title = typeof titled?.title === 'string' ? titled.title.replace(CONTROL, ' ').trim() : ''
            panes.push({ session, window: window.id, block,
              ...(typeof foreground === 'number' && Number.isSafeInteger(foreground) && foreground > 0 ? { pid: foreground } : {}),
              ...(title ? { title } : {}) })
          }
        }
      }
      return panes
    },
    async focused(sessions, signal) {
      const read = await Promise.all(sessions.map(async (session) => (signal?.aborted ? undefined : [session, await view(session)] as const)))
      if (read.every((one) => one?.[1] === undefined)) return undefined
      const focused = new Map<string, string | null>()
      for (const one of read) {
        if (!one || !one[1]) continue
        const [session, seen] = one
        focused.set(session, seen.windows.find((w) => w.id === seen.active)?.focused ?? null)
      }
      return focused
    },
  }
}

/** The session and the block of a pane id of this adapter's, own or held; none for an id not in form. */
export function rexPaneParts(id: string): { session: string; block: string; held: boolean } | undefined {
  const at = located({ adapter: 'rex', id })
  return at && { ...at, held: id.startsWith(HELD) }
}

/** The blocks whose foreground process is [pid]: none for no pid, which no block's unknown foreground may match. */
export function rexBlocksRunning(panes: readonly RexPane[], pid: number | undefined): RexPane[] {
  return pid === undefined ? [] : panes.filter((pane) => pane.pid === pid)
}

/** The pane ids a block has for the agent at [pid] there: its own, and the held one a multiplexer in it gives. */
export function rexPaneIds(session: string, block: string, pid?: number): string[] {
  return [...pid === undefined ? [] : [`${session}/${block}/${pid}`], `${HELD}${session}/${block}`]
}

/** The settle before Enter, as every typed host waits it (vscodeTerminals.ts): Codex's paste-burst detector takes an Enter
 *  that follows a burst of keys as a newline, which the spike saw lose a 13,039-character prompt's Enter in a Rex block. */
export function rexSettle(chars: number): number {
  return Math.min(INJECT_PASTE_DELAY_MAX_MS, INJECT_PASTE_DELAY_BASE_MS + Math.floor(chars / 60))
}

export function createRexAdapter(deps: RexDeps): HostAdapter & Required<Pick<HostAdapter, 'type' | 'canType' | 'show' | 'canShow'>> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms) }))
  // Per block, the words being typed: two sends at once would mix in its prompt, and a rest then shows nothing.
  const sending = new Set<string>()

  /** One `rex …` where it was found; nothing when it was not. */
  const rex = async (args: string[]): Promise<{ code: number | null; stdout: string } | undefined> => {
    const found = await deps.rex()
    if (found.state !== 'adopted') return undefined
    return deps.run(found.path, args, RUN_TIMEOUT_MS)
  }

  /** Whether Rex names [pid] the block's foreground process now: the agent, not a shell it left behind, nor a program run
   *  in its place. Any failure, an answer out of form included, is no. */
  const foregroundIs = async (session: string, block: string, pid: number): Promise<boolean> => {
    const answer = await rex(['block', 'call', '-s', session, '-b', block, 'process'])
    if (answer?.code !== 0) return false
    try {
      const parsed: unknown = JSON.parse(answer.stdout)
      const foreground = (parsed as { foreground?: { pid?: unknown } } | null)?.foreground
      return foreground?.pid === pid
    } catch {
      return false
    }
  }

  const focusBlock = async (session: string, block: string): Promise<boolean> =>
    (await rex(['block', 'focus', '-s', session, block]))?.code === 0

  /** The window (the app's tab) that holds [block], from `rex block inspect --json`; none when it could not be read. */
  const windowOf = async (session: string, block: string): Promise<string | undefined> => {
    const answer = await rex(['block', 'inspect', '-s', session, block, '--json'])
    if (answer?.code !== 0) return undefined
    try {
      const parsed = JSON.parse(answer.stdout) as { block?: { window_id?: unknown }; window_id?: unknown }
      const window = parsed.block?.window_id ?? parsed.window_id
      return typeof window === 'string' && WINDOW_ID.test(window) ? window : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Asks each of this user's Rex apps to show [session] on [window]: `rex block focus` moves the server's focus, and the
   * app follows it within the tab it shows but does not change its tab for it (Diego on the dial, 2026-11-25). The app's
   * own Go to Session (`session.select`, `window_id`: "A window in the session to show") does. The app does what another
   * program asks only with its Remote Control on (Rex's docs, the spike): with it off, or with no app, it stays where it
   * was, and one counted line says so when [said]. Never fails the verb: the block is focused on the server either way.
   */
  /** This user's Rex apps on macOS, from `rex client ls --json` ("the server's full reply, including command line
   *  clients"); none when it could not be read. */
  const appClients = async (): Promise<string[]> => {
    const listed = await rex(['client', 'ls', '--json'])
    if (listed?.code !== 0) return []
    try {
      const parsed = JSON.parse(listed.stdout) as { clients?: unknown }
      const clients = Array.isArray(parsed.clients) ? parsed.clients as Array<Record<string, unknown>> : []
      return clients.filter((c) => {
        const info = c.info as { kind?: unknown; platform?: unknown } | undefined
        const principal = c.principal as { uid?: unknown } | undefined
        return info?.kind === 'app' && info.platform === 'macos' && principal?.uid === deps.uid
          && typeof c.client_id === 'string' && /^client:[0-9a-f-]{36}$/.test(c.client_id)
      }).map((c) => c.client_id as string)
    } catch {
      return []
    }
  }

  const showInApp = async (session: string, window: string | undefined, said: boolean): Promise<void> => {
    const apps = await appClients()
    let shown = 0
    const args = { session_id: session, ...(window === undefined ? {} : { window_id: window }) }
    for (const client of apps) {
      const request = JSON.stringify({ client_id: client, action: 'session.select', args, timeout_ms: SELECT_TIMEOUT_MS })
      if ((await rex(['api', 'call', 'client.perform', request]))?.code === 0) shown++
    }
    if (shown === 0 && said) deps.log(`[device] open · rex · session not shown (${apps.length === 0 ? 'no app' : 'refused'})`)
  }

  /** A tap's and a rest's move: the block focused on the server, then the app asked to show its session on its tab. */
  const bring = async (session: string, block: string, said: boolean): Promise<boolean> => {
    if (!(await focusBlock(session, block))) return false
    await showInApp(session, await windowOf(session, block), said)
    return true
  }

  /**
   * One page of [block] toward older lines when [up]. With [keys], the program's own PageUp or PageDown (`rex send-key`,
   * the key names of Rex's Writing Keys): Claude Code drawn fullscreen keeps its history on a screen with no scrollback
   * (Rex's Shell Scripting docs), and the spike saw its keys move it, 65 to 38 and back. Else the Rex app's Scroll Page
   * Up or Down (Rex's Mac Actions), asked of this user's apps: it scrolls a block's scrollback, as the spike saw on a
   * shell's 300 lines, and answers not_supported where there is none. Never rejects.
   */
  const page = async (session: string, block: string, up: boolean, keys: boolean): Promise<void> => {
    if (keys) {
      await rex(['send-key', '-s', session, '-b', block, up ? 'pageup' : 'pagedown'])
      return
    }
    for (const client of await appClients()) {
      const request = JSON.stringify({ client_id: client, action: up ? 'client.scroll.page_up' : 'client.scroll.page_down',
        session_id: session, block_id: block, timeout_ms: SELECT_TIMEOUT_MS })
      await rex(['api', 'call', 'client.perform', request])
    }
  }

  /** Per pane, what a scroll holds: the lines short of a page, the pages still to go (below zero, up), whether they are
   *  keys, and whether a run of them is under way. */
  const scrolls = new Map<string, { lines: number; pages: number; keys: boolean; at: number; running: boolean }>()
  const now = deps.now ?? (() => performance.now())
  /** The pages that wait for [id], one at a time, each followed by the gap; the lines that come meanwhile add to them. */
  const drain = async (id: string, session: string, block: string): Promise<void> => {
    const held = scrolls.get(id)!
    held.running = true
    try {
      while (held.pages !== 0) {
        const up = held.pages < 0
        held.pages += up ? 1 : -1
        await page(session, block, up, held.keys).catch(() => undefined)
        await wait(REX_SCROLL_GAP_MS)
      }
    } finally {
      held.running = false
    }
  }

  return {
    id: 'rex',
    tap: 'before',
    bundle: APP_BUNDLES.rex,
    paneOf(place: Place): Pane | undefined {
      const at = hinted(deps.platform, place.hints)
      if (!at) return undefined
      // A multiplexer, a terminal or an editor started in a Rex block keeps its variables, and the block shows whichever
      // of their panes is in front, or a shell that runs what is typed: only a block whose pseudo-terminal Rex's server
      // made for the agent takes words, and only with its pid, which each word checks against the block's foreground.
      const own = place.ptyOwner === 'rex' && place.pid !== undefined && new RegExp(`^${PID}$`).test(String(place.pid))
      return own
        ? { adapter: 'rex', id: `${at.session}/${at.block}/${place.pid}` }
        : { adapter: 'rex', id: `${HELD}${at.session}/${at.block}`, held: true }
    },
    // An agent in a Rex block has a Rex on this machine: whether `rex` is found is asked at the verb, and a tap that finds
    // none brings Rex forward, as Zellij's does.
    canFocus: () => true,
    async focus(pane) {
      const at = located(pane)
      return !!at && bring(at.session, at.block, true)
    },
    // A rest moves Rex only while the person has it in front, to the agent's block on its tab, in its session, as a tap
    // does, so the pane the dial rests on is the one on screen.
    canShow: (pane) => located(pane) !== undefined && deps.front() === 'rex',
    async show(pane): Promise<PaneSwitch> {
      const at = located(pane)
      if (!at) return 'failed'
      if (sending.has(pane.id)) return 'busy'
      return (await bring(at.session, at.block, false)) ? 'ok' : 'failed'
    },
    // A stroke scrolls the agent's own block (or the one its process runs in), with Rex in front: a held block shows
    // whatever runs in front of the agent there.
    canScroll: (pane) => OWN_PANE.test(pane.id) && deps.front() === 'rex',
    /** The block focused in the window its session shows (`session.view`): the one on screen. */
    async onScreen(pane) {
      const found = OWN_PANE.exec(pane.id)
      if (!found) return false
      const answer = await rex(['api', 'call', '-s', found[1], 'session.view']).catch(() => undefined)
      const seen = answer?.code === 0 ? viewOf(answer.stdout) : undefined
      return !!seen && seen.windows.find((w) => w.id === seen.active)?.focused === found[2]
    },
    /** Claude Code drawn fullscreen, at no question, in the foreground of its block: its own keys scroll it. */
    pageKeys(pane, agent) {
      const found = OWN_PANE.exec(pane.id)
      const { fullscreen } = deps
      if (!found || !fullscreen || agent.asking || agent.cwd === undefined || !isAbsolute(agent.cwd)) return false
      const [, session, block, pidText] = found
      const cwd = agent.cwd
      const asked = (async () => (await fullscreen(cwd, agent.transcriptPath)) && foregroundIs(session, block, Number(pidText)))()
        .catch(() => false)
      return Promise.race([asked, wait(REX_PAGE_KEYS_MS).then(() => false)])
    },
    scroll(pane, lines, keys = false) {
      const found = OWN_PANE.exec(pane.id)
      if (!found || lines === 0) return
      const at = now()
      // One record per pane, which a run under way keeps reading: a pause, or the other kind of page, starts it from
      // nothing again.
      const held = scrolls.get(pane.id) ?? { lines: 0, pages: 0, keys, at, running: false }
      if (at - held.at >= REX_SCROLL_IDLE_MS || held.keys !== keys) Object.assign(held, { lines: 0, pages: 0, keys })
      held.at = at
      held.lines += lines
      const pages = Math.trunc(held.lines / REX_SCROLL_PAGE_LINES)
      held.lines -= pages * REX_SCROLL_PAGE_LINES
      held.pages = Math.max(-REX_SCROLL_PAGES_MAX, Math.min(REX_SCROLL_PAGES_MAX, held.pages + pages))
      scrolls.set(pane.id, held)
      if (!held.running && held.pages !== 0) void drain(pane.id, found[1], found[2])
    },
    canType: (pane) => OWN_PANE.test(pane.id),
    async type(pane, text, _engine, atPrompt) {
      const found = OWN_PANE.exec(pane.id)
      if (text === '' || text.length > MAX_TEXT || !found || sending.has(pane.id)) return false
      const [, session, block, pidText] = found
      const pid = Number(pidText)
      sending.add(pane.id)
      try {
        if (!(await foregroundIs(session, block, pid))) return false
        const line = text.replace(CONTROL, ' ')
        // `--` keeps words that start with a dash from being read as flags (the spike: `-n hello --flag` typed as it is).
        if ((await rex(['send', '-s', session, '-b', block, '--', line]))?.code !== 0) return false
        await wait(rexSettle(line.length))
        // The same checks, asked again after the settle: a turn that started, a prompt that opened, or the agent gone
        // from the block meanwhile would take the Enter.
        if ((atPrompt && !atPrompt()) || !(await foregroundIs(session, block, pid))) return false
        return (await rex(['send-key', '-s', session, '-b', block, 'enter']))?.code === 0
      } finally {
        sending.delete(pane.id)
      }
    },
  }
}
