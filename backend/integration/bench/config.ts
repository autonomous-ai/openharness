export interface Cadence {
  /** Mean gap between one agent's posts in its project's channel. */
  channelPostMs: number
  /** Mean gap between one agent's chat turns: its person writes in their 1:1 chat, then the agent answers there. */
  chatTurnMs: number
  /** Each machine's report (cli/src/superTabs/machines.ts: 15 s). */
  observeMs: number
  /** Each host's pass over its agents' deliveries, claiming and acknowledging what waits. */
  deliveryPassMs: number
  /** A Desktop window's change read (Flutter super_tabs: 3 s). */
  desktopPollMs: number
  /** The CLI host's tick (cli/src/superTabs/host.ts: 1 s). */
  hostTickMs: number
}

export interface BenchConfig {
  seed: number
  /** Plain agents, each with its 1:1 chat with its person. The first `projects` of them are the projects' PMs. */
  agents: number
  /** Projects, each with its channel and its PM. The Swarm's first project is one of them. */
  projects: number
  /** Machines, each its own person's; person 0 owns the Swarm. Agent n runs on machine n mod machines. */
  machines: number
  durationMs: number
  /** Desktop windows of the first people. */
  desktopReaders: number
  /** CLI hosts of the first machines. */
  hostReaders: number
  every: Cadence
  text: { messageChars: number }
}

/** A Swarm can hold at most this many projects (commands.ts PROJECTS_FULL). */
const MAX_PROJECTS = 100

/** A busy Swarm: 60 agents and 50 projects make 110 conversations (each agent's chat and each project's channel). */
export const DEFAULT_CONFIG: BenchConfig = {
  seed: 1726, agents: 60, projects: 50, machines: 6, durationMs: 120_000, desktopReaders: 3, hostReaders: 2,
  every: { channelPostMs: 20_000, chatTurnMs: 30_000, observeMs: 15_000, deliveryPassMs: 3_000, desktopPollMs: 3_000, hostTickMs: 1_000 },
  text: { messageChars: 300 },
}

/** The read cache's stamps (src/superTabs/cache.ts): in this process ('memory', one backend process), a Redis URL, or 'off'. */
export interface Args { config: BenchConfig; out: string | null; cache: string }

const NUMBERS: Record<string, (config: BenchConfig, value: number) => void> = {
  '--seed': (c, v) => { c.seed = v },
  '--agents': (c, v) => { c.agents = v },
  '--projects': (c, v) => { c.projects = v },
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
  let out: string | null = null, cache = 'memory'
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag in NUMBERS) {
      if (!Number.isFinite(Number(value))) throw new Error(`${flag} needs a number`)
      NUMBERS[flag]!(config, Number(value))
    } else if (flag === '--every') config.every = { ...config.every, ...pairs(flag, value, config.every) }
    else if (flag === '--out') out = value
    else if (flag === '--cache') {
      if (value !== 'memory' && value !== 'off' && !value.startsWith('redis://')) throw new Error('--cache is memory, off or a redis:// URL')
      cache = value
    } else throw new Error(`Unknown option ${flag}`)
  }
  validate(config)
  return { config, out, cache }
}

/** Every conversation the Swarm holds: each agent's chat and each project's channel. */
export const conversationCount = (config: BenchConfig) => config.agents + config.projects

function validate(config: BenchConfig): void {
  if (!Number.isInteger(config.projects) || config.projects < 1 || config.projects > MAX_PROJECTS) {
    throw new Error(`A Swarm holds between 1 and ${MAX_PROJECTS} projects.`)
  }
  if (!Number.isInteger(config.agents) || config.agents < config.projects) throw new Error('Each project needs its PM: at least as many agents as projects.')
  if (!Number.isInteger(config.machines) || config.machines < 1 || config.desktopReaders > config.machines || config.hostReaders > config.machines) {
    throw new Error('Readers are the first people and machines: at most one of each kind per machine.')
  }
}
