import type { AppPick, SwitchCause } from './types.js'

/** How long an app stays in front before the dial follows it: a Cmd-Tab across apps moves nothing. */
export const FRONT_SETTLE_MS = 1_000

export interface AppFilterDeps {
  /** Runs `run` once after `ms`; returns its cancel. */
  after(ms: number, run: () => void): () => void
  /** In [0, 1). */
  random(): number
  /** Each app with agents and how many, as last read. */
  counts(): ReadonlyMap<string, number>
  switched(cause: SwitchCause): void
}

const has = (counts: ReadonlyMap<string, number>, app: string): boolean => (counts.get(app) ?? 0) > 0

const sameCounts = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean =>
  a.size === b.size && [...a].every(([app, n]) => b.get(app) === n)

/**
 * Which app the dial with no Harness window shows: the one the person brought to the front, the one picked on the dial, or
 * the one with the most agents. One per cable host, shared by every dial on it. Time and chance come in through `deps`, so
 * a test drives both.
 */
export class AppFilter {
  private showing: string | undefined
  /** Set by a pick on the dial; another app settling in front ends it. */
  private pickedOnDial = false
  /** A tie is drawn once and held while the counts stay the ones it was drawn for, so the dial does not flip between equals. */
  private tieBreak: { app: string; counts: ReadonlyMap<string, number> } | undefined
  /** The app in front at the last settle. */
  private settledFront: string | undefined
  /** The last value `front` was given: a repeat (a watch telling the app in front again) restarts nothing. */
  private lastFront: string | undefined
  private cancelSettle: (() => void) | undefined

  constructor(private readonly deps: AppFilterDeps) {}

  /** The app shown, `undefined` with no agents. The shown app emptying is decided here, when the counts are read. */
  shown(): string | undefined {
    const counts = this.deps.counts()
    if (this.showing !== undefined && has(counts, this.showing)) return this.showing
    this.pickedOnDial = false
    this.show(this.fallback(counts), 'empty')
    return this.showing
  }

  front(app: string): void {
    if (app === this.lastFront) return
    this.lastFront = app
    this.cancelSettle?.()
    this.cancelSettle = this.deps.after(FRONT_SETTLE_MS, () => this.settle(app))
  }

  pick(app: string, cause: 'pick' | 'notice' = 'pick'): AppPick {
    if (!has(this.deps.counts(), app)) return 'ignored'
    if (app === this.showing) return 'same'
    this.pickedOnDial = true
    this.show(app, cause)
    return 'switched'
  }

  stop(): void {
    this.cancelSettle?.()
    this.cancelSettle = undefined
  }

  private settle(app: string): void {
    this.cancelSettle = undefined
    if (app !== this.settledFront) {
      this.pickedOnDial = false
      this.settledFront = app
    }
    // `none` (no listed app in front) is no app, so it never has agents and never shows.
    if (!this.pickedOnDial && has(this.deps.counts(), app)) this.show(app, 'front')
  }

  private fallback(counts: ReadonlyMap<string, number>): string | undefined {
    if (this.settledFront !== undefined && has(counts, this.settledFront)) return this.settledFront
    let most = 0
    let tied: string[] = []
    for (const [app, n] of counts) {
      if (n > most) {
        most = n
        tied = [app]
      } else if (n === most && n > 0) tied.push(app)
    }
    if (tied.length < 2) return tied[0]
    if (this.tieBreak && sameCounts(this.tieBreak.counts, counts)) return this.tieBreak.app
    const app = tied[Math.floor(this.deps.random() * tied.length)]
    this.tieBreak = { app, counts: new Map(counts) }
    return app
  }

  /** The first app shown, when none was, is no switch; nor is going to none when every agent has ended. */
  private show(app: string | undefined, cause: SwitchCause): void {
    const from = this.showing
    this.showing = app
    if (from !== undefined && app !== undefined && from !== app) this.deps.switched(cause)
  }
}
