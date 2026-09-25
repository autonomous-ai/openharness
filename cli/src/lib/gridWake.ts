/**
 * The reads a PERSON'S act makes — the one place in this daemon that reads a grid WITH the account's grid
 * credential, and does it on purpose: on the platform a signed-in read of a sleeping grid starts it.
 *
 * Every other read of a grid goes through `gridReader.ts`, which never carries a credential, so a grid is
 * never woken by being looked at (grid-reads-without-waking issue 02). What may wake one (issue 03):
 *
 * - an explicit wake — "Show models" in a picker, "Wake now" in the Model Manager viewer — `(wake)`;
 * - moving an agent onto a model on a grid that is asleep or has not been seen awake lately — `(prewarm)`;
 * - the first input into a terminal whose agent runs on a grid that is asleep — `(prewarm-key)`;
 *
 * (and, outside this daemon's reads altogether, a message the agent sends and the Model Manager's Start).
 * Each one is ONE request, detached from whatever the person is waiting on, and marked in its User-Agent
 * so the platform's journal attributes the wake it causes. No automatic seed or discovery wake, ever.
 */
import { gridExec } from './gridExec.js'
import { idKey } from './gridPicture.js'
import { harnessUserAgent, readBase, type ReadPurpose } from './gridReader.js'

/** Why a credentialed read is being made. */
export type WakePurpose = Exclude<ReadPurpose, 'read'>

/** A prewarm (of either kind) fires at most once per grid in this long: a boot it paid for is still up. */
export const PREWARM_DEBOUNCE_MS = 10 * 60_000

/** The proxy holds a request to a sleeping grid while its master boots — up to 60 s (grid-apis
 *  `_WAKE_WAIT_TIMEOUT_SECONDS`) — and replays it once the master is up. Nobody waits on this read. */
const WAKE_READ_TIMEOUT_MS = 90_000

/** More models than any grid lists, and a window no model has: an answer past either is cut. */
const MAX_LISTED = 1024
const MAX_WINDOW = 100_000_000

/** The relay a grid's engines talk to, and the credential they use — `grid info <grid> --env`. */
export interface RelayAccess {
  /** `<grid>/relay/v1` */
  baseUrl: string
  /** ⚠️ A live credential. Never logged, never in argv. */
  apiKey: string
}

/** `grid info --env` prints shell exports; these are the two that matter. */
const ENV_LINE = /^export\s+(OPENAI_BASE_URL|OPENAI_API_KEY)=(.*)$/gm

/** The two exports out of `grid info --env`. ⚠️ Values are SHELL-QUOTED — a base URL read with the
 *  quotes still on produces a request to a host that does not exist. */
export function readEnvExports(stdout: string): { baseUrl: string; apiKey: string } {
  let baseUrl = ''
  let apiKey = ''
  for (const match of stdout.matchAll(ENV_LINE)) {
    const value = match[2]!.trim().replace(/^["']|["']$/g, '')
    if (match[1] === 'OPENAI_BASE_URL') baseUrl = value
    else apiKey = value
  }
  return { baseUrl, apiKey }
}

/** The relay and credential for `gridName`, from this computer's signed-in `grid`; null when it has none. */
export async function relayAccess(gridName: string): Promise<RelayAccess | null> {
  const info = await gridExec(['--remote', 'info', gridName, '--env'])
  if (info.code !== 'OK') return null
  const { baseUrl, apiKey } = readEnvExports(info.stdout)
  return baseUrl && apiKey ? { baseUrl, apiKey } : null
}

/**
 * One credentialed read of the grid's model list, marked `purpose`. Answers each listed model's context
 * window (keyed without case) when it answered 2xx — what the relay reports as `context_window`, which a
 * launch tells its engine to compact inside — and null when it did not. Never throws: a wake that did not
 * happen costs the person the boot on their next message, nothing more.
 *
 * The credential goes only to an `https` relay, or plain `http` on this computer (a developer's grid):
 * a bearer sent in the clear to anywhere else would be a leak, and a LAN grid never sleeps anyway.
 */
export async function wakeRead(gridName: string, purpose: WakePurpose, known?: RelayAccess): Promise<Record<string, number> | null> {
  try {
    const access = known ?? await relayAccess(gridName)
    const base = access ? readBase(access.baseUrl) : null
    if (!access || !base) return null
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${access.apiKey}`, 'user-agent': harnessUserAgent(purpose), accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(WAKE_READ_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    return listedWindows(await response.json().catch(() => null))
  } catch {
    return null
  }
}

/** `{data: [{id, context_window}]}` → each window, keyed without case; anything else in it is ignored. */
function listedWindows(body: unknown): Record<string, number> {
  const rows = body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : []
  const windows: Record<string, number> = {}
  for (const row of rows.slice(0, MAX_LISTED)) {
    const { id, context_window: window } = (row && typeof row === 'object' ? row : {}) as { id?: unknown; context_window?: unknown }
    if (typeof id !== 'string' || !idKey(id)) continue
    if (typeof window !== 'number' || !Number.isSafeInteger(window) || window <= 0 || window > MAX_WINDOW) continue
    windows[idKey(id)] = window
  }
  return windows
}

/** When each grid was last woken by any act here, so a prewarm right after one is not sent again. */
export class PrewarmDebounce {
  private readonly firedAt = new Map<string, number>()

  /** Whether a prewarm of `gridId` may go out at `now`. Asking records nothing. */
  allows(gridId: string, now: number): boolean {
    const last = this.firedAt.get(gridId)
    return last === undefined || now - last >= PREWARM_DEBOUNCE_MS
  }

  /** A credentialed read of `gridId` went out at `now` — a prewarm, or an explicit wake. */
  mark(gridId: string, now: number): void {
    this.firedAt.set(gridId, now)
  }
}
