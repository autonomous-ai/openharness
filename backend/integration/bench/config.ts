export const WORKER_ACTIONS = ['message.send', 'work.status', 'work.check'] as const
export type WorkerAction = typeof WORKER_ACTIONS[number]

/**
 * `mixed` is the busy Swarm: each worker's posts and its terminal run side by side in its group, and the Lead messages it
 * there. `cross-group` keeps one writer per group at a time (a worker's posts and turns run in one sequence; no Lead
 * messages, no delivery passes), so any conflict between agents is between different groups (#1726 goal 1). Machine
 * reports stay: after the parts change they write only their machine's part.
 */
export const LANES = ['mixed', 'cross-group'] as const
export type Lane = typeof LANES[number]

export interface Cadence {
  /** Mean gap between one worker's posts in its own group. */
  workerPostMs: number
  /** Mean gap between the Lead's messages to a worker (each one a delivery). */
  leadSendMs: number
  /** Mean gap between one worker's terminal turns (a prompt and an answer, each recorded). */
  nativeTurnMs: number
  /** Each contributed machine's report (cli/src/superTabs/machines.ts: 15 s). */
  observeMs: number
  /** Each host's pass over its agents' deliveries, claiming and acknowledging what waits. */
  deliveryPassMs: number
  /** Desktop and web poll the full state (Flutter super_tabs: 3 s). */
  desktopPollMs: number
  /** The CLI host's roster tick (cli/src/superTabs/host.ts: 1 s). */
  hostTickMs: number
}

export interface BenchConfig {
  seed: number
  /** Work groups besides the Leads group. */
  groups: number
  /** The share of groups whose work is done before the load starts. Every other group is active, with its own worker. */
  doneShare: number
  /** Workers, each with its own active groups: one when there are as many workers as active groups (the default). */
  workers: number
  lane: Lane
  /** Contributed machines, each owned by its own person; the Swarm owner's is machine 0 and runs the Lead. */
  machines: number
  durationMs: number
  /** Desktop windows of the first people (the owner, then machine owners). */
  desktopReaders: number
  /** CLI hosts of the first machines reading their roster. */
  hostReaders: number
  /** Relative weights of a worker's posts. */
  mix: Record<WorkerAction, number>
  every: Cadence
  /** Text sizes, so the state has the size of a real Swarm (#1726: 1.16 MB with 195 groups). */
  text: { briefChars: number; resultChars: number; messageChars: number }
}

export const DEFAULT_CONFIG: BenchConfig = {
  seed: 1726, groups: 200, doneShare: 0.9, workers: 20, lane: 'mixed', machines: 6, durationMs: 120_000, desktopReaders: 3, hostReaders: 2,
  mix: { 'message.send': 2, 'work.status': 1, 'work.check': 1 },
  every: { workerPostMs: 4_000, leadSendMs: 5_000, nativeTurnMs: 10_000, observeMs: 15_000, deliveryPassMs: 3_000, desktopPollMs: 3_000, hostTickMs: 1_000 },
  text: { briefChars: 3_000, resultChars: 600, messageChars: 300 },
}

export interface Args { config: BenchConfig; out: string | null; driver: string }

const NUMBERS: Record<string, (config: BenchConfig, value: number) => void> = {
  '--seed': (c, v) => { c.seed = v },
  '--groups': (c, v) => { c.groups = v },
  '--done-share': (c, v) => { c.doneShare = v },
  '--workers': (c, v) => { c.workers = v },
  '--machines': (c, v) => { c.machines = v },
  '--duration': (c, v) => { c.durationMs = v * 1000 },
  '--desktop-readers': (c, v) => { c.desktopReaders = v },
  '--host-readers': (c, v) => { c.hostReaders = v },
}

/** `key=number,key=number`, only for keys [known] has. */
function pairs<T extends object>(flag: string, text: string, known: T): Partial<T> {
  const result: Record<string, number> = {}
  for (const pair of text.split(',')) {
    const [key, value] = pair.split('=')
    if (!key || !(key in known) || !Number.isFinite(Number(value))) throw new Error(`${flag}: unknown or invalid "${pair}"`)
    result[key] = Number(value)
  }
  return result as Partial<T>
}

export function parseArgs(argv: readonly string[]): Args {
  const config: BenchConfig = structuredClone(DEFAULT_CONFIG)
  let out: string | null = null, driver = 'parts'
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag in NUMBERS) {
      if (!Number.isFinite(Number(value))) throw new Error(`${flag} needs a number`)
      NUMBERS[flag]!(config, Number(value))
    } else if (flag === '--mix') config.mix = { ...config.mix, ...pairs(flag, value, config.mix) }
    else if (flag === '--every') config.every = { ...config.every, ...pairs(flag, value, config.every) }
    else if (flag === '--lane') {
      if (!(LANES as readonly string[]).includes(value)) throw new Error(`--lane is one of ${LANES.join(', ')}`)
      config.lane = value as Lane
    } else if (flag === '--out') out = value
    else if (flag === '--driver') driver = value
    else throw new Error(`Unknown option ${flag}`)
  }
  validate(config)
  return { config, out, driver }
}

export function activeCount(config: BenchConfig): number {
  return config.groups - Math.round(config.groups * config.doneShare)
}

function validate(config: BenchConfig): void {
  if (config.doneShare < 0 || config.doneShare > 1 || activeCount(config) < 1) throw new Error('The Swarm needs at least one active group.')
  if (!Number.isInteger(config.workers) || config.workers < 1 || config.workers > activeCount(config)) {
    throw new Error('Each worker needs an active group: between 1 worker and one per active group.')
  }
  if (config.machines < 1 || config.desktopReaders > config.machines || config.hostReaders > config.machines) {
    throw new Error('Readers are the first people and machines: at most one of each kind per machine.')
  }
  if (!WORKER_ACTIONS.some(action => config.mix[action] > 0)) throw new Error('The mix needs at least one action with weight above 0.')
}
