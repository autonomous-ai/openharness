/**
 * Which experiments are on as the core starts (core/api.ts `EXPERIMENTS`): one whose saved state is in the
 * data folder is asked for at once, so that what it does on its own (a saved project's queued work) goes on
 * after a restart, as it did when it ran in the core's process. One without waits for its first request: off,
 * it has no process. Read once, at start, and bounded: a name or a folder listing.
 *
 * Agent Messages was the one experiment a Settings ▸ Agents switch started, and it is no longer one: it runs in the
 * edge host and sleeps while it is off (messages/service.ts, 2026-10-12). Its switch, with the agents' other two, is
 * now an experiment of the account, kept for this computer here (`createAgentSettingsSync`).
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_SETTING_EXPERIMENTS, agentSettingsFromAnswer, ownsAgentSettings, readAgentSettings, saveAgentSettings, type AgentSettings } from '../lib/agentSettings.js'
import type { AuthSession } from '../lib/authSession.js'
import type { BackendNotice } from './api.js'

type Experiments = Readonly<Record<string, { state: readonly string[] }>>

/** Whether any of `state` is in `dataDir`: a path under it, or `dir/prefix*suffix` for a file of that kind in that folder.
 *  The star was only read after a slash, so `super-tabs/host-*.json` was looked up as that literal file name and never
 *  found: a machine contributed to a Swarm never woke the Swarm service at a start, and after the master re-executed
 *  (every update) it stayed off until some request started it (remote-deepseek, 3 hours offline, 2026-10-22). */
export function stateIsThere(dataDir: string, state: readonly string[]): boolean {
  return state.some((entry) => {
    const slash = entry.lastIndexOf('/')
    const star = entry.indexOf('*', slash + 1)
    if (star < 0) return existsSync(join(dataDir, entry))
    const prefix = entry.slice(slash + 1, star)
    const suffix = entry.slice(star + 1)
    try {
      return readdirSync(join(dataDir, entry.slice(0, slash))).some((name) => name.startsWith(prefix) && name.endsWith(suffix))
    } catch {
      return false
    }
  })
}

/** Ask for each experiment that runs in its own process and has saved state here. */
export function wakeExperiments(options: {
  dataDir: string
  experiments: Experiments
  outOfProcess: ReadonlySet<string>
  want: (service: string) => void
}): string[] {
  const woken = Object.entries(options.experiments)
    .filter(([name, experiment]) => options.outOfProcess.has(name) && stateIsThere(options.dataDir, experiment.state))
    .map(([name]) => name)
  for (const name of woken) options.want(name)
  return woken
}

/** How often the core reads the account's experiments again when nothing else asks: a safety net for a `desk_changed`
 *  it never heard (its link to the backend down while another computer turned one on). */
export const AGENT_SETTINGS_SYNC_MS = 5 * 60_000

const EXPERIMENTAL_SETTINGS = '/api/experimental-settings'
type Answer = { status: number; body: Record<string, unknown> }

/** What `harness settings` and an older window's Settings ▸ Agents are told while this computer is signed out. */
export const AGENT_SETTINGS_SIGNED_OUT = 'Sign in to Harness to change this: what agents may do is an experiment of your account (Settings ▸ Experimental).'
const ACCOUNT_UNAVAILABLE = 'Harness could not reach your account to change this. Try again in a moment.'

/**
 * The account's three agent experiments (lib/agentSettings.ts), kept for this computer: the copy in the data folder is
 * what every launch, `harness new` and Agent Messages read, and this is its only writer. It reads the account's
 * experiments as the core starts, at every `desk_changed` (a change to them publishes one: backend
 * routes/experimentalSettings.ts), every AGENT_SETTINGS_SYNC_MS besides, and in every answer the windows get through
 * this daemon (`/api/experimental-settings`), so a switch turned here holds here at once. Signed out it reads nothing,
 * and the copy reads as the defaults.
 *
 * Agent Messages, in the edge host, is told at once when an answer changes its switch (`MessagesPort.settingsChanged`),
 * so turned on it acts now (its agents get its note) and turned off it withdraws them: it sleeps while it is off, and
 * on one machine nothing else woke it, so no agent heard of `harness send` (a fresh Mac, 2026-10-12).
 *
 * `harness settings` and an older window's Settings ▸ Agents write through it (`/api/agent-settings`) to the account.
 */
export function createAgentSettingsSync(deps: {
  dataDir: string
  /** The account's backend, as this daemon is signed in to it. */
  backend: (method: string, path: string, body?: unknown) => Promise<Answer>
  session: () => AuthSession | null
  onNotice: (listener: (notice: BackendNotice) => void) => () => void
  /** Agent Messages' switch changed here (core/api.ts `MessagesPort.settingsChanged`). */
  messagesChanged: () => void
  everyMs?: number
  log?: (line: string) => void
}) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let running: Promise<void> | null = null
  let again = false

  /** Keeps what [answer] says of the agents' experiments, when it is this sign-in's: asked under [asked], and the
   *  same sign-in still (core rule 6: an answer for a sign-in that has since changed may be another account's). */
  const heard = (answer: Answer, asked: AuthSession | null): Answer => {
    const said = agentSettingsFromAnswer(answer)
    const now = deps.session()
    if (!said || !asked?.machineId || now?.machineId !== asked.machineId) return answer
    const owner = { accountId: said.accountId, machineId: asked.machineId }
    if (!ownsAgentSettings(owner, now)) return answer
    const before = readAgentSettings(deps.dataDir, now)
    try { saveAgentSettings(deps.dataDir, owner, said.settings) } catch (error) {
      log(`[experiments] the agents' settings could not be kept · ${String(error)}`)
      return answer
    }
    if (said.settings.agentMessages !== before.agentMessages) deps.messagesChanged()
    return answer
  }

  const sync = async (): Promise<void> => {
    const asked = deps.session()
    if (!asked?.machineId) return
    try { heard(await deps.backend('GET', EXPERIMENTAL_SETTINGS), asked) } catch (error) {
      log(`[experiments] the account's experiments could not be read · ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** One read at a time: one asked for while another is under way runs once after it, so a change the first answer
   *  may predate is read too. */
  const request = (): Promise<void> => {
    if (running) { again = true; return running }
    running = (async () => { do { again = false; await sync() } while (again) })().finally(() => { running = null })
    return running
  }

  const failed = (answer: Answer): Answer => {
    const error = answer.body.error as { message?: unknown } | undefined
    return { status: 502, body: { error: { code: 'ACCOUNT_UNAVAILABLE', message: typeof error?.message === 'string' && error.message ? error.message : ACCOUNT_UNAVAILABLE } } }
  }

  return {
    start(): void {
      if (timer) return
      unsubscribe = deps.onNotice((notice) => { if (notice.type === 'desk_changed') void request() })
      timer = setInterval(() => { void request() }, deps.everyMs ?? AGENT_SETTINGS_SYNC_MS)
      timer.unref()
      void request()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
      unsubscribe?.()
      unsubscribe = null
    },
    /** Reads the account's experiments now; resolves once read (or not). */
    sync: request,
    /** GET /api/experimental-settings for the windows, through this daemon: the answer is kept too. */
    async experimentalRead(): Promise<Answer> {
      const asked = deps.session()
      return heard(await deps.backend('GET', EXPERIMENTAL_SETTINGS), asked)
    },
    /** PATCH /api/experimental-settings from the windows: the account's answer is kept, so it holds here at once. */
    async experimentalWrite(body: unknown): Promise<Answer> {
      const asked = deps.session()
      return heard(await deps.backend('PATCH', EXPERIMENTAL_SETTINGS, body), asked)
    },
    /** GET /api/agent-settings: the settings as this computer reads them, and whether it is signed in. */
    async settingsRead(): Promise<Answer> {
      const session = deps.session()
      return { status: 200, body: { ...readAgentSettings(deps.dataDir, session), signedIn: !!session?.machineId } }
    },
    /**
     * PATCH /api/agent-settings ({"agentMessages": true}, …): `harness settings`, and an older window's Settings ▸
     * Agents, written through to the account's experiments. Signed out there is no account to write to.
     */
    async settingsWrite(body: unknown): Promise<Answer> {
      const changes = body && typeof body === 'object'
        ? Object.entries(body as Record<string, unknown>).filter(([key, value]) => key in AGENT_SETTING_EXPERIMENTS && typeof value === 'boolean')
        : []
      if (!changes.length) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Nothing to change: send {"agentsStartAgents": true|false}, {"pullRequestLine": true|false}, {"agentMessages": true|false}, {"agentMessagesHideSummary": true|false} or {"agentsTellAgents": true|false}.' } } }
      const asked = deps.session()
      if (!asked?.machineId) return { status: 409, body: { error: { code: 'SIGNED_OUT', message: AGENT_SETTINGS_SIGNED_OUT } } }
      const read = heard(await deps.backend('GET', EXPERIMENTAL_SETTINGS), asked)
      const accountId = agentSettingsFromAnswer(read)?.accountId
      if (!accountId) return failed(read)
      for (const [key, enabled] of changes) {
        const feature = AGENT_SETTING_EXPERIMENTS[key as keyof AgentSettings]
        const written = heard(await deps.backend('PATCH', EXPERIMENTAL_SETTINGS, { accountId, feature, enabled }), asked)
        if (!agentSettingsFromAnswer(written)) return failed(written)
      }
      return { status: 200, body: { ...readAgentSettings(deps.dataDir, deps.session()), signedIn: true } }
    },
  }
}

/**
 * The account's notices the backend announces (`desk_changed`, …), for the services that hear them: each
 * listener in this process (`core.account.onNotice`, Agent Messages' among them when it runs here, which reads its
 * tabs again at `desk_changed`), guarded, and each experiment's process (`tell`).
 */
export function createAccountNotices(tell: (notice: BackendNotice) => void, log: (line: string) => void = (line) => console.warn(line)) {
  const listeners = new Set<(notice: BackendNotice) => void>()
  return {
    onNotice(listener: (notice: BackendNotice) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notice(notice: BackendNotice): void {
      for (const listener of listeners) {
        try { listener(notice) } catch (error) { log(`[experiments] a notice's listener failed · ${error instanceof Error ? error.message : String(error)}`) }
      }
      tell(notice)
    },
  }
}

/**
 * What the core does for the experiments as a whole: ask the master for one (`want`), and hand the account's
 * notices to the listeners here and to each experiment in its own process.
 */
export function createExperimentHooks(deps: {
  want: (service: string) => void
  notify: (service: string, frame: { type: string; payload: Record<string, unknown> }) => boolean
  outOfProcess: ReadonlySet<string>
  experiments: Iterable<string>
  log?: (line: string) => void
}) {
  const notices = createAccountNotices((notice) => {
    for (const name of deps.experiments) if (deps.outOfProcess.has(name)) deps.notify(name, { type: 'service_event', payload: { kind: 'notice', notice } })
  }, deps.log)
  return {
    want: deps.want,
    onNotice: notices.onNotice,
    notice: notices.notice,
  }
}
