/**
 * What the usage report counts of the requests the core answers, as the core sees them: which requests it measures, who
 * sent each, and what each answer said, raw and bounded (core/api.ts `UsageEvent`). The gateway names the counters
 * (gateway/usageEvents.ts, lib/productUsageSignals.ts): the names are the backend's vocabulary, and the core's process
 * loads none of it (the core audit of 2026-11-12, section 2). One event as a request comes and one for each answer, in
 * place of the counters and launch signals each sent before; the gateway gets them in the order they happened.
 */
import type { UsageAnswer, UsageEvent, UsageRequest } from './api.js'
import type { MessageReceipt } from '../lib/sessionInput.js'

/** The requests the report measures (lib/productUsageSignals.ts names each): an agent's create and the rest of its life,
 *  its history, search, the Store, the model lists and a model's grid, a pane opening an address, a person's message,
 *  and a durable create's status and cancel. */
export const MEASURED_REQUESTS: ReadonlySet<string> = new Set(['agent_create', 'agent_create_status', 'agent_create_cancel',
  'agent_resume', 'agent_restart', 'agent_retarget', 'agent_recent', 'agent_fork', 'agent_close', 'agent_delete',
  'session_search', 'session_tail', 'dsh_list', 'dsh_install', 'dsh_update', 'dsh_remove', 'models_list', 'grid_models_list',
  'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop', 'browser_open', 'message'])

/** A code longer than any the report lists, which every reading of a code takes as one it does not list: a longer one is
 *  sent as this, so its text stays here. */
const LONG_CODE = '-'.repeat(65)

export interface UsageOutcomesDeps {
  send(event: UsageEvent): void
  now?: () => number
}

/** A request being measured: each of its answers, and what became of a person's message, which nothing else answers. */
export interface MeasuredRequest {
  answered(reply: Record<string, unknown>): void
  receipt: MessageReceipt
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** [value] when it is a string of at most [max] characters. */
const short = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.length <= max ? value : undefined)
/** A code as the report reads it: what it is when it is a short string, `true` for one that is no string, none for none. */
const code = (value: unknown): string | true | undefined =>
  value == null ? undefined : typeof value !== 'string' ? true : value.length <= 64 ? value : LONG_CODE

/** The facts of a request its counters are named from. */
function requestOf(type: string, payload: unknown, from: { local: boolean; tool: boolean; role: string | null }): UsageRequest {
  const p = isRecord(payload) ? payload : {}
  const creationId = short(p.creationId, 96), engine = short(p.engine, 32), agentId = short(p.agentId, 256)
  return {
    type, local: from.local, tool: from.tool, role: from.role,
    ...(p.usageSurface === 'phone' ? { phone: true as const } : {}),
    ...(p.userAction === true ? { userAction: true as const } : {}),
    ...(creationId !== undefined ? { creationId } : {}),
    ...(engine !== undefined ? { engine } : {}),
    ...(p.startedBy === 'agent' ? { agentStarted: true as const } : {}),
    ...(p.startedByHachi === true ? { hachiStarted: true as const } : {}),
    ...(p.usageIntent === 'interactive' ? { interactive: true as const } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  }
}

/** What a reply says that its counters are named from: its error, its state, its agent, and a refusal's reason. */
function answerOf(reply: Record<string, unknown>): UsageAnswer {
  const failure = isRecord(reply.failure) ? reply.failure : undefined
  const error = code(reply.error ?? failure?.code)
  const state = short(reply.state, 64)
  const reason = reply.reason ?? failure?.reason
  const held = isRecord(reply.held) ? short(reply.held.service, 32) : undefined
  let agent: UsageAnswer['agent']
  if (isRecord(reply.agent)) {
    const id = short(reply.agent.id, 256)
    const launch = isRecord(reply.agent.launch) ? reply.agent.launch : undefined
    const launchState = short(launch?.state, 32)
    const launchError = code(launch?.error)
    agent = { ...(id !== undefined ? { id } : {}), ...(launch ? { launch: {
      ...(launchState !== undefined ? { state: launchState } : {}), ...(typeof launchError === 'string' ? { error: launchError } : {}) } } : {}) }
  } else if (reply.agent) agent = true
  return {
    ...(error !== undefined ? { error } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(reply.agent ? { hasAgent: true as const } : {}),
    ...(reply.ok === false ? { ok: false as const } : {}),
    ...(reason !== undefined ? { preparation: short(reason, 64) ?? null } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(held !== undefined ? { held } : {}),
  }
}

export function createUsageOutcomes(deps: UsageOutcomesDeps) {
  const now = deps.now ?? Date.now
  return {
    /** A request as it comes: told now, and each of its answers as it is given. Null for one the report does not measure:
     *  a terminal's bytes and every other frame cost a lookup and nothing more. */
    request(type: string, payload: unknown, from: { local: boolean; tool: boolean; role: string | null }): MeasuredRequest | null {
      if (!MEASURED_REQUESTS.has(type)) return null
      const request = requestOf(type, payload, from)
      deps.send({ kind: 'request', request })
      const started = now()
      let answered = false
      /** Its first answer is the one its counters count; a later reply still says what became of a launch. */
      const answer = (answer: UsageAnswer, launches: boolean): void => {
        const first = !answered
        answered = true
        if (first || launches) deps.send({ kind: 'answer', request, answer, first, elapsedMs: Math.max(0, now() - started) })
      }
      return {
        answered: (reply) => { answer(answerOf(reply), true) },
        receipt: (outcome) => { answer({ message: String(outcome).slice(0, 32) }, false) },
      }
    },
    /** `hn`'s own measurement of its flows (`product_observe`), as it sent it: the gateway takes only its fixed shapes, so
     *  anything longer than the longest of them is none. */
    observed(payload: unknown): void {
      if (!isRecord(payload)) return
      let text: string
      try { text = JSON.stringify(payload) } catch { return }
      if (text.length <= 512) deps.send({ kind: 'observed', payload: JSON.parse(text) as Record<string, unknown> })
    },
  }
}

export type UsageOutcomes = ReturnType<typeof createUsageOutcomes>
