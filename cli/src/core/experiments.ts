/** Shared account settings and authority for agent launches. Feature startup policy lives in edge. */
import { AGENT_SETTING_EXPERIMENTS, AGENT_SETTING_NAMES, agentSettingsFromAnswer, ownsAgentSettings, readAgentSettings, saveAgentSettings, type AgentSettings } from '../lib/agentSettings.js'
import type { AuthSession } from '../lib/authSession.js'
import { errorKind } from '../lib/log.js'
import type { BackendNotice } from './api.js'

/** How often the core reads the account's experiments again when nothing else asks: a safety net for a `desk_changed`
 *  it never heard (its link to the backend down while another computer turned one on). */
export const AGENT_SETTINGS_SYNC_MS = 5 * 60_000

const EXPERIMENTAL_SETTINGS = '/api/experimental-settings'
type Answer = { status: number; body: Record<string, unknown> }

/** What `harness settings` and an older window's Settings ▸ Agents are told while this computer is signed out. */
export const AGENT_SETTINGS_SIGNED_OUT = 'Sign in to Harness to change this: what agents may do is an experiment of your account (Settings ▸ Experimental).'
const GRANTABLE: ReadonlySet<string> = new Set(Object.values(AGENT_SETTING_NAMES))
const ACCOUNT_UNAVAILABLE = 'Harness could not reach your account to change this. Try again in a moment.'

/**
 * The account's three agent experiments (lib/agentSettings.ts), kept for this computer: the copy in the data folder is
 * what every launch, `harness new` and Agent Messages read, and this is its only writer. It reads the account's
 * experiments as the core starts, at a `desk_changed` of revision 0 (a change to them publishes one: backend
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
  /** The account turned Hachi on: its package must be in place before the person's first ⇧⌘H creates it, and the Store
   *  that puts it there may not be running. Absent, nobody is told. */
  hachiOn?: () => void
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
      log(`[experiments] the agents' settings could not be kept · ${errorKind(error)}`)
      return answer
    }
    if (said.settings.agentMessages !== before.agentMessages) deps.messagesChanged()
    if (said.settings.hachi && !before.hachi) deps.hachiOn?.()
    return answer
  }

  const sync = async (): Promise<void> => {
    const asked = deps.session()
    if (!asked?.machineId) return
    try { heard(await deps.backend('GET', EXPERIMENTAL_SETTINGS), asked) } catch (error) {
      log(`[experiments] the account's experiments could not be read · ${errorKind(error)}`)
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
      // Only the experiments' own change, which publishes revision 0 (backend routes/experimentalSettings.ts): a desk operation
      // publishes the desk's revision, and every one of them made every daemon read these again (spec 2026-11-02-poll-cost
      // Part 4.5, 127 reads a minute in prod).
      unsubscribe = deps.onNotice((notice) => { if (notice.type === 'desk_changed' && notice.revision === 0) void request() })
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
      // Only the settings `harness settings` names: Hachi's switch is the person's yes, given in Settings ▸ Experimental
      // alone (docs/design/2026-11-12-hachi.md), so no agent turns it through here.
      const changes = body && typeof body === 'object'
        ? Object.entries(body as Record<string, unknown>).filter(([key, value]) => GRANTABLE.has(key) && typeof value === 'boolean')
        : []
      if (!changes.length) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Nothing to change: send {"agentsStartAgents": true|false}, {"pullRequestLine": true|false}, {"agentMessages": true|false}, {"agentMessagesHideSummary": true|false}, {"agentsTellAgents": true|false} or {"programsReply": true|false}.' } } }
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
      // Turned on by an agent on the person's yes (agentClient/settings.ts): Harness has only its word for that yes.
      // Its name is the person's words, so the log says only that an agent did.
      const byAgent = (body as Record<string, unknown>).byAgent
      if (typeof byAgent === 'string' && byAgent.trim()) {
        log(`[settings] ${changes.map(([key, enabled]) => `${key} ${enabled ? 'on' : 'off'}`).join(', ')} by an agent, which says the person said yes`)
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
        try { listener(notice) } catch (error) { log(`[experiments] a notice's listener failed · ${errorKind(error)}`) }
      }
      tell(notice)
    },
  }
}

/**
 * What the core does for the experiments as a whole: hand the account's
 * notices to the listeners here and to each experiment in its own process.
 */
export function createExperimentHooks(deps: {
  notify: (service: string, frame: { type: string; payload: Record<string, unknown> }) => boolean
  outOfProcess: ReadonlySet<string>
  experiments: Iterable<string>
  log?: (line: string) => void
}) {
  const notices = createAccountNotices((notice) => {
    for (const name of deps.experiments) if (deps.outOfProcess.has(name)) deps.notify(name, { type: 'service_event', payload: { kind: 'notice', notice } })
  }, deps.log)
  return {
    onNotice: notices.onNotice,
    notice: notices.notice,
  }
}
