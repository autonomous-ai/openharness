import { describe, expect, it, vi } from 'vitest'
import { claimTicket, qrSignIn, qrSignInLink, type QrSignInDeps } from './qrSignIn.js'
import { terminalQr } from './terminalQr.js'

/** A backend that answers the QR sign-in routes from a script of poll answers. */
function backend(polls: Array<{ status: string; email?: string }>, opts: { extend?: 'ok' | 'fail'; claim?: 'ok' | 'fail' | 'expired' | 'unauthorized'; spoken?: 'unsupported' | 'rejected' } = {}) {
  const calls: Array<{ path: string; body: unknown }> = []
  let clock = 0
  const post = vi.fn(async (path: string, body: unknown) => {
    calls.push({ path, body })
    if (path === '/api/auth/qr/start') {
      if ((body as { spokenCode?: boolean }).spokenCode && opts.spoken === 'rejected') {
        throw Object.assign(new Error('Unrecognized key(s) in object: \'spokenCode\''), { status: 400 })
      }
      const spoken = (body as { spokenCode?: boolean }).spokenCode && opts.spoken !== 'unsupported'
      return { code: 'hnq_code', pollToken: 'hnp_poll', expiresIn: 120, ...(spoken ? { spokenCode: '12345678' } : {}) }
    }
    if (path === '/api/auth/qr/poll') return polls.shift() ?? { status: 'pending' }
    if (path === '/api/auth/qr/extend') {
      if (opts.extend === 'fail') throw new Error('This code has expired.')
      return { expiresIn: 120 }
    }
    if (path === '/api/auth/qr/claim') {
      if (opts.claim === 'fail') throw new Error('Nothing to claim')
      if (opts.claim === 'expired') throw Object.assign(new Error('Nothing to claim: scan again.'), { status: 401, code: 'QR_INVALID' })
      if (opts.claim === 'unauthorized') throw Object.assign(new Error('Not authorized.'), { status: 401, code: 'UNAUTHORIZED' })
      return { token: 'hna_x', refreshToken: 'hnr_x', expiresIn: 3600, autonomousEnv: 'prod', email: 'dee@example.com' }
    }
    if (path === '/api/auth/qr/cancel') return { cancelled: true }
    throw new Error(`unexpected ${path}`)
  })
  const deps = (confirm = true): QrSignInDeps & { shown: string[] } => {
    const shown: string[] = []
    return {
      post: post as QrSignInDeps['post'],
      show: (link) => { shown.push(link) },
      confirm: vi.fn(async () => confirm),
      label: 'MacBook Pro',
      computerId: 'c-1',
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      pollEveryMs: 2_000,
      shown,
    }
  }
  return { calls, deps, paths: () => calls.map((c) => c.path) }
}

describe('qrSignIn', () => {
  it('shows the QR, waits, asks the person, and only then claims the session', async () => {
    const b = backend([{ status: 'pending' }, { status: 'approved', email: 'dee@example.com' }])
    const d = b.deps(true)
    const r = await qrSignIn(d)
    expect(r).toEqual({ ok: true, tokens: expect.objectContaining({ token: 'hna_x', email: 'dee@example.com' }) })
    expect(d.shown).toEqual([qrSignInLink('hnq_code')])
    expect(d.confirm).toHaveBeenCalledWith('dee@example.com')
    expect(b.paths()).toEqual(['/api/auth/qr/start', '/api/auth/qr/poll', '/api/auth/qr/poll', '/api/auth/qr/claim'])
    expect(b.calls[0].body).toEqual({ label: 'MacBook Pro', kind: 'computer', computerId: 'c-1' })
  })

  it('claims nothing when the person says no to that account, and takes the QR back', async () => {
    const b = backend([{ status: 'approved', email: 'someone-else@example.com' }])
    const r = await qrSignIn(b.deps(false))
    expect(r).toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(b.paths()).not.toContain('/api/auth/qr/claim')
    expect(b.paths()).toContain('/api/auth/qr/cancel')
  })

  it('hands its caller a way to take the code back, the moment there is one', async () => {
    // `harness login --json` keeps it: when the app driving it goes away, the code goes with it.
    const b = backend([{ status: 'approved', email: 'dee@example.com' }])
    let takeBack: (() => Promise<void>) | undefined
    await qrSignIn({ ...b.deps(), onStarted: (cancel) => { takeBack = cancel } })
    expect(takeBack).toBeTypeOf('function')
    await takeBack!()
    expect(b.calls.at(-1)).toEqual({ path: '/api/auth/qr/cancel', body: { pollToken: 'hnp_poll' } })
  })

  it('reports a denial', async () => {
    const r = await qrSignIn(backend([{ status: 'denied' }]).deps())
    expect(r).toMatchObject({ ok: false, code: 'DENIED' })
  })

  it('keeps the same code alive past its first two minutes', async () => {
    const polls: Array<{ status: string; email?: string }> = Array.from({ length: 50 }, () => ({ status: 'pending' }))
    polls.push({ status: 'approved', email: 'dee@example.com' })
    const b = backend(polls)
    const d = b.deps()
    const r = await qrSignIn(d)
    expect(r.ok).toBe(true)
    expect(b.paths().filter((p) => p === '/api/auth/qr/extend').length).toBeGreaterThan(0)
    // One code throughout: the one the phone may already be looking at.
    expect(new Set(d.shown)).toEqual(new Set([qrSignInLink('hnq_code')]))
  })

  it('does not ask the person to confirm an approval delivered after the code expired', async () => {
    const b = backend([{ status: 'approved', email: 'dee@example.com' }])
    const d = b.deps()
    const post = d.post
    d.post = async <T>(path: string, body: unknown): Promise<T> => {
      if (path === '/api/auth/qr/poll') await d.sleep?.(121_000)
      return post<T>(path, body)
    }

    const r = await qrSignIn(d)

    expect(r).toMatchObject({ ok: false, code: 'EXPIRED' })
    expect(d.confirm).not.toHaveBeenCalled()
    expect(b.paths()).not.toContain('/api/auth/qr/claim')
    expect(b.paths()).toContain('/api/auth/qr/cancel')
  })

  it('reports expiry when the person confirms after the code ran out', async () => {
    const b = backend([{ status: 'approved', email: 'dee@example.com' }])
    const d = b.deps()
    d.confirm = vi.fn(async () => {
      await d.sleep?.(121_000)
      return true
    })

    const r = await qrSignIn(d)

    expect(r).toMatchObject({ ok: false, code: 'EXPIRED' })
    expect(b.paths()).not.toContain('/api/auth/qr/claim')
    expect(b.paths()).toContain('/api/auth/qr/cancel')
  })

  it('reports an expired claim as EXPIRED', async () => {
    const approved = [{ status: 'approved', email: 'dee@example.com' }]
    expect(await qrSignIn(backend(approved, { claim: 'expired' }).deps())).toMatchObject({ ok: false, code: 'EXPIRED' })
  })

  it('preserves an unrelated unauthorized claim failure', async () => {
    const approved = [{ status: 'approved', email: 'dee@example.com' }]
    expect(await qrSignIn(backend(approved, { claim: 'unauthorized' }).deps())).toMatchObject({ ok: false, code: 'BACKEND_ERROR' })
  })

  it('preserves other claim failures', async () => {
    const approved = [{ status: 'approved', email: 'dee@example.com' }]
    expect(await qrSignIn(backend(approved, { claim: 'fail' }).deps())).toMatchObject({ ok: false, code: 'BACKEND_ERROR' })
  })

  it('gives up when the code can live no longer', async () => {
    const b = backend(Array.from({ length: 200 }, () => ({ status: 'pending' })), { extend: 'fail' })
    const r = await qrSignIn(b.deps())
    expect(r).toMatchObject({ ok: false, code: 'EXPIRED' })
  })

  it('reports a backend that cannot start one', async () => {
    const r = await qrSignIn({ ...backend([]).deps(), post: async () => { throw new Error('HTTP 404') } })
    expect(r).toMatchObject({ ok: false, code: 'BACKEND_ERROR', message: 'HTTP 404' })
  })
})

// A device with no screen (lampOS's lamp, #1410): it says a short code aloud instead of showing a QR,
// and still asks its person "Sign in as <email>?" before any session exists.
describe('qrSignIn with a spoken code', () => {
  const spokenDeps = (b: ReturnType<typeof backend>, confirm = true) => {
    const said: Array<[string, number]> = []
    const d = { ...b.deps(confirm), showCode: (code: string, expiresIn: number) => { said.push([code, expiresIn]) } }
    return { d, said }
  }

  it('asks for a spoken code, says it instead of the QR, and confirms before claiming', async () => {
    const b = backend([{ status: 'approved', email: 'dee@example.com' }])
    const { d, said } = spokenDeps(b)
    const r = await qrSignIn(d)
    expect(r).toMatchObject({ ok: true })
    expect(b.calls[0].body).toEqual({ label: 'MacBook Pro', kind: 'computer', computerId: 'c-1', spokenCode: true })
    expect(said).toEqual([['12345678', 120]])
    expect(d.shown).toEqual([])
    expect(d.confirm).toHaveBeenCalledWith('dee@example.com')
  })

  it('does not ask the person to confirm an approval delivered after the spoken code expired', async () => {
    const b = backend([{ status: 'approved', email: 'dee@example.com' }])
    const { d } = spokenDeps(b)
    const post = d.post
    d.post = async <T>(path: string, body: unknown): Promise<T> => {
      if (path === '/api/auth/qr/poll') await d.sleep?.(121_000)
      return post<T>(path, body)
    }

    const r = await qrSignIn(d)

    expect(r).toMatchObject({ ok: false, code: 'EXPIRED' })
    expect(d.confirm).not.toHaveBeenCalled()
    expect(b.paths()).not.toContain('/api/auth/qr/claim')
    expect(b.paths()).toContain('/api/auth/qr/cancel')
  })

  it('says the same code again each time it is kept alive', async () => {
    const polls: Array<{ status: string; email?: string }> = Array.from({ length: 50 }, () => ({ status: 'pending' }))
    const b = backend([...polls, { status: 'approved', email: 'dee@example.com' }])
    const { d, said } = spokenDeps(b)
    await qrSignIn(d)
    expect(said.length).toBeGreaterThan(1)
    expect(new Set(said.map(([code]) => code))).toEqual(new Set(['12345678']))
  })

  it('says plainly that an older backend, which refuses the field, has no spoken codes', async () => {
    const b = backend([], { spoken: 'rejected' })
    const { d } = spokenDeps(b)
    expect(await qrSignIn(d)).toEqual({ ok: false, code: 'BACKEND_ERROR', message: 'This Harness backend cannot give a spoken code yet.' })
  })

  it('names the way back that gives a new spoken code when this one runs out', async () => {
    const b = backend(Array.from({ length: 60 }, () => ({ status: 'pending' })), { extend: 'fail' })
    const { d } = spokenDeps(b)
    expect(await qrSignIn(d)).toMatchObject({ ok: false, code: 'EXPIRED', message: 'The code expired. Run `harness login --code` again.' })
  })

  it('stops at once, and takes the sign-in back, when the backend gives no spoken code', async () => {
    const b = backend([], { spoken: 'unsupported' })
    const { d } = spokenDeps(b)
    expect(await qrSignIn(d)).toMatchObject({ ok: false, code: 'BACKEND_ERROR' })
    expect(b.paths()).toEqual(['/api/auth/qr/start', '/api/auth/qr/cancel'])
  })
})

describe('terminalQr', () => {
  it('draws a square code with a quiet zone, two module rows per line', () => {
    const lines = terminalQr(qrSignInLink('hnq_code'), { color: false }).split('\n')
    const width = lines[0].length
    expect(lines.every((l) => l.length === width)).toBe(true)
    // The quiet zone is light: full blocks all round the first line.
    expect(lines[0]).toBe('█'.repeat(width))
    expect(lines.length).toBe(Math.ceil(width / 2))
  })
})

describe('claimTicket', () => {
  const refused = (status: number) => Object.assign(new Error('refused'), { status })

  it('claims the ticket as the poll token and hands back the session', async () => {
    const post = vi.fn(async () => ({ token: 'hna_x', email: 'dee@example.com' })) as unknown as QrSignInDeps['post']
    expect(await claimTicket(post, 'hnp_t')).toEqual({ ok: true, tokens: { token: 'hna_x', email: 'dee@example.com' } })
    expect(post).toHaveBeenCalledWith('/api/auth/qr/claim', { pollToken: 'hnp_t' })
  })

  it('a refused ticket is TICKET_INVALID; a backend in trouble is BACKEND_ERROR', async () => {
    const reject = (err: Error) => vi.fn(async () => { throw err }) as unknown as QrSignInDeps['post']
    expect(await claimTicket(reject(refused(401)), 'hnp_t')).toMatchObject({ ok: false, code: 'TICKET_INVALID' })
    expect(await claimTicket(reject(refused(503)), 'hnp_t')).toMatchObject({ ok: false, code: 'BACKEND_ERROR' })
    expect(await claimTicket(reject(new Error('fetch failed')), 'hnp_t')).toMatchObject({ ok: false, code: 'BACKEND_ERROR' })
  })
})
