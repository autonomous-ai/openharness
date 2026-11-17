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
 * not measured), so it has 2 s, where a focus's 10 s would freeze a stroke. One run at a time per terminal, the lines
 * that come meanwhile carried by the next: a fast stroke costs one process per round trip, not one per dial frame. Its
 * queue is its own: a scroll that joined an `agent.focus` run would lose its lines.
 *
 * Which terminal is on screen is the window's alone: hc's terminal facts have no focus or viewer. So a stroke asks
 * `herdr-app status` (one run took 0.04 s) and reads its `agent` alone: the rest names the person's spaces and layouts.
 * One read at a time, shared by every ask meanwhile: a dial may send `down` after `down` faster than it answers.
 */
import type { HostAdapter, Pane, Place } from './adapter.js'
import { HC_TERMINAL, hcPaneKey, type HcClient, type HcPrompt } from './hcClient.js'
import { APP_BUNDLES, inHerdr } from './hostDetect.js'
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import type { PaneSwitch } from './types.js'

/** Herdr.app's own binary, which ~/.local/bin/herdr-app links to. */
export const HERDR_APP = '/Applications/Herdr.app/Contents/MacOS/Herdr'

const SCROLL_TIMEOUT_MS = 2_000
/** The most lines that wait, either way, for a terminal's run under way: a run that hangs to its deadline is followed by a
 *  bounded jump, not by all the travel of the stroke meanwhile. */
const SCROLL_PENDING_MAX = 100
/** How long a terminal's scrolling is quiet before its tally is said: a run is faster than the dial's line, so a queue
 *  drains after almost every line, and a line at each drain would bury the log while scrolling. */
const SCROLL_QUIET_MS = 1_000

export interface HerdrAppDeps extends OrcaDeps {
  client: Pick<HcClient, 'prompt'>
  /** Herdr is the app in front. */
  inFront(): boolean
  /** Whether Herdr's window shows that terminal: a live one labeled `herdr.space`, with an agent or none (hcSource.ts
   *  shows). */
  shows(address: string): boolean
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
}

/** What a run did: whether Herdr is forward, and whether its window switched to the terminal. */
interface Run { forward: boolean; switched: boolean }

/** A terminal's scroll queue until it has been quiet for SCROLL_QUIET_MS: whether a run is under way, the lines that came
 *  meanwhile, what it did since it started, for the line it says once quiet, and the timer of that quiet. */
interface Scrolling {
  running: boolean
  pending: number
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
  // The `status` read under way, which every ask meanwhile joins: its agent, or null.
  let reading: Promise<string | null> | undefined
  // As a scroll's: said once until a read succeeds.
  let statusFailedSaid = false

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

  // Nobody awaits a scroll, so a run that rejects is a failed run: a rejection left unhandled would end the devices.
  const scrollRun = async (address: string, lines: number, queue: Scrolling): Promise<boolean> => {
    const herdrApp = binary()
    if (herdrApp === null) return false
    queue.runs++
    try {
      return (await deps.run(herdrApp, ['do', 'terminal.scroll', '--terminal', address, '--lines', String(lines)], SCROLL_TIMEOUT_MS)).code === 0
    } catch {
      return false
    }
  }

  // Its lines are dropped on a failure, never retried: a run that timed out may still have scrolled. The line names no
  // terminal: hc's addresses are a person's agents.
  const drain = async (address: string, queue: Scrolling, first: number): Promise<void> => {
    let lines = first
    while (lines !== 0) {
      if (!(await scrollRun(address, lines, queue))) {
        queue.failed += Math.abs(lines) + Math.abs(queue.pending)
        queue.pending = 0
        if (!scrollFailedSaid) deps.log('[herdr-app] scroll · failed')
        scrollFailedSaid = true
        break
      }
      scrollFailedSaid = false
      queue.lines += Math.abs(lines)
      lines = queue.pending
      queue.pending = 0
    }
    queue.running = false
    queue.quiet = setTimeout(() => {
      scrolling.delete(address)
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

  // A Herdr that changes what `status` prints must be seen, so a stdout that is no object is said; an agent missing or
  // another is a terminal not on screen, and says nothing.
  const readAgent = async (): Promise<string | null> => {
    const status = await readStatus()
    if (status === undefined) {
      if (!statusFailedSaid) deps.log('[herdr-app] status · failed')
      statusFailedSaid = true
      return null
    }
    statusFailedSaid = false
    return typeof status.agent === 'string' ? status.agent : null
  }

  const onScreen = async (pane: Pane): Promise<boolean> => {
    if (!mac || !HC_TERMINAL.test(pane.id)) return false
    reading ??= readAgent().finally(() => { reading = undefined })
    return (await reading) === pane.id
  }

  const scroll = (pane: Pane, lines: number): void => {
    if (!mac || !HC_TERMINAL.test(pane.id) || lines === 0 || !Number.isSafeInteger(lines)) return
    const queue = scrolling.get(pane.id) ?? { running: false, pending: 0, lines: 0, runs: 0, failed: 0 }
    clearTimeout(queue.quiet)
    if (queue.running) {
      queue.pending = Math.max(-SCROLL_PENDING_MAX, Math.min(SCROLL_PENDING_MAX, queue.pending + lines))
      return
    }
    queue.running = true
    scrolling.set(pane.id, queue)
    void drain(pane.id, queue, lines)
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
    // Asked at each stroke's down: the PATH lookup last, so it runs only for a pane that passed the rest.
    canScroll: (pane) => mac && HC_TERMINAL.test(pane.id) && deps.inFront() && deps.shows(pane.id) && binary() !== null,
    onScreen,
    scroll,
    paneKey: (pane) => hcPaneKey(pane.id),
    prompt,
    binary,
  }
}
