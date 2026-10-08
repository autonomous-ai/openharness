/**
 * Sign this computer in by showing a QR that a signed-in phone scans and approves
 * (backend lib/harnessSession.ts, routes/qrSignIn.ts):
 *
 *   start → show the QR → poll (keeping the same code alive) → approved {email}
 *   → ask the person "Sign in as <email>?" → claim the session → the caller writes it.
 *
 * The question is not a formality. Signing in is what makes the account's devices trust this
 * computer, so a stranger who photographs the QR and approves it with THEIR phone would otherwise
 * get this computer's terminals. Nothing is created until the person here says yes.
 */

/** Where a sign-in QR points. The phone's scanner parses exactly this; the code rides in the
 *  fragment, which a browser never sends anywhere. */
export const QR_SIGN_IN_ORIGIN = 'https://harness.autonomous.ai'

export function qrSignInLink(code: string): string {
  return `${QR_SIGN_IN_ORIGIN}/signin#k=${encodeURIComponent(code)}`
}

export interface QrSignInTokens {
  token: string
  refreshToken?: string
  expiresIn?: number
  autonomousEnv?: 'prod' | 'stag'
  email: string
}

export type QrSignInFailure = 'BACKEND_ERROR' | 'DENIED' | 'EXPIRED' | 'CANCELLED' | 'TICKET_INVALID'

export type QrSignInResult = { ok: true; tokens: QrSignInTokens } | { ok: false; code: QrSignInFailure; message: string }

export interface QrSignInDeps {
  /** POST to the backend without a sign-in; resolves the response's `data`, rejects on an error. */
  post: <T>(path: string, body: unknown) => Promise<T>
  /** A new (or the same, extended) code to show. */
  show: (link: string, expiresIn: number) => void
  /** Ask the person whether to sign in as [email]. */
  confirm: (email: string) => Promise<boolean>
  label: string
  computerId: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollEveryMs?: number
  /** Called once the code exists, with how to take it back — for a caller that must stop early. */
  onStarted?: (cancel: () => Promise<void>) => void
}

/** Extend the code this long before it runs out, so an approval given at the last moment counts. */
const EXTEND_BEFORE_MS = 30_000

export async function qrSignIn(deps: QrSignInDeps): Promise<QrSignInResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())
  const every = deps.pollEveryMs ?? 2_000
  let started: { code: string; pollToken: string; expiresIn: number }
  try {
    started = await deps.post('/api/auth/qr/start', { label: deps.label, kind: 'computer', computerId: deps.computerId })
  } catch (err) {
    return { ok: false, code: 'BACKEND_ERROR', message: (err as Error).message }
  }
  const { pollToken } = started
  const link = qrSignInLink(started.code)
  let expiresAt = now() + started.expiresIn * 1000
  deps.show(link, started.expiresIn)
  const cancel = async (): Promise<void> => { await deps.post('/api/auth/qr/cancel', { pollToken }).catch(() => {}) }
  deps.onStarted?.(cancel)
  for (;;) {
    await sleep(every)
    if (expiresAt - now() < EXTEND_BEFORE_MS) {
      try {
        const { expiresIn } = await deps.post<{ expiresIn: number }>('/api/auth/qr/extend', { pollToken })
        expiresAt = now() + expiresIn * 1000
        deps.show(link, expiresIn)
      } catch {
        return { ok: false, code: 'EXPIRED', message: 'The code expired. Run `harness login` again.' }
      }
    }
    let state: { status: string; email?: string }
    try {
      state = await deps.post('/api/auth/qr/poll', { pollToken })
    } catch {
      continue // a blip; the next poll tries again
    }
    if (state.status === 'pending') continue
    if (state.status === 'denied') return { ok: false, code: 'DENIED', message: 'Sign-in was denied on the phone.' }
    if (state.status !== 'approved' || !state.email) {
      return { ok: false, code: 'EXPIRED', message: 'The code expired. Run `harness login` again.' }
    }
    if (!(await deps.confirm(state.email))) {
      await cancel()
      return { ok: false, code: 'CANCELLED', message: `Not signed in as ${state.email}.` }
    }
    try {
      const tokens = await deps.post<QrSignInTokens>('/api/auth/qr/claim', { pollToken })
      if (!tokens?.token) throw new Error('the backend returned no session')
      return { ok: true, tokens: { ...tokens, email: tokens.email ?? state.email } }
    } catch (err) {
      return { ok: false, code: 'BACKEND_ERROR', message: (err as Error).message }
    }
  }
}

/**
 * Spend a box ticket (backend `issueBoxTicket`): the poll token of a QR sign-in the phone approved
 * before handing it to this headless box, so there is nothing to show and no one here to confirm.
 * A ticket the backend refuses (spent, expired, made up) is `TICKET_INVALID` — another try with the
 * same one cannot help; anything else is `BACKEND_ERROR`, which can.
 */
export async function claimTicket(post: QrSignInDeps['post'], ticket: string): Promise<QrSignInResult> {
  try {
    const tokens = await post<QrSignInTokens>('/api/auth/qr/claim', { pollToken: ticket })
    if (!tokens?.token) throw new Error('the backend returned no session')
    return { ok: true, tokens }
  } catch (err) {
    if ((err as { status?: number }).status === 401) return { ok: false, code: 'TICKET_INVALID', message: 'This ticket was already used or has expired.' }
    return { ok: false, code: 'BACKEND_ERROR', message: (err as Error).message }
  }
}
