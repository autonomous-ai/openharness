/**
 * Bring this machine's grid sign-in into line with its harness sign-in — when a grid feature needs it.
 *
 * Grid is an add-on to Harness, not part of signing in: a person who never touches local or shared
 * models never gets a `grid` binary, a grid sign-in or a grid of their own. The first time something
 * does need grid — "Set up" on the models picker's local and shared models, a local model's Get or
 * Use, an agent moved onto a grid model, the Model Manager — the daemon calls [GridAccess.ensure],
 * which installs `grid` if it is missing, hands this machine's harness token to `grid login --harness`
 * over stdin (no second browser, `gridHandoff.ts`), and — only for what needs one — makes sure the
 * account's private grid exists. It used to run on every daemon start and every backend reconnect,
 * and signing in to Harness did it too; neither does now.
 *
 * **Silent account switch.** When this machine is signed in to grid as a *different* account, the
 * hand-off overwrites it without asking, matching `grid login`'s own rule (a swap is a line, never a
 * refusal): Harness's grid features run as the Harness account or not at all. `grid login --harness`
 * never touches a running `grid join --serve` child; it only warns about one whose grid has gone.
 *
 * **Cheap when there is nothing to do.** The gate is almost entirely offline (a file read and one
 * `grid ls` that makes no network call) plus one idempotent `POST /api/grid/name`, and a success is
 * remembered for the daemon's life ([createGridAccess]), so the acts that ask again pay nothing.
 */

import { gridJson } from './gridExec.js'
import type { GridHandoffResult } from './gridHandoff.js'
import type { EnsureResult, EnsureStatus } from './gridEnsure.js'

export type GridAttachStatus =
  /** No `grid` on this machine — there is nothing to attach a sign-in to. */
  | 'no-cli'
  /** The backend issued no grid name (an older backend, or the control plane was unreachable). */
  | 'no-name'
  /** This machine's `grid` already knows the account's grid — signed in as the right account, grid
   *  present. Nothing was changed. */
  | 'converged'
  /** The token was handed over (a fresh sign-in, a re-sign-in, or an account swap) — then, when it
   *  was asked for, the account's grid ensured ([GridAttachResult.ownGrid]). */
  | 'signed-in'
  /** The hand-off was needed and did not succeed. The harness sign-in is untouched. */
  | 'handoff-failed'

export interface GridAttachResult {
  status: GridAttachStatus
  /** The account's private grid name, once known; null when the backend issued none. */
  name: string | null
  /** One sentence for a caller that wants to log the outcome. Never contains a credential. */
  detail: string
  /** What making sure the account's own grid exists came to, when it was asked for; absent when only
   *  a sign-in was needed. `converged` means the grid is there already. */
  ownGrid?: EnsureStatus
}

/**
 * The seams this reconcile runs through. The grid-facing ones default to the real modules
 * ({@link defaultGridAttachDeps}); the network and daemon-facing ones are supplied by `cli.ts`,
 * which alone holds the HTTP helpers and the live `BackendSocket`.
 */
export interface GridAttachDeps {
  /** Awaited first: puts `grid` on a machine that has none (the pinned managed runtime, else grid's
   *  own installer), so the hand-off runs on the binary that will serve. A rejection is ignored — a
   *  failed download is the binary check's story to tell, not this await's. */
  installCli: () => Promise<unknown>
  /** Is there a `grid` to run at all? */
  gridAvailable: () => boolean
  /** `POST /api/grid/name` — the account's private grid name, minted if this is its first ask. Null
   *  when the backend predates the route. Throws when the control plane cannot be reached. */
  mintName: () => Promise<string | null>
  /** A live harness access token, for the hand-off. Throws when the SSO session is gone. */
  accessToken: () => Promise<string>
  /** The email `grid` recorded for this machine's sign-in, or null when signed out of grid. */
  signedInEmail: () => string | null
  /** The grid names this machine's `grid` knows locally (`grid --remote ls`, no network call). */
  gridNames: () => Promise<string[]>
  /** Run `grid login --harness` with this token. */
  handoff: (token: string) => Promise<GridHandoffResult>
  /** Make sure the account's private grid exists. */
  ensure: (name: string) => Promise<EnsureResult>
  /** Publish the confirmed name into the daemon and drop the grid memos, so the next `grid_models_list`
   *  / retarget answers with this account's grid rather than a stale or absent one. */
  onName: (name: string) => void
  /** One sentence, prefixed by the caller. */
  log: (line: string) => void
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Reconcile this machine's grid sign-in with its harness account. See the module comment for the
 * shape of the decision; the branches below are exactly its four answers.
 */
export async function reconcileGridAttach(
  deps: GridAttachDeps,
  opts: { ownGrid?: boolean; signedInThisRun?: boolean } = {},
): Promise<GridAttachResult> {
  const ownGrid = opts.ownGrid ?? true
  try { await deps.installCli() } catch { /* the binary check answers a failed download */ }

  if (!deps.gridAvailable()) {
    deps.log('no grid CLI on this machine yet — nothing to attach a sign-in to')
    return { status: 'no-cli', name: null, detail: '' }
  }

  let name: string | null
  try {
    name = await deps.mintName()
  } catch (err) {
    deps.log(`could not read this account's grid name (${msg(err)}) — will try again on the next start`)
    return { status: 'no-name', name: null, detail: msg(err) }
  }
  if (!name) {
    deps.log('this account has no grid name yet (older backend) — skipping grid setup')
    return { status: 'no-name', name: null, detail: '' }
  }

  // The exact, unambiguous signal that this machine is already set up: the account's grid name is
  // GLOBALLY UNIQUE (its suffix is a hash of the account id), so this machine's `grid` knowing that
  // name locally can only mean it is signed in as this account AND the grid exists. A weaker check —
  // "is the signed-in email's private-grid pattern a match" — would false-positive across two
  // accounts sharing an email local-part (`kelvin@personal` vs `kelvin@company`), skip the overwrite
  // decision (1) calls for, and then `ensure` under the wrong account. `grid ls` is a local read
  // (no network), so this stays cheap on the common, already-set-up path.
  const email = deps.signedInEmail()
  let names: string[] = []
  if (email) {
    try {
      names = await deps.gridNames()
    } catch (err) {
      // Could not read the local registry. That cannot PROVE the machine is set up, so it falls
      // through to the hand-off below — which rewrites that registry, so the next start reads it.
      deps.log(`could not read this machine's grid list (${msg(err)}) — signing in again to rebuild it`)
    }
  }
  if (email && names.includes(name)) {
    deps.onName(name)
    deps.log(`already signed in with grid '${name}' — nothing to do`)
    return { status: 'converged', name, detail: '', ...(ownGrid ? { ownGrid: 'existed' as const } : {}) }
  }
  // Signed in as this account earlier in this daemon's life, and nothing here needs the account's own
  // grid: the sign-in is all there is to have. (A grid of its own is not proof this machine is signed
  // in — the gate above — only for an account that has one.)
  if (!ownGrid && email && opts.signedInThisRun) {
    deps.onName(name)
    return { status: 'converged', name, detail: '' }
  }

  // Everything else — signed out, signed in as a DIFFERENT account, or the grid not yet created /
  // synced on this machine — is resolved by (re)signing in as this account and making sure the grid
  // exists. When the machine was signed in as a different account, this overwrites it, by design
  // (decision 1, and the module comment). When it was already the right account but the grid was
  // merely missing locally, this re-fetches the account's grids before ensuring — a small redundancy
  // that only recurs until the grid is created and synced, after which the converged path skips it.
  // Signed in as this account already this run: only the grid is missing, so no second hand-off —
  // each one rotates the account's grid token.
  if (!(email && opts.signedInThisRun)) {
    let token: string
    try {
      token = await deps.accessToken()
    } catch (err) {
      deps.log(`no harness token to hand to grid (${msg(err)})`)
      return { status: 'handoff-failed', name, detail: msg(err) }
    }
    const handoff = await deps.handoff(token)
    if (handoff.code !== 'OK') {
      deps.log(`grid sign-in did not happen: ${handoff.message}`)
      return { status: 'handoff-failed', name, detail: handoff.message }
    }
  }
  if (!ownGrid) {
    deps.onName(name)
    deps.log(`signed grid in as this account ('${name}' not needed yet)`)
    return { status: 'signed-in', name, detail: '' }
  }
  const ensured = await deps.ensure(name)
  deps.onName(name)
  deps.log(`signed grid in and ensured '${name}': ${ensured.status}${ensured.message ? ` — ${ensured.message}` : ''}`)
  return { status: 'signed-in', name, detail: ensured.message, ownGrid: ensured.status }
}

/** A grid of the account's own is there: made, found, or won by another machine's create. */
const OWN_GRID_THERE: ReadonlySet<string> = new Set(['created', 'existed', 'adopted'])

export interface GridAccessOptions {
  /** Runs one reconcile ([reconcileGridAttach]). Injected so the coordination is testable alone. */
  attempt: (request: { ownGrid: boolean; signedInThisRun: boolean }) => Promise<GridAttachResult>
  /** Whether `grid` still holds a sign-in on this machine (a file read) — a `grid logout` run by hand
   *  since forgets what this daemon remembered. */
  signedIn: () => boolean
  log: (line: string) => void
}

export interface GridAccess {
  /** Have grid ready for what the caller is about to do: signed in as this account, and — `ownGrid` —
   *  the account's grid there too. Resolves with what happened; never rejects. */
  ensure: (request?: { ownGrid?: boolean }) => Promise<GridAttachResult>
}

/**
 * When to reconcile, as opposed to {@link reconcileGridAttach}, which decides what to do: on demand,
 * one at a time, and never twice for what is already done.
 *
 * - **One at a time.** Calls queue behind the one in flight and each then reads what it left behind,
 *   so a picker's Set up and a Get pressed a moment later make one sign-in, not two token rotations.
 * - **Remembered.** A sign-in as this account, and the account's grid once it is there, hold for the
 *   daemon's life — until `grid` no longer holds a sign-in at all, which a hand-run `grid logout`
 *   leaves behind.
 * - **Failures are not remembered.** Every ask is a person acting, so the next one simply tries again.
 */
export function createGridAccess(opts: GridAccessOptions): GridAccess {
  let signedIn = false
  let ownGridThere = false
  let last: GridAttachResult | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const once = async (ownGrid: boolean): Promise<GridAttachResult> => {
    if (!opts.signedIn()) signedIn = ownGridThere = false
    if (last && signedIn && (!ownGrid || ownGridThere)) return last
    let result: GridAttachResult
    try {
      result = await opts.attempt({ ownGrid, signedInThisRun: signedIn })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      opts.log(`attempt failed: ${detail}`)
      return { status: 'handoff-failed', name: null, detail }
    }
    if (result.status === 'converged' || result.status === 'signed-in') {
      signedIn = true
      if (result.ownGrid && OWN_GRID_THERE.has(result.ownGrid)) ownGridThere = true
      last = result
    }
    return result
  }

  return {
    ensure: (request = {}) => {
      const next = queue.then(() => once(request.ownGrid ?? false))
      queue = next.catch(() => {})
      return next
    },
  }
}

export async function gridNamesLocal(): Promise<string[]> {
  const { value, result } = await gridJson<Array<{ grid?: unknown }>>(['--remote', 'ls'])
  // ⚠️ A FAILED read is NOT an empty list, and conflating the two is how "this machine has no grids"
  // stops being a fact and becomes a guess — one that would make the gate below answer "not set up"
  // forever on a machine whose registry is unreadable. Thrown rather than returned as `[]` so the
  // caller says which of the two happened in its log.
  if (result.code !== 'OK') {
    throw new Error(result.stderr.trim() || result.message || `\`grid ls\` exited ${result.exitCode}`)
  }
  if (!Array.isArray(value)) throw new Error('`grid ls --json` did not answer a list')
  return value.map((row) => (typeof row.grid === 'string' ? row.grid : '')).filter(Boolean)
}
