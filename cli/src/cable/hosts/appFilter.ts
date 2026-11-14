import type { AppPick, SwitchCause } from './types.js'

/** How long an app stays in front before the dial follows it: a Cmd-Tab across apps moves nothing. */
export const FRONT_SETTLE_MS = 1_000

/** Each app with agents and how many (`all`), and of those the agents whose app is known (`HostAgent.appPending`): an app
 *  with none is absent from `known`. */
export interface AppCounts {
  all: ReadonlyMap<string, number>
  known: ReadonlyMap<string, number>
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
}

const has = (counts: ReadonlyMap<string, number>, app: string): boolean => (counts.get(app) ?? 0) > 0

const sameCounts = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean =>
  a.size === b.size && [...a].every(([app, n]) => b.get(app) === n)

/**
 * Which app the dial with no Harness window shows: the one the person brought to the front, the one picked on the dial, or
 * the one with the most agents whose app is known. An agent the open scan found, which nothing has told of yet, is on the
 * unknown app's page and counts for nothing in that default: a dial plugged in over many agents already running would
 * otherwise open on that page. It is the default only while no app has a known agent, and gives way once one has; a pick
 * or the front can still show it. The app in front is shown whenever it has known agents and no pick holds, so a default
 * gives way to it. One per cable host, shared by every dial on it. Time and chance come in through `deps`,
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
   * The app shown, `undefined` with no agents. The app in front getting known agents after it settled, the shown app
   * emptying, and the default's page of agents not known yet giving way, are decided here, when the counts are read.
   */
  shown(): string | undefined {
    const { all: counts, known } = this.deps.counts()
    const front = this.settledFront
    // An agent started in the app the person is using turns the dial to it, over any default (the PM, D1). `none` is no
    // app, so it never has agents.
    if (!this.pickedOnDial && front !== undefined && front !== this.showing && has(known, front)) {
      this.byDefault = false
      this.show(front, 'front')
      return this.showing
    }
    if (this.showing !== undefined && has(counts, this.showing) && !this.givesWay(known, this.showing)) return this.showing
    this.pickedOnDial = false
    this.byDefault = true
    this.show(this.fallback(counts, known), 'empty')
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

  pick(app: string, cause: 'pick' | 'notice' = 'pick'): AppPick {
    if (!has(this.deps.counts().all, app)) return 'ignored'
    // Done on the shown app is how a person leaves the picker without changing anything (the PM, D2): it holds nothing.
    if (app === this.showing) return 'same'
    this.pickedOnDial = true
    this.byDefault = false
    this.show(app, cause)
    return 'switched'
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
  }

  /** A page the default chose, none of whose agents is known to be there, once an app has a known agent. */
  private givesWay(known: ReadonlyMap<string, number>, app: string): boolean {
    return this.byDefault && known.size > 0 && !has(known, app)
  }

  private fallback(counts: ReadonlyMap<string, number>, known: ReadonlyMap<string, number>): string | undefined {
    if (this.settledFront !== undefined && has(counts, this.settledFront)) return this.settledFront
    // Agents not known yet count only when no app has a known one: their page is then all there is to show.
    const by = known.size ? known : counts
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
