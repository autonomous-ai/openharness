import type { AppPick, SwitchCause } from './types.js'

/** How long an app stays in front before the dial follows it: a Cmd-Tab across apps moves nothing. */
export const FRONT_SETTLE_MS = 1_000

/** Each app with agents and how many (`all`), and of those the agents whose app is known (`HostAgent.appPending`): an app
 *  with none is absent from `known` and `inFront`. */
export interface AppCounts {
  all: ReadonlyMap<string, number>
  /** Leaves out a resting agent (`HostAgent.resting`) too: a row with no process weighs nothing in the default. */
  known: ReadonlyMap<string, number>
  /** Keeps a resting agent: the app in front shows its page even when no process runs there (the spec's "dial's default
   *  page", PM 2026-11-19, 1b). */
  inFront: ReadonlyMap<string, number>
}

export interface AppFilterDeps {
  /** Runs `run` once after `ms`; returns its cancel. */
  after(ms: number, run: () => void): () => void
  /** In [0, 1). */
  random(): number
  /** The agents there now, counted at each call: a settle or a pick between two list reads decides on them, never on
   *  the last read's. */
  counts(): AppCounts
  switched(cause: SwitchCause): void
  /** An app stayed in front for FRONT_SETTLE_MS (`settledApp()` already reads it), told after any switch it caused:
   *  `none`, an app with no agents and the same app again too, since what follows the front acts on the settle, not on
   *  what the dial shows. */
  settled(app: string): void
}

const has = (counts: ReadonlyMap<string, number>, app: string): boolean => (counts.get(app) ?? 0) > 0

/** Every agent but the resting ones (in front and not known), while no app has a known agent; all of them when only resting
 *  ones are there, as their page is then all there is to show. */
const awake = (all: ReadonlyMap<string, number>, inFront: ReadonlyMap<string, number>): ReadonlyMap<string, number> => {
  const left = new Map([...all].map(([app, n]) => [app, n - (inFront.get(app) ?? 0)] as const).filter(([, n]) => n > 0))
  return left.size ? left : all
}

const sameCounts = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean =>
  a.size === b.size && [...a].every(([app, n]) => b.get(app) === n)

/**
 * Which app the dial with no Harness window shows: the one the person brought to the front, the one picked on the dial, or
 * the one with the most agents whose app is known. An agent the open scan found, which nothing has told of yet, is on the
 * unknown app's page and counts for nothing in that default: a dial plugged in over many agents already running would
 * otherwise open on that page. It is the default only while no app has a known agent, and gives way once one has; a pick
 * or the front can still show it. The app in front is shown whenever it has known or resting agents and no pick holds, so a
 * default gives way to it. One per cable host, shared by every dial on it. Time and chance come in through `deps`,
 * so a test drives both.
 */
export class AppFilter {
  private showing: string | undefined
  /** Set by a pick on the dial; another app settling in front ends it. */
  private pickedOnDial = false
  /** The default chose the shown app: nobody picked it or brought it to the front. */
  private byDefault = false
  /** A tie is drawn once and held while the counts stay the ones it was drawn over, so the dial does not flip between equals. */
  private tieBreak: { app: string; counts: ReadonlyMap<string, number> } | undefined
  /** The app in front at the last settle. */
  private settledFront: string | undefined
  /** The last value `front` was given: a repeat (a watch telling the app in front again) restarts nothing. */
  private lastFront: string | undefined
  private cancelSettle: (() => void) | undefined

  constructor(private readonly deps: AppFilterDeps) {}

  /**
   * The app shown, `undefined` with no agents. The app in front getting known or resting agents after it settled, the shown app
   * emptying, and the default's page of agents not known yet giving way, are decided here, when the counts are read.
   */
  shown(): string | undefined {
    const { all: counts, known, inFront } = this.deps.counts()
    const front = this.settledFront
    // An agent started in the app the person is using turns the dial to it, over any default (the PM, D1). `none` is no
    // app, so it never has agents.
    if (!this.pickedOnDial && front !== undefined && front !== this.showing && has(inFront, front)) {
      this.byDefault = false
      this.show(front, 'front')
      return this.showing
    }
    if (this.showing !== undefined && has(counts, this.showing) && !this.givesWay(known, this.showing)) return this.showing
    this.pickedOnDial = false
    this.byDefault = true
    this.show(this.fallback(counts, known, inFront), 'empty')
    return this.showing
  }

  front(app: string): void {
    if (app === this.lastFront) return
    this.lastFront = app
    this.cancelSettle?.()
    this.cancelSettle = this.deps.after(FRONT_SETTLE_MS, () => this.settle(app))
  }

  /** The app that last stayed in front for FRONT_SETTLE_MS, whether or not it is shown: a pick on the dial leaves it. */
  settledApp(): string | undefined {
    return this.settledFront
  }

  /** The last app reported in front, at once: what the person looks at now, before the settle filters a Cmd-Tab out. */
  latestFront(): string | undefined {
    return this.lastFront
  }

  pick(app: string, cause: 'pick' | 'notice' = 'pick'): AppPick {
    if (!has(this.deps.counts().all, app)) return 'ignored'
    // Done on the shown app is how a person leaves the picker without changing anything (the PM, D2): it holds nothing.
    if (app === this.showing) return 'same'
    this.pickedOnDial = true
    this.byDefault = false
    this.show(app, cause)
    return 'switched'
  }

  /** Shows `app` and holds it as a pick does, even when it is already shown: `pick` answers `same` there and holds
   *  nothing, so a pick made off the app's own view (the tab) would leave the next app in front free to turn the dial.
   *  False for an app with no agents, and nothing changes. */
  hold(app: string): boolean {
    if (!has(this.deps.counts().all, app)) return false
    this.pickedOnDial = true
    this.byDefault = false
    this.show(app, 'pick')
    return true
  }

  private settle(app: string): void {
    this.cancelSettle = undefined
    if (app !== this.settledFront) {
      this.pickedOnDial = false
      this.settledFront = app
    }
    // `none` (no listed app in front) is no app, so it never has agents and never shows.
    if (!this.pickedOnDial && has(this.deps.counts().all, app)) {
      this.byDefault = false
      this.show(app, 'front')
    }
    this.deps.settled(app)
  }

  /** A page the default chose, none of whose agents is known to be there, once an app has a known agent. */
  private givesWay(known: ReadonlyMap<string, number>, app: string): boolean {
    return this.byDefault && known.size > 0 && !has(known, app)
  }

  private fallback(
    counts: ReadonlyMap<string, number>,
    known: ReadonlyMap<string, number>,
    inFront: ReadonlyMap<string, number>,
  ): string | undefined {
    if (this.settledFront !== undefined && has(counts, this.settledFront)) return this.settledFront
    // Agents not known yet count only when no app has a known one: their page is then all there is to show. Resting ones
    // still weigh nothing, or 16 idle sessions would outweigh the agents the scan found.
    const by = known.size ? known : awake(counts, inFront)
    let most = 0
    let tied: string[] = []
    for (const [app, n] of by) {
      if (n > most) {
        most = n
        tied = [app]
      } else if (n === most && n > 0) tied.push(app)
    }
    if (tied.length < 2) return tied[0]
    if (this.tieBreak && sameCounts(this.tieBreak.counts, by)) return this.tieBreak.app
    const app = tied[Math.floor(this.deps.random() * tied.length)]
    this.tieBreak = { app, counts: new Map(by) }
    return app
  }

  /** The first app shown, when none was, is no switch; nor is going to none when every agent has ended. */
  private show(app: string | undefined, cause: SwitchCause): void {
    const from = this.showing
    this.showing = app
    if (from !== undefined && app !== undefined && from !== app) this.deps.switched(cause)
  }
}
