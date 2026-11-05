/**
 * Whether the owner's relay answers this Harness Team account, and why not (task #3106).
 *
 * A Team account's Claude and Codex read as signed in when the owner's daemon has left its relay grant (team/relay.ts
 * `teamRelayed`): the file alone was looked at. On Kay's Mac, 2026-11-05, the relay refused every request, as the owner's
 * daemon could not read the owner's Claude sign-in, while the reading still said signed in. Routing kept sending work
 * there and each start lost its task. So the reading asks the relay itself: a GET of Claude's model list with the grant,
 * which spends nothing, and which the relay forwards with the owner's sign-in. A relay that is gone, a token it refuses and
 * an owner sign-in it cannot read each read as not answering, with a reason the owner can act on.
 *
 * ⚠️ The token goes only to the address the owner's daemon published, which every launch already uses, and is never logged.
 */
import { readAuthSession } from '../lib/authSession.js'
import { readTeamConfig } from '../team/config.js'
import { readTeamRelay, type TeamRelayGrant } from '../team/relay.js'

/** Whether the relay answers. [claudeOnly]: what failed is the owner's Claude sign-in, which the relay may still serve Codex
 *  without (security review 2 of #3098: a Mac whose owner has only ChatGPT kept getting Codex work before, and must still). */
export type RelayHealth = { ok: true } | { ok: false; reason: string; claudeOnly?: true }

/** What a Team account's reading says when its owner's relay does not answer: the quota reason, read by people. */
export const RELAY_REASONS = {
  /** The relay's own 503: the owner's daemon found no Claude sign-in it can read (lib/subscriptionRelay.ts). macOS may
   *  refuse the Keychain item to Harness after an update, and the owner's own Claude Code keeps working. */
  ownerSignIn: "This account runs on its owner's subscription, and the owner's Harness can't read the owner's Claude sign-in: the owner needs to allow sign-in access (open Claude Code once, and choose Always Allow if macOS asks).",
  /** Anthropic's 401 or 403 through the relay, after the relay's own refresh: the owner's sign-in itself was refused. */
  claudeRefused: "This account runs on its owner's subscription, and Anthropic refused the owner's Claude sign-in: the owner signs in to Claude Code again.",
  refused: "This account runs on its owner's subscription, and the owner's relay did not accept its key: the owner's Harness hands out a new one when it next publishes its relay.",
  down: "This account runs on its owner's subscription, and the owner's Harness relay on this Mac does not answer: the owner's Harness is restarting or stopped.",
  /** The relay's own 502: anything that threw in it, Anthropic out of reach or an owner sign-in it refreshed and could not
   *  save back (lib/ownerSubscriptions.ts). */
  vendor: "This account runs on its owner's subscription, and the owner's Harness can't reach Anthropic or save the owner's refreshed Claude sign-in.",
} as const

const PROBE_TIMEOUT_MS = 10_000
/** As much of an error body as is read: the relay's own fit in a few hundred bytes, and whatever holds the port may send
 *  without end (review 1 of #3098). */
const BODY_BYTES = 4096

/** The first [BODY_BYTES] of [answer]'s body, the rest left unread. */
async function headOf(answer: Response): Promise<string> {
  const reader = answer.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < BODY_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks).subarray(0, BODY_BYTES).toString('utf8')
}
/** The relay's own refusals carry this; anything else came from the vendor through it (lib/subscriptionRelay.ts `fail`). */
const RELAY_OWN = '"harness_relay_error"'

/**
 * Asks the relay at [grant] for Claude's model list with its token. It answers on a 2xx, and on Anthropic's own error for
 * Anthropic busy, limiting or failing (a 503, 529 or 429 passed through), which is no fault of this account's: read as the
 * owner's sign-in, it told the owner to allow access that was there (security reviews of #3098). Everything else reads as
 * not answering, with why.
 */
export async function probeRelay(grant: TeamRelayGrant, fetchImpl: typeof fetch = fetch): Promise<RelayHealth> {
  let status: number, body = ''
  try {
    const answer = await fetchImpl(`${grant.url.replace(/\/$/, '')}/claude/v1/models`, {
      headers: { authorization: `Bearer ${grant.token}`, 'anthropic-version': '2023-06-01', accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    status = answer.status
    if (status >= 200 && status < 300) await answer.body?.cancel().catch(() => {})
    else body = await headOf(answer)
  } catch {
    return { ok: false, reason: RELAY_REASONS.down }
  }
  if (status >= 200 && status < 300) return { ok: true }
  if (body.includes(RELAY_OWN)) {
    if (status === 503) return { ok: false, reason: RELAY_REASONS.ownerSignIn, claudeOnly: true }
    if (status === 401) return { ok: false, reason: RELAY_REASONS.refused }
    // 502: anything that threw in the relay, for every request while it lasts (review 1 of #3098, second read).
    if (status === 502) return { ok: false, reason: RELAY_REASONS.vendor }
    return { ok: false, reason: `This account runs on its owner's subscription, and the owner's relay answered with an error (HTTP ${status}).` }
  }
  // Anthropic's own answer, passed through: its sign-in refused is Claude's alone; busy, limiting or failing is no fault of
  // this account's. Anything else (a redirect, a 404, an empty body) is not the owner's relay: whatever holds its port once
  // the owner's Harness has gone (review 2 of #3098, second read).
  const vendor = vendorErrorType(body)
  if (vendor === 'authentication_error' || vendor === 'permission_error') return { ok: false, reason: RELAY_REASONS.claudeRefused, claudeOnly: true }
  if (vendor) return { ok: true }
  return { ok: false, reason: RELAY_REASONS.down }
}

/** The error type in Anthropic's own error body (`{"type":"error","error":{"type":"overloaded_error",…}}`), or null. */
function vendorErrorType(body: string): string | null {
  try {
    const value = JSON.parse(body) as { type?: unknown; error?: { type?: unknown } }
    const type = value?.type === 'error' ? value.error?.type : undefined
    return typeof type === 'string' && /^[a-z_]{1,40}_error$/.test(type) ? type : null
  } catch { return null }
}

/** This Team account's: the grant read as each launch reads it (team/relay.ts `realTeamRelayLaunch`), then asked. Null with
 *  no grant to ask, or on any other daemon. */
export async function teamRelayHealth(): Promise<RelayHealth | null> {
  // A spec never asks this Mac's own relay with its own Team sign-in. Production never has VITEST set.
  if (process.env.VITEST || readAuthSession()?.kind !== 'team') return null
  const config = readTeamConfig()
  const grant = config ? readTeamRelay(config) : null
  return grant ? probeRelay(grant) : null
}
