import { AUTOMATIC_POLL_ACTIONS, HEALTH_FAILURES, HEALTH_MEASURES, RESUME_PREPARATION_KINDS, type HealthSource, type ResumeReason } from './productHealthContract.js'
import type { MessageOutcome, MessageReceipt } from './sessionInput.js'
import { LAUNCH_ERROR_CODES, PRODUCT_USAGE_FLOWS, PRODUCT_USAGE_LAUNCH_ENGINES, PRODUCT_USAGE_USER_OPENED_ACTIONS, STORE_ERROR_CODES,
  type LaunchErrorCode, type ProductUsageLaunchEngine, type ProductUsageMetric, type StoreErrorCode } from './productUsageContract.js'

const actions = { agent_create: 'create', agent_resume: 'resume', agent_restart: 'restart',
  agent_retarget: 'model_change', agent_recent: 'history',
  agent_fork: 'fork', agent_close: 'close', agent_delete: 'delete',
  session_search: 'search', session_tail: 'history_page',
  dsh_list: 'store_list', dsh_install: 'store_install', dsh_update: 'store_update', dsh_remove: 'store_remove',
  models_list: 'model_list', grid_models_list: 'model_list',
  grid_fleet_model_download: 'model_download', grid_fleet_model_start: 'model_start', grid_fleet_model_stop: 'model_stop',
  browser_open: 'browser_open',
} as const
const unmeasured = (..._args: unknown[]): void => {}
const setup = new Set(['TMUX_UNAVAILABLE', 'PTY_HOST_UNAVAILABLE', 'TMUX_TOO_OLD_FOR_DSH', 'TMUX_TOO_OLD_FOR_GRID',
  'ENGINE_UNAVAILABLE', 'NATIVE_LAUNCH_HELD', 'DSH_MATERIALIZE_FAILED', 'SWARM_SKILL_FAILED', 'SPAWN_FAILED', 'REGISTRATION_FAILED', 'GRID_CONFIG_FAILED'])
const auth = new Set(['UNAUTHORIZED', 'AUTH_REQUIRED', 'LOGIN_REQUIRED', 'OWNER_REQUIRED', 'E2EE_REQUIRED'])
const unavailable = new Set(['SERVICE_UNAVAILABLE', 'SERVICE_FAILED', 'GRID_UNAVAILABLE', 'API_UNAVAILABLE',
  'UNSUPPORTED', 'UNSUPPORTED_ON_REMOTE', 'TIMEOUT', 'NATIVE_UNAVAILABLE', 'SWARM_ROLE_UNAVAILABLE'])
// A history page read for no session, or one this computer's index does not hold (services/search.ts): until
// 2026-10-28 both were `other`, 2,225 that day, a Desktop list re-reading a conversation that had left the index.
const invalid = new Set(['INVALID_ENGINE', 'INVALID_CWD', 'CWD_NOT_FOUND', 'INVALID_GRID', 'INVALID_DSH', 'INVALID_SWARM_ROLE',
  'INVALID_MODEL', 'INVALID_PERMISSION_MODE', 'INVALID_CREATION_ID', 'INVALID_PROJECT_SOURCE', 'WORKTREE_BUSY',
  'BAD_SESSION', 'NOT_INDEXED'])
/** A Store install's or update's own refusals (dsh/install.ts, dsh/update.ts), by kind. Until 2026-10-28 every one was
 * `other`: that day's 11 failed installs, all on Windows, said nothing of why. For the Store's requests only, so a
 * create's or a resume's totals keep their meaning. Its busy and not-installed refusals are named with the others'. */
const storeFailures = new Map<string, Failure>([
  ['SETUP_FAILED', 'setup'], ['DOCTOR_FAILED', 'setup'], ['GIT_UNAVAILABLE', 'setup'], ['SHELL_UNAVAILABLE', 'setup'],
  ['CLONE_FAILED', 'unavailable'], ['VIEWER_UNAVAILABLE', 'unavailable'],
  ['INVALID_MANIFEST', 'invalid'], ['INVALID_SOURCE', 'invalid'], ['SOURCE_NOT_FOUND', 'invalid'],
  ['PACKAGE_ID_MISMATCH', 'invalid'], ['PACKAGE_KIND_MISMATCH', 'invalid'], ['LINKED_INSTALL', 'invalid'],
  ['BUNDLED_PACKAGE', 'invalid'],
])
const resumeReasons = new Map<string, ResumeReason>([
  ['TMUX_UNAVAILABLE', 'runtime_unavailable'], ['NATIVE_LAUNCH_HELD', 'runtime_unavailable'],
  ['ENGINE_UNAVAILABLE', 'runtime_unavailable'],
  ['AGENT_NOT_FOUND', 'saved_state_missing'], ['RESUME_UNAVAILABLE', 'saved_state_missing'],
  ['CWD_NOT_FOUND', 'project_missing'], ['INVALID_DSH', 'harness_missing'],
  ['GRID_CREDENTIAL_REQUIRED', 'credentials_missing'], ['AUTH_REQUIRED', 'credentials_missing'],
  ['AGENT_BUSY', 'busy'], ['WORKTREE_BUSY', 'busy'], ['PERMISSION_CHANGE_REQUIRES_STOP', 'busy'],
  ['AGENT_CHANGED', 'changed'], ['RESUME_UNCONFIRMED', 'unconfirmed'],
  ['RESUME_PREPARATION_FAILED', 'preparation_failed'], ['RESUME_FAILED', 'launch_failed'],
  ['INVALID_PERMISSION_MODE', 'invalid'], ['INVALID_CREATION_ID', 'invalid'],
  // Codes a resume reply carries that fell to `other` (production counters, 2026-10-16): the engine of a resumed
  // harness that did not start (lib/restoreAgents.ts), a resume while the harness is being deleted (backendSocket.ts)
  // and a request that named no harness.
  ['ENGINE_DID_NOT_START', 'launch_failed'], ['ENGINE_NOT_INSTALLED', 'launch_failed'], ['START_TIMEOUT', 'launch_failed'],
  ['DELETE_IN_PROGRESS', 'busy'], ['MISSING_AGENT_ID', 'invalid'],
])

type Failure = 'setup' | 'auth' | 'unavailable' | 'invalid' | 'other'
/** The fixed kind of a refusal; exported for the guard that keeps every code of core/agents named somewhere. */
export function failureKind(error: unknown): Failure {
  return typeof error !== 'string' ? 'other' : setup.has(error) ? 'setup' : auth.has(error) ? 'auth'
    : unavailable.has(error) ? 'unavailable' : invalid.has(error) ? 'invalid' : 'other'
}
const listedCodes = new Set<string>(LAUNCH_ERROR_CODES.filter(code => code !== 'unlisted' && code !== 'none'))
/** Which listed code an `other` refusal had (`LAUNCH_ERROR_CODES`): the daemon's own name lower-cased, `unlisted`
 * for any other string and `none` for no code at all. Only a name from the fixed list leaves here. */
export function launchErrorCode(error: unknown): LaunchErrorCode {
  if (typeof error !== 'string') return 'none'
  const code = error.length <= 64 ? error.toLowerCase() : ''
  return listedCodes.has(code) ? code as LaunchErrorCode : 'unlisted'
}
const storeCodes = new Set<string>(STORE_ERROR_CODES.filter(code => code !== 'unlisted' && code !== 'none'))
/** Which listed code a Store install's or update's refusal had (`STORE_ERROR_CODES`), as `launchErrorCode` names a
 * launch's: the code lower-cased, `unlisted` for any other string and `none` for no code. Nothing else leaves here. */
export function storeErrorCode(error: unknown): StoreErrorCode {
  if (typeof error !== 'string') return 'none'
  const code = error.length <= 64 ? error.toLowerCase() : ''
  return storeCodes.has(code) ? code as StoreErrorCode : 'unlisted'
}
/** The engine a launch asked for, as one of the fixed names. */
export function launchEngine(engine: unknown): ProductUsageLaunchEngine {
  return (PRODUCT_USAGE_LAUNCH_ENGINES as readonly unknown[]).includes(engine) ? engine as ProductUsageLaunchEngine : 'other'
}
/** A create turned down because the request was wrong, not because Harness failed: opening a conversation that is
 *  already a harness or open elsewhere (core/agents/adopt.ts), a cloud agent with no task or repository
 *  (cloud/service.ts). The Oct 26 report counted them as launch failures. */
export const LAUNCH_REFUSALS: ReadonlySet<string> = new Set(['SESSION_IN_HARNESS', 'SESSION_OPEN_ELSEWHERE', 'SESSION_OPEN_IN_TERMINAL',
  'SESSION_BUSY_IN_TERMINAL', 'INVALID_REQUEST'])
export interface ProductUsageLaunchSignal {
  /** Local RAM only, discarded on stop/choice change; never part of a report or persisted queue. */
  id: string
  phase: 'start' | 'pending' | 'created' | 'failed' | 'refused' | 'cancelled' | 'unconfirmed' | 'work_requested'
  /** On `start`: an agent or a Swarm asked for this launch (the create's `startedBy`), not a person. */
  agentStarted?: true
  origin?: 'interactive' | 'tool'
  failure?: Failure
  /** The listed code of an `other` or setup failure, of a refusal, or of a created launch's late one (`late`). */
  code?: LaunchErrorCode
  wait?: 'install' | 'model' | 'native' | 'other'
  /** The engine a new launch asked for (`start`), as a fixed name: an installation's first launch counts it. */
  engine?: ProductUsageLaunchEngine
  /** The agent a created launch made, still starting: local RAM only, like `id`, so that the gateway can tell its
   *  start failing later (core/agents/newPane.ts) from the agent's other frames. */
  agent?: string
  /** A created launch whose start had already failed when the reply that said so was read (a status poll). */
  late?: true
}

/** A created launch, as its reply's agent frame shows it: still starting (watched by its agent), already
 *  failed (`late`), or ready. The frame is read here and nothing of it but those leaves. */
function createdSignal(agent: unknown): Omit<ProductUsageLaunchSignal, 'id'> {
  const frame = agent && typeof agent === 'object' ? agent as { id?: unknown; launch?: { state?: unknown; error?: unknown } } : null
  const launch = frame?.launch && typeof frame.launch === 'object' ? frame.launch : null
  if (launch?.state === 'failed') return { phase: 'created', late: true, code: launchErrorCode(launch.error) }
  const id = frame?.id
  return { phase: 'created', ...(typeof id === 'string' && id.length > 0 && id.length <= 256 && launch?.state !== 'ready' ? { agent: id } : {}) }
}

/** Observe an actual new-harness receipt through subsequent status polls. Polling adds no attempts.
 * [engine] is the request's `engine`; the reply's [agent] is its agent frame, or whether it had one.
 * [agentStarted]: the create says an agent started it (`startedBy: 'agent'`). */
export function productUsageLaunch(type: string, id: unknown, emit: (signal: ProductUsageLaunchSignal) => void, engine?: unknown, agentStarted = false) {
  const known = ['agent_create', 'agent_create_status', 'agent_create_cancel'].includes(type)
    && typeof id === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(id)
  if (!known) return unmeasured
  const send = (signal: Omit<ProductUsageLaunchSignal, 'id'>) => {
    if (known) { try { emit({ id: id as string, ...signal }) } catch { /* Optional measurement. */ } }
  }
  if (type === 'agent_create') send({ phase: 'start', engine: launchEngine(engine), ...(agentStarted ? { agentStarted: true } : {}) })
  return (error: unknown, state: unknown, agent: unknown, held: unknown) => {
    if (typeof error === 'string' && LAUNCH_REFUSALS.has(error)) send({ phase: 'refused', code: launchErrorCode(error) })
    else if (error != null || state === 'failed') {
      const failure = failureKind(error)
      send({ phase: 'failed', failure, ...(failure === 'other' || failure === 'setup' ? { code: launchErrorCode(error) } : {}) })
    }
    else if (state === 'created' || agent) send(createdSignal(agent))
    else if (state === 'pending') send({ phase: 'pending', wait: held === 'install' ? 'install' : held === 'models' ? 'model' : held === 'native' ? 'native' : 'other' })
    else if (state === 'cancelled') send({ phase: 'cancelled' })
    else if (state === 'unconfirmed' || state === 'unavailable' || state === 'missing') send({ phase: 'unconfirmed' })
  }
}

/** Who sent a request, as the counters name it: a tool on this computer, an app here, or a remote app
 * client — the browser, or the phone. Over the relay both are the same E2EE `web` role, so the phone says
 * which it is in the payload (`usageSurface: 'phone'`, as it says `userAction`); a remote frame with no
 * such word is the browser's or an older phone's, counted as `app` as before. */
export function productUsageSource(local: boolean, tool: boolean, role: string | null, payload: unknown): HealthSource {
  if (local) return tool ? 'tool' : 'app'
  if (role !== 'web') return 'unknown'
  return (payload as { usageSurface?: unknown } | undefined)?.usageSurface === 'phone' ? 'phone' : 'app'
}

/** Reduce an RPC at its existing boundary. Only fixed counter names leave this helper.
 * No request, reply, error message, path, agent name or identifier is handed to the collector.
 * A pending durable launch is an acknowledgement, never a successful launch. Status polling is
 * excluded: counting each poll as a launch would turn a slow install into hundreds of attempts.
 * [userAction] is the app saying a person opened the list (the Store, a model list); the same request
 * from a refresh, a probe or a picker carries none, and only the flagged one counts toward reach.
 */
export function productUsageRequest(type: string, emit: (metric: ProductUsageMetric) => void, now = Date.now, source?: HealthSource, userAction = false) {
  const action = type === 'message' ? 'message' : Object.hasOwn(actions, type) ? actions[type as keyof typeof actions] : null
  // In particular, streaming frames and polling do not allocate clocks or observers.
  if (!action) return unmeasured
  const started = now()
  let answered = false
  // A fixed poll is `automatic` whichever app makes it, the phone's included: its own source is for what a
  // person on it asked for.
  const origin = (source === 'app' || source === 'phone') && (AUTOMATIC_POLL_ACTIONS as readonly string[]).includes(action)
    ? 'automatic' : source
  // `automatic` is every app's polls, the Desktop's and the phone's together: the phone's are counted again, apart.
  const phonePoll = source === 'phone' && origin === 'automatic'
  const count = (measure: string) => { if (action && action !== 'message') { try { emit(`${action}_${measure}` as ProductUsageMetric) } catch { /* Optional measurement. */ } } }
  const detail = (measure: string) => {
    if (!source) return
    try { emit(`request_${origin}_${action}_${measure}` as ProductUsageMetric) } catch { /* Optional measurement. */ }
    if (phonePoll) { try { emit(`request_phone_automatic_${action}_${measure}` as ProductUsageMetric) } catch { /* Optional measurement. */ } }
  }
  count('requests'); detail('started')
  if (userAction && (PRODUCT_USAGE_USER_OPENED_ACTIONS as readonly string[]).includes(action)) count('user_requests')
  // [failure]: the kind of a refusal its caller already knows (a message's, [messageReceipt]), not read off a code.
  // [preparation]: the reply's `reason` — for a resume whose history could not be prepared, which check refused it.
  return (error: unknown, state: unknown, hasAgent: boolean, ok?: unknown, failure?: typeof HEALTH_FAILURES[number], preparation?: unknown) => {
    if (!action || answered) return
    answered = true
    if (action === 'resume' && (error != null || ok === false || ['failed', 'cancelled', 'unconfirmed', 'unavailable'].some(value => state === value))) {
      const reason = typeof error === 'string' ? resumeReasons.get(error) : undefined
      detail(`reason_${reason ?? (state === 'unconfirmed' ? 'unconfirmed' : 'other')}`)
      // Only a name from the fixed list leaves here: a kind this build does not know is `other`.
      if (reason === 'preparation_failed' && preparation !== undefined) {
        detail(`preparation_${(RESUME_PREPARATION_KINDS as readonly unknown[]).includes(preparation) ? preparation : 'other'}`)
      }
    }
    // A runtime we cannot verify is unknown; a harness changed during the request is cancelled.
    // Neither proves a launch failure. Older clients classified these two codes as failures.
    if (action === 'resume' && (state === 'unconfirmed' || error === 'RESUME_UNCONFIRMED' || error === 'AGENT_CHANGED')) {
      count('unknown'); detail(error === 'AGENT_CHANGED' ? 'cancelled' : 'unknown')
    } else if (error != null || state === 'failed' || ok === false) {
      count('failed'); detail('failed')
      const store = action === 'store_install' || action === 'store_update'
      const kind = (store && typeof error === 'string' ? storeFailures.get(error) : undefined) ?? failureKind(error)
      count(`error_${kind}`)
      // Which code an `other` refusal of a create or a resume had: 22 creates and 9 resumes were `other` on
      // 2026-10-16 (production counters), with nothing to say why. A fixed name from the list, or unlisted.
      if (kind === 'other' && (action === 'create' || action === 'resume')) count(`error_code_${launchErrorCode(error)}`)
      // The 2026-10-21 setup spike (10 failed launches, 4 phone creates) named no prerequisite. These new
      // families preserve the old `other`-by-code totals and keep the phone's creates apart from Desktop's.
      if (kind === 'setup' && action === 'create') {
        const code = launchErrorCode(error)
        count(`error_setup_code_${code}`)
        if (origin === 'phone') {
          try { emit(`phone_create_error_setup_code_${code}` as ProductUsageMetric) } catch { /* Optional measurement. */ }
        }
      }
      // A delete's or a restart's, whatever its kind: the phone's 3 delete refusals were `other` and its 2 restart
      // refusals `setup` on 2026-10-19, a kind of nine codes, with nothing to say which.
      if (action === 'delete' || action === 'restart') {
        count(`error_code_${launchErrorCode(error)}`)
        // The phone's again, apart: the family above mixes every client of this daemon.
        if (origin === 'phone') {
          try { emit(`phone_${action}_error_code_${launchErrorCode(error)}` as ProductUsageMetric) } catch { /* Optional measurement. */ }
        }
      }
      // A Store install's or update's, whatever its kind: the 11 Windows installs of 2026-10-28 were `other`, and
      // nothing said which refusal. Its family adds up to `store_install_failed` (or `store_update_failed`).
      if (store) count(`error_code_${storeErrorCode(error)}`)
      detail(`error_${failure ? failure : error === 'TIMEOUT' ? 'timeout' : typeof error === 'string' && ['AGENT_NOT_FOUND', 'SESSION_NOT_FOUND', 'NOT_FOUND', 'NOT_INSTALLED', 'NOT_INDEXED'].includes(error) ? 'not_found' : typeof error === 'string' && ['DELETE_IN_PROGRESS', 'WORKTREE_BUSY', 'BUSY', 'DSH_BUSY'].includes(error) ? 'conflict' : kind}`)
    } else if (state === 'pending' || state === 'preparing' || state === 'starting') { count('pending'); detail('pending') }
    else if (state === 'unconfirmed' || state === 'unavailable' || state === 'cancelled') { count('unknown'); detail(state === 'cancelled' ? 'cancelled' : 'unknown') }
    else if (!['create', 'resume', 'restart', 'fork'].includes(action) || hasAgent || state === 'created') { count('ok'); detail('ok') }
    else { count('unknown'); detail('unknown') }
    const elapsed = Math.max(0, now() - started)
    count(elapsed < 1000 ? 'under_1s' : elapsed < 10_000 ? '1s_to_10s' : elapsed < 60_000 ? '10s_to_1m' : 'over_1m')
  }
}

/** Each refusal of a person's message by the kind the person was told (lib/sessionInput.ts `MessageOutcome`). */
const messageFailures = {
  agent_gone: 'not_found', runtime_gone: 'unavailable', held: 'conflict', withheld: 'conflict', queue_full: 'conflict',
  not_submitted: 'timeout', queue_expired: 'timeout', invalid: 'invalid', paste_failed: 'other',
} as const satisfies Partial<Record<MessageOutcome, typeof HEALTH_FAILURES[number]>>

/**
 * A person's message measured by what became of it: until 2026-10-20 a `message` request had its `started` and
 * nothing more, as nothing answers it (2026-10-19: 14 from the phone). `ok` once its engine took it, `failed` by
 * the kind of what the person was told, `unknown` typed and never confirmed, `cancelled` stopped by the person.
 * The request's own counters only (`request_<source>_message_<result>`): no text, agent or reason leaves here.
 */
export function messageReceipt(measured: ReturnType<typeof productUsageRequest>): MessageReceipt {
  return (outcome) => {
    if (outcome === 'started' || outcome === 'taken') measured(undefined, undefined, false)
    else if (outcome === 'cancelled') measured(undefined, 'cancelled', false)
    else if (outcome === 'ambiguous' || outcome === 'prompt_mismatch' || outcome === 'turn_ended') measured(undefined, 'unconfirmed', false)
    else measured(undefined, 'failed', false, undefined, messageFailures[outcome])
  }
}

/** Explicit composer intent only. Never infer a human from keystrokes, text or an open window. */
export function productUsageIntent(type: string, intent: unknown, agent: unknown, source: HealthSource, emit: (signal: ProductUsageLaunchSignal) => void): void {
  if (type !== 'message' || typeof agent !== 'string' || !agent || agent.length > 256) return
  try {
    // A person's composer is interactive work on the phone as in any app.
    if ((source === 'app' || source === 'phone') && intent === 'interactive') emit({ id: agent, phase: 'work_requested', origin: 'interactive' })
    else if (source === 'tool') emit({ id: agent, phase: 'work_requested', origin: 'tool' })
  } catch { /* Optional observation cannot block a message. */ }
}

const OBSERVED_OUTCOMES = ['ok', 'failed', 'cancelled', 'unknown']
/**
 * hn's own observation (`product_observe`), reduced to the counters the Desktop's `begin()` and
 * `milestone()` count, each when it happens: `{flow}` is a flow's start, `{flow, outcome, durationMs}`
 * its outcome and duration bucket, `{measure}` one health measure. Anything else — an unknown name,
 * a bad duration, a field more or less than its shape has — is nothing, so no label, text or number
 * of hn's own becomes a counter.
 */
export function productObservation(payload: unknown): ProductUsageMetric[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const p = payload as Record<string, unknown>
  const fields = Object.keys(p).sort().join()
  if (fields === 'measure') {
    return typeof p.measure === 'string' && (HEALTH_MEASURES as readonly string[]).includes(p.measure)
      ? [`health_tui_${p.measure}` as ProductUsageMetric] : []
  }
  if (typeof p.flow !== 'string' || !(PRODUCT_USAGE_FLOWS as readonly string[]).includes(p.flow)) return []
  const prefix = `ui_tui_${p.flow}_`
  if (fields === 'flow') return [`${prefix}started` as ProductUsageMetric]
  if (fields !== 'durationMs,flow,outcome' || typeof p.outcome !== 'string' || !OBSERVED_OUTCOMES.includes(p.outcome)
      || typeof p.durationMs !== 'number' || !Number.isFinite(p.durationMs) || p.durationMs < 0) return []
  const ms = p.durationMs
  return [`${prefix}${p.outcome}`,
    `${prefix}${ms < 1000 ? 'under_1s' : ms < 10_000 ? '1s_to_10s' : ms < 60_000 ? '10s_to_1m' : 'over_1m'}`] as ProductUsageMetric[]
}
