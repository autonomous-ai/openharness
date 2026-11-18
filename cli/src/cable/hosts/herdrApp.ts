/**
 * Herdr (docs/plans/2026-11-16-herdr-app-design.md): the window of Herdr.app, whose terminals run in Herdr Core (hc,
 * hcClient.ts). A tap opens Herdr, then switches its window to the agent's terminal; a rest with Herdr in front switches
 * it alone; the dial's words go over hc's socket. macOS only: Herdr's window elsewhere is not tried.
 *
 * A tap opens Herdr first: hc keeps running when Herdr's window is closed, and the window must be up to switch. `open`
 * runs by its own path (open.ts openPath), so no `open` earlier on PATH runs instead, and
 * `herdr-app` with no shell, each value one argument. The address came from a hook or from hc, so it is held to hc's
 * form again before either runs. Once `open` came back Herdr is in front, so a tap whose switch fails is still a tap
 * that came: a window still opening may not take the switch yet, and the log says so.
 *
 * Words do not wait for a tap, nor a tap for words: hc types by address, whatever the window shows.
 *
 * A stroke on the dial scrolls Herdr's view of a terminal through `herdr-app do terminal.scroll`. A `herdr-app` run took
 * 10–50 ms (`herdr-app commands`, which does not reach the window: 5 runs on Diego's Mac, 2026-11-17; a scroll's own is
 * not measured), so it has 2 s, where a focus's 10 s would freeze a stroke. One run at a time per terminal, and one every
 * 50 ms at most, the lines that come meanwhile carried by the next: a fast stroke costs at most 20 processes a second,
 * not one per dial frame. Its queue is its own: a scroll that joined an `agent.focus` run would lose its lines.
 *
 * Claude Code 2.1.327 draws on the alternate screen, where Herdr's view has no history: `terminal.scroll` moved
 * nothing on Diego's second check (2026-11-18). Its own `pageup` and `pagedown` move its transcript a page, so a Claude
 * Code terminal's lines press those, one per page of lines, through hc's socket on the same queue, and none while it
 * asks: a key would move its question's highlighted choice, and the person's Enter would pick it. That is asked at the
 * stroke's down and again right before each call, as hc tells it then: a question can come up mid-stroke. A status hc
 * has not told (a word it adds later, or none heard since its subscription dropped) may be a question too. hc presses
 * at once while a program writes (about 35 ms a key, measured 2026-11-18), so a working Claude Code takes them too.
 *
 * Which terminal is on screen is the window's alone: hc's terminal facts have no focus or viewer. So a stroke asks
 * `herdr-app status` (one run took 0.04 s) and reads its `tab` alone, the tab on screen, which it matches with the
 * terminal's `herdr.tab` label in hc. Its `agent` is not what is on screen: on Diego's first check (2026-11-18) it still
 * named the agent of the tab before, and a stroke ran 175 scrolls on a terminal nobody saw. The rest names the person's
 * spaces and layouts. One read at a time, shared by every ask meanwhile: a dial may send `down` after `down` faster than
 * it answers.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { HC_TERMINAL, hcPaneKey, type HcClient, type HcPrompt, type HcStatus } from './hcClient.js'
import { APP_BUNDLES, inHerdr } from './hostDetect.js'
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { PaneSwitch } from './types.js'

/** Herdr.app's own binary, which ~/.local/bin/herdr-app links to. */
export const HERDR_APP = '/Applications/Herdr.app/Contents/MacOS/Herdr'

const SCROLL_TIMEOUT_MS = 2_000
/** The least time from one run's start to the next's for a terminal (PM, 2026-11-18): Diego's first check logged 109 runs
 *  for 161 lines in about 3 s, about 40 processes a second carrying a line or two each. */
const SCROLL_GAP_MS = 50
/** The most lines that wait, either way, for a terminal's run under way or its gap: a run that hangs to its deadline is
 *  followed by a bounded jump, not by all the travel of the stroke meanwhile. */
const SCROLL_PENDING_MAX = 100
/** How long a terminal's scrolling is quiet before its tally is said: a run is faster than the dial's line, so a queue
 *  drains after almost every line, and a line at each drain would bury the log while scrolling. */
const SCROLL_QUIET_MS = 1_000
/** The dial lines a Claude Code page key stands for (PM, 2026-11-18): a page moved 19 lines at 46 rows, but at 20 lines a
 *  key Diego's strokes under 20 lines pressed nothing, so about half a screen follows about 8 lines of the finger. */
const SCROLL_PAGE_LINES = 8
/** The most page keys in one call: as many pages as the lines that may wait. hc presses them one by one, about 35 ms
 *  each. */
const SCROLL_KEYS_MAX = Math.trunc(SCROLL_PENDING_MAX / SCROLL_PAGE_LINES)
/** A key call's deadline, past hc's hold: hc presses keys only once 3 s have passed since the person's own last key in
 *  Herdr's window, and presses them then even if their call was given up (measured on a private core, 2026-11-18). So
 *  a held call is waited for, not counted failed while its keys still go in, and the next call is asked about after
 *  they landed. */
const SCROLL_KEYS_TIMEOUT_MS = 5_000
/** hc's `claude-code` app, as the client reads it (hcClient.ts hcKind). */
const CLAUDE_CODE = 'claude'

export interface HerdrAppDeps extends OrcaDeps {
  client: Pick<HcClient, 'prompt' | 'keys'>
  /** Herdr is the app in front. */
  inFront(): boolean
  /** Whether Herdr's window shows that terminal: a live one labeled `herdr.space`, with an agent or none (hcSource.ts
   *  shows). */
  shows(address: string): boolean
  /** The tab of Herdr's window that holds that terminal, its `herdr.tab` label, for a terminal it shows (hcSource.ts
   *  tabOf). */
  tabOf(address: string): string | undefined
  /** The kind and hc's status of the agent in a terminal Herdr's window shows (hcSource.ts kindOf, statusOf). */
  kindOf(address: string): string | undefined
  statusOf(address: string): HcStatus | undefined
  /** Whether hc reports an agent's status for that live terminal, shown or not (hcSource.ts reports). */
  reports(address: string): boolean
  /** The devices follow the default hc session, the one session whose addresses the hook sends (notify.mjs): another
   *  session counts its terminals from t1 again, where a hook's address is another agent's. None: no hook's is taken. */
  hookIds?: boolean
  log(line: string): void
  /** The raw `HARNESS_OPEN_BIN` (open.ts openPath). */
  bin?: string
}

export interface HerdrAppAdapter extends HostAdapter {
  canShow(pane: Pane): boolean
  show(pane: Pane, agentId: string): Promise<PaneSwitch>
  paneKey(pane: Pane): string
  /** The dial's words for that terminal: the hc source's door too (hcSource.ts). */
  prompt(address: string, kind: string, text: string): Promise<HcPrompt>
  /** Where `herdr-app` is: on PATH, else Herdr.app's own binary. None: Herdr is not installed. */
  binary(): string | null
  canScroll(pane: Pane): boolean
  onScreen(pane: Pane): Promise<boolean>
  scroll(pane: Pane, lines: number): void
  /** The devices stopping: no scroll run starts from here on, whatever a queue holds (devices.ts stop). */
  stop(): void
}

/** What a run did: whether Herdr is forward, and whether its window switched to the terminal. */
interface Run { forward: boolean; switched: boolean }

/** A terminal's scroll queue until it has been quiet for SCROLL_QUIET_MS: whether it is draining (a run under way, or the
 *  wait for the gap before one), the lines that wait (a Claude Code terminal's short of a page too), the gap since
 *  its last run started while it lasts, what it did since it started, for the line it says once quiet, and the timer
 *  of that quiet. */
interface Scrolling {
  running: boolean
  pending: number
  gap?: Promise<void>
  lines: number
  runs: number
  failed: number
  quiet?: ReturnType<typeof setTimeout>
}

export function createHerdrAppAdapter(deps: HerdrAppDeps): HerdrAppAdapter {
  const mac = deps.platform === 'darwin'
  const openBin = openPath(deps.bin)
  // Per terminal, the run under way, which a second tap or a rest joins: a swipe's rest and a tap just after it switch
  // to the same terminal.
  const running = new Map<string, Promise<Run>>()
  // Per terminal, the words under way: two transcripts typed at once would mix in the agent's prompt.
  const prompting = new Set<string>()
  // Per terminal, its scroll queue until it has been quiet for SCROLL_QUIET_MS.
  const scrolling = new Map<string, Scrolling>()
  // A stroke sends many lines: the failure is said once until a scroll run succeeds, not once a frame.
  let scrollFailedSaid = false
  // The `status` read under way, which every ask meanwhile joins: the tab on screen, or null.
  let reading: Promise<string | null> | undefined
  // As a scroll's: said once until a read succeeds.
  let statusFailedSaid = false
  // The devices began to stop: the lines a queue holds for its gap or behind a run under way never run.
  let stopped = false

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

  const within = (value: number, most: number): number => Math.max(-most, Math.min(most, value))
  const byKeys = (address: string): boolean => deps.kindOf(address) === CLAUDE_CODE
  // hc's `blocked` is a question on Claude Code's screen, and a status it has not told may be one.
  const asks = (address: string): boolean => {
    const status = deps.statusOf(address)
    return byKeys(address) && (status === undefined || status === 'blocked')
  }

  // Nobody awaits a scroll, so a run that rejects is a failed run: a rejection left unhandled would end the devices. A
  // Claude Code terminal's run is a call to hc's socket, and needs no `herdr-app`.
  const scrollRun = async (address: string, lines: number, keys: boolean, queue: Scrolling): Promise<boolean> => {
    const herdrApp = keys ? undefined : binary()
    if (herdrApp === null) return false
    queue.runs++
    // On the timer the quiet second uses, never a sleep. It counts from the run's start: a run longer than the gap holds
    // the next by itself.
    queue.gap = new Promise((resolve) => setTimeout(() => {
      queue.gap = undefined
      resolve()
    }, SCROLL_GAP_MS))
    try {
      if (herdrApp !== undefined) {
        return (await deps.run(herdrApp, ['do', 'terminal.scroll', '--terminal', address, '--lines', String(lines)], SCROLL_TIMEOUT_MS)).code === 0
      }
      const key = lines < 0 ? 'pageup' : 'pagedown'
      return await deps.client.keys(address, Array<string>(Math.abs(lines) / SCROLL_PAGE_LINES).fill(key), SCROLL_KEYS_TIMEOUT_MS)
    } catch {
      return false
    }
  }

  // Its lines are dropped on a failure, never retried: a run that timed out may still have scrolled. The line names no
  // terminal: hc's addresses are a person's agents.
  const drain = async (address: string, queue: Scrolling): Promise<void> => {
    while (!stopped) {
      const keys = byKeys(address)
      // A run takes every line that waits; a Claude Code terminal's, its whole pages, SCROLL_KEYS_MAX at most, and the
      // rest waits for that terminal's next lines.
      const lines = keys
        ? within(Math.trunc(queue.pending / SCROLL_PAGE_LINES), SCROLL_KEYS_MAX) * SCROLL_PAGE_LINES
        : queue.pending
      if (lines === 0) break
      // The lines that come while it waits for the gap are summed into the next run, or cancel out.
      if (queue.gap) {
        await queue.gap
        continue
      }
      // Right before the call, as hc tells it now: a Claude Code that began to ask since the stroke's down takes none of
      // its keys, and what waits is dropped. Not a failure of hc's: the tally counts it, and no failed line is said.
      if (asks(address)) {
        queue.failed += Math.abs(queue.pending)
        queue.pending = 0
        break
      }
      queue.pending = within(queue.pending - lines, SCROLL_PENDING_MAX)
      if (!(await scrollRun(address, lines, keys, queue))) {
        queue.failed += Math.abs(lines) + Math.abs(queue.pending)
        queue.pending = 0
        if (!scrollFailedSaid) deps.log('[herdr-app] scroll · failed')
        scrollFailedSaid = true
        break
      }
      scrollFailedSaid = false
      queue.lines += Math.abs(lines)
    }
    queue.running = false
    queue.quiet = setTimeout(() => {
      scrolling.delete(address)
      // A Claude Code terminal's lines short of a key go with its quiet second: counted, so a stroke too short is seen.
      queue.failed += Math.abs(queue.pending)
      deps.log(`[herdr-app] scroll · ${queue.lines} lines · ${queue.runs} runs · ${queue.failed} failed`)
    }, SCROLL_QUIET_MS)
  }

  // A failed read is undefined: no binary, an exit that is not 0, a rejection, or a stdout that is no JSON object.
  const readStatus = async (): Promise<Record<string, unknown> | undefined> => {
    const herdrApp = binary()
    if (herdrApp === null) return undefined
    try {
      const { code, stdout } = await deps.run(herdrApp, ['status'], SCROLL_TIMEOUT_MS)
      const status: unknown = code === 0 ? JSON.parse(stdout) : undefined
      return typeof status === 'object' && status !== null && !Array.isArray(status) ? status as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  // A Herdr that changes what `status` prints must be seen, so a stdout that is no object is said; a tab missing or
  // empty is no tab on screen, and says nothing.
  const readTab = async (): Promise<string | null> => {
    const status = await readStatus()
    if (status === undefined) {
      if (!statusFailedSaid) deps.log('[herdr-app] status · failed')
      statusFailedSaid = true
      return null
    }
    statusFailedSaid = false
    return typeof status.tab === 'string' && status.tab !== '' ? status.tab : null
  }

  const onScreen = async (pane: Pane): Promise<boolean> => {
    if (!mac || !HC_TERMINAL.test(pane.id)) return false
    reading ??= readTab().finally(() => { reading = undefined })
    // No tab on screen (null) matches no terminal, and a terminal with no `herdr.tab` label (none) no tab.
    return (await reading) === deps.tabOf(pane.id)
  }

  const scroll = (pane: Pane, lines: number): void => {
    if (!mac || !HC_TERMINAL.test(pane.id) || lines === 0 || !Number.isSafeInteger(lines)) return
    const queue = scrolling.get(pane.id) ?? { running: false, pending: 0, lines: 0, runs: 0, failed: 0 }
    clearTimeout(queue.quiet)
    if (queue.running) {
      queue.pending = within(queue.pending + lines, SCROLL_PENDING_MAX)
      return
    }
    queue.running = true
    // Any terminal's queue holds no line once drained but a Claude Code terminal's short of a page, which this joins.
    queue.pending += lines
    scrolling.set(pane.id, queue)
    void drain(pane.id, queue)
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
    // A hint's address is Herdr's only in hc's own terminal, never in a program started from it.
    paneOf(place: Place): Pane | undefined {
      if (!mac || deps.hookIds !== true || place.host !== 'herdr' || !inHerdr(place.hints)) return undefined
      return { adapter: 'herdr-app', id: place.hints.HC_TERMINAL_ID }
    },
    // Every hc terminal has HC_TERMINAL_ID, hidden `hc run` workers too, and the window shows those not.
    canFocus: (pane) => mac && deps.shows(pane.id),
    // Asked at each look: Herdr may have left the front since the last one.
    canShow: (pane) => mac && deps.inFront() && deps.shows(pane.id),
    async focus(pane) {
      if (!mac || !HC_TERMINAL.test(pane.id)) return false
      const run = await once(pane.id, async () => {
        if ((await deps.run(openBin, ['-b', APP_BUNDLES.herdr], RUN_TIMEOUT_MS)).code !== 0) return { forward: false, switched: false }
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
      // hc types into any terminal by its address: one whose program reports no agent's status is at no agent's prompt.
      canType: (pane: Pane) => deps.reports(pane.id),
    } : {}),
    // Asked at each stroke's down: the PATH lookup last, so it runs only for a pane that passed the rest. A Claude Code
    // terminal still needs `herdr-app`, whose `status` says its tab is on screen.
    canScroll: (pane) => mac && HC_TERMINAL.test(pane.id) && deps.inFront() && deps.shows(pane.id) && !asks(pane.id)
      && binary() !== null,
    onScreen,
    scroll,
    paneKey: (pane) => hcPaneKey(pane.id),
    prompt,
    binary,
    stop: () => { stopped = true },
  }
}
