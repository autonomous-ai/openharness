/**
 * Devin Cloud, through Devin's v3 API (docs.devin.ai/api-reference): a session per harness in the
 * organization the key belongs to (`GET /v3/self`), read by its status and its messages, every few seconds
 * while someone watches. `status` + `status_detail` say where it is: `running`/`working`, waiting on the
 * person (`waiting_for_user`, `waiting_for_approval`), `finished`, or `suspended` (asleep: Stop archives
 * it, and a message wakes it). Those two strings are kept beside Harness's state: `finished` and a wait,
 * and a sleep and a stop, can share a normalized state, and a message's words do not say which. It bills
 * ACUs while it works, so every session gets a limit.
 */
import { CLOUD_AGENTS, type CloudState } from '../lib/cloudAgents.js'
import { refusal, type Bridge } from './bridge.js'
import type { CloudAdapter, CloudLink, CloudUpdate, Remote } from './types.js'

const NAME = CLOUD_AGENTS['devin-cloud'].name
/** A first session's limit when the person sets none: enough for a small fix, never a runaway bill. */
export const DEFAULT_ACU_LIMIT = 5

type Json = Record<string, unknown>
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** Where a session is, as Harness says it. */
export function devinState(status: unknown, detail: unknown): CloudState {
  if (status === 'new' || status === 'claimed' || status === 'resuming') return 'starting'
  if (status === 'error') return 'failed'
  if (status === 'suspended') return detail === 'inactivity' || detail === 'user_request' ? 'stopped' : 'failed'
  if (status === 'exit') return 'idle'
  if (detail === 'waiting_for_user' || detail === 'waiting_for_approval') return 'needs_input'
  if (detail === 'finished') return 'idle'
  return 'working'
}

const SUSPENDED: Record<string, string> = {
  usage_limit_exceeded: 'It reached its ACU limit.', out_of_credits: 'The Devin account is out of credits.', out_of_quota: 'The Devin account is out of quota.',
  payment_declined: 'Devin declined the payment.', org_usage_limit_exceeded: 'The organization reached its ACU limit.',
  inactivity: 'Devin went to sleep after inactivity.', user_request: 'The session was stopped by request.',
}

/** Devin's own status. Missing values are null so the next look replaces the pair instead of keeping a stale detail. */
function providerStatus(session: Json): NonNullable<CloudUpdate['providerStatus']> {
  return { status: str(session.status), detail: str(session.status_detail) }
}

export function devinLinks(session: Json): CloudLink[] {
  const links: CloudLink[] = []
  if (str(session.url)) links.push({ label: 'Session', url: str(session.url)! })
  for (const pr of Array.isArray(session.pull_requests) ? session.pull_requests as Json[] : []) {
    const url = str(pr.pr_url)
    if (url) links.push({ label: `Pull request #${/\/pull\/(\d+)/.exec(url)?.[1] ?? ''}`.replace(/ #$/, ''), url })
  }
  return links
}

export function devinAdapter(bridge: Bridge, code: () => Promise<string>): CloudAdapter {
  let org: string | null = null

  const call = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const answer = await bridge.api(await code(), method, path, body)
    if (answer.status >= 300) throw refusal(NAME, answer.status, answer.json)
    return answer.json
  }
  const base = async (): Promise<string> => {
    org ??= str((await call('GET', '/v3/self')).org_id)
    if (!org) throw refusal(NAME, 403, { detail: 'The key belongs to no organization.' })
    return `/v3/organizations/${encodeURIComponent(org)}/sessions`
  }

  return {
    id: 'devin-cloud',
    async start(request) {
      const session = await call('POST', await base(), {
        prompt: request.task,
        ...(request.repository ? { repos: [request.repository] } : {}),
        max_acu_limit: request.options.acuLimit ?? DEFAULT_ACU_LIMIT,
        title: request.task.slice(0, 80),
      })
      const id = str(session.session_id)
      if (!id) throw refusal(NAME, 502, { detail: 'No session was made.' })
      return { remote: { id }, links: devinLinks(session), update: { messages: [], state: devinState(session.status, session.status_detail), providerStatus: providerStatus(session) } }
    },
    async send(remote, text) {
      await call('POST', `${await base()}/${encodeURIComponent(remote.id)}/messages`, { message: text })
    },
    async poll(remote: Remote): Promise<CloudUpdate> {
      const path = `${await base()}/${encodeURIComponent(remote.id)}`
      const session = await call('GET', path)
      const messages: CloudUpdate['messages'] = []
      let cursor = remote.cursor
      // A page at a time, at most five: a session read for the first time in a while catches up over a few looks.
      for (let page = 0; page < 5; page++) {
        const read = await call('GET', `${path}/messages?first=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`)
        for (const item of Array.isArray(read.items) ? read.items as Json[] : []) {
          if (item.source === 'devin' && str(item.message)) messages.push({ id: str(item.event_id) ?? `${path}-${messages.length}`, text: str(item.message)!, at: str(item.created_at) ?? new Date().toISOString() })
        }
        cursor = str(read.end_cursor) ?? cursor
        if (read.has_next_page !== true) break
      }
      const state = devinState(session.status, session.status_detail)
      const lastWords = messages.at(-1)?.text ?? null
      return {
        messages,
        state,
        providerStatus: providerStatus(session),
        activity: session.status === 'suspended' ? SUSPENDED[String(session.status_detail)] ?? null : null,
        // Asked from Devin's newest words; with none new, the question already asked stands (cloud/service.ts).
        question: state !== 'needs_input' ? null : lastWords ? { text: lastWords.slice(0, 500), choices: [] } : undefined,
        links: devinLinks(session),
        remote: { cursor },
      }
    },
    async stop(remote) {
      await call('POST', `${await base()}/${encodeURIComponent(remote.id)}/archive`)
    },
  }
}
