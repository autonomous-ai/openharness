/**
 * The assignment problem of a Swarm v4 team (anh Dee, 2026-11-09: "N tasks. M machines with cpu ssd token. how do we best
 * assign them"): which builder does which task, with which of its models, and in what order, so the team's work finishes
 * soonest for its priorities, then at the least cost, without a machine, a subscription, a model or a file going past what
 * it has. Pure data, in minutes: schedule.ts builds a plan from a choice, search.ts finds the best choice.
 *
 * It is a multi-mode resource-constrained project scheduling problem (MRCPSP): a task's mode is its builder and model;
 * builders, machines' CPU, memory and disk, models' limits and files are renewable resources; quota windows are spent and
 * refill at their resets. The v3 prototype solved a smaller form of it exactly with CP-SAT (docs/plans/2026-10-27-swarm-
 * scheduler.md, removed in #3621 with v3): on the real night of 2026-10-26 its plan finished 27% sooner than the route and
 * 45-63% sooner with fewer slots. This keeps its formulation and adds what it left out: 5-hour windows, memory and disk,
 * builders that persist, files two builders must not change at once.
 */

/** What a machine has for Swarm work: CPU in cores, memory and disk in bytes, after its person's own reserve. The product's
 *  plan counts no cores (crew.ts SIZES): the design's model still does (docs/design/2026-11-11-swarm-allocator/experiment.mts). */
export interface Resources { cpu: number; ram: number; disk: number }

export interface Machine { id: string; capacity: Resources }

/** One quota window of a subscription: the percent of it left now, the minute it refills to 100, and every how many
 *  minutes after that it refills again (300 for a 5-hour window, 10,080 for a week; null when only the one reset is known). */
export interface QuotaWindow { name: string; left: number; resetsAt: number; every: number | null }

/** A subscription and the percent of each window its person keeps for their own work: Swarm work never spends it. */
export interface Account { id: string; reserve: number; windows: QuotaWindow[] }

/**
 * One way a builder can do a task: a model, its family (a review is never done by its build's family), how fast it is
 * (minutes at speed 1 divided by this), its policy cost for one minute, its quality by task kind (`default` for the rest),
 * the subscription it spends (null for none), and how many tasks it may run at once across the team (a local model serves
 * one; none for no limit).
 */
export interface Mode { model: string; family: string; speed: number; cost: number; quality: Record<string, number>; account: string | null
  limit?: number }

export interface Builder {
  id: string
  machine: string
  modes: Mode[]
  /** How fast it is on a part, as a factor of its time (0.5: twice as fast): from what its person says it works on
   *  (crew.ts contextOf). A part it is not listed for takes 1. */
  context: Record<string, number>
  /** The minute it is free of work the plan does not move: its task in progress. */
  busyUntil: number
}

export interface Task {
  id: string
  /** Minutes at speed 1, and what it holds of its machine while it runs. */
  minutes: number
  needs: Resources
  /** Percent of each quota window it spends at policy cost 2 (the route's scale), by window name: the room it must find
   *  there to start, so its class's 90th percentile once classes are learned, and its size's guess until then. */
  spend: Record<string, number>
  /** The least quality it takes, and the kind its quality is read for. */
  floor: number
  kind: string
  part?: string
  /** Its priority's weight in the plan's score. */
  weight: number
  /** The minute it may start, and the tasks that must end first. */
  ready: number
  deps: string[]
  /** Tasks it must not share a model family with (a review and its build), and builders it never goes to, and why (by
   *  default, its author). */
  independentOf: string[]
  notBuilders: string[]
  notWhy?: string
  /** Files or folders it is expected to change: two tasks sharing one never run at once on two builders. */
  files: string[]
  /** The only builder it goes to (a person asked for it). */
  pinned?: string
  /** The builder it is queued on now: moving it costs the problem's `switchCost`, so plans do not churn. */
  queuedOn?: string
}

/** `weighted`: least priority-weighted finish time, then cost (the team's day). `makespan`: least time the last task ends,
 *  then cost (the v3 prototype's objective, for comparing with its proven optimum). */
export type Objective = 'weighted' | 'makespan'

export interface Problem { now: number; machines: Machine[]; accounts: Account[]; builders: Builder[]; tasks: Task[]; objective?: Objective
  switchCost?: number }

/** Where one task goes: its builder, the index of the mode it runs in, and the minutes it starts and ends. */
export interface Placement { task: string; builder: string; mode: number; start: number; end: number }

export interface Plan {
  placements: Placement[]
  /** Tasks with no builder that can ever do them, each with why. */
  unplaced: Array<{ task: string; why: string }>
  score: number
  makespan: number
  /** Policy cost × minutes, the v3 prototype's measure. */
  cost: number
  /** Each task's spend of its subscription's windows, in percent, at each window's price (schedule.ts priceOf). */
  priced: number
}

/** A candidate the search moves through: the order tasks are placed in, and each one's builder and mode. */
export interface Choice { order: string[]; builder: Record<string, string>; mode: Record<string, number> }
