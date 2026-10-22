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
  /** For a device with no screen (a lamp, #1410): ask the backend for a short code to say aloud, and
   *  say it — again each time it is kept alive — instead of showing the QR. */
  showCode?: (code: string, expiresIn: number) => void
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

const NO_SPOKEN_CODE = 'This Harness backend cannot give a spoken code yet.'

/** Extend the code this long before it runs out, so an approval given at the last moment counts. */
const EXTEND_BEFORE_MS = 30_000

export async function qrSignIn(deps: QrSignInDeps): Promise<QrSignInResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())
  const every = deps.pollEveryMs ?? 2_000
  const spoken = deps.showCode !== undefined
  let started: { code: string; pollToken: string; expiresIn: number; spokenCode?: string }
  try {
    started = await deps.post('/api/auth/qr/start', {
      label: deps.label, kind: 'computer', computerId: deps.computerId, ...(spoken ? { spokenCode: true } : {}),
    })
  } catch (err) {
    // A backend from before spoken codes refuses the field outright (its body schema is strict).
    if (spoken && (err as { status?: number }).status === 400) {
      return { ok: false, code: 'BACKEND_ERROR', message: NO_SPOKEN_CODE }
    }
    return { ok: false, code: 'BACKEND_ERROR', message: (err as Error).message }
  }
  const { pollToken } = started
  const expired = `The code expired. Run \`harness login${spoken ? ' --code' : ''}\` again.`
  const expiredResult = { ok: false as const, code: 'EXPIRED' as const, message: expired }
  const link = qrSignInLink(started.code)
  const cancel = async (): Promise<void> => { await deps.post('/api/auth/qr/cancel', { pollToken }).catch(() => {}) }
  const spokenCode = started.spokenCode
  if (spoken && !spokenCode) {
    // A backend from before spoken codes: there is nothing this device could say, so do not wait.
    await cancel()
    return { ok: false, code: 'BACKEND_ERROR', message: NO_SPOKEN_CODE }
  }
  const display = (expiresIn: number): void => {
    if (spokenCode) deps.showCode!(spokenCode, expiresIn)
    else deps.show(link, expiresIn)
  }
  let expiresAt = now() + started.expiresIn * 1000
  display(started.expiresIn)
  deps.onStarted?.(cancel)
  for (;;) {
    await sleep(every)
    if (expiresAt - now() < EXTEND_BEFORE_MS) {
      try {
        const { expiresIn } = await deps.post<{ expiresIn: number }>('/api/auth/qr/extend', { pollToken })
        expiresAt = now() + expiresIn * 1000
        display(expiresIn)
      } catch {
        return { ok: false, code: 'EXPIRED', message: expired }
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
      return expiredResult
    }
    // #1507: a delayed poll or confirmation can outlast the code; don't ask or claim after expiry.
    if (expiresAt <= now()) {
      await cancel()
      return expiredResult
    }
    const confirmed = await deps.confirm(state.email)
    if (!confirmed) {
      await cancel()
      return { ok: false, code: 'CANCELLED', message: `Not signed in as ${state.email}.` }
    }
    if (expiresAt <= now()) {
      await cancel()
      return expiredResult
    }
    try {
      const tokens = await deps.post<QrSignInTokens>('/api/auth/qr/claim', { pollToken })
      if (!tokens?.token) throw new Error('the backend returned no session')
      return { ok: true, tokens: { ...tokens, email: tokens.email ?? state.email } }
    } catch (err) {
      const failure = err as { status?: number; code?: string }
      if (failure.status === 401 && failure.code === 'QR_INVALID') return expiredResult
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
