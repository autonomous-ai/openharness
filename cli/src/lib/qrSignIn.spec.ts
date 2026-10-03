import { describe, expect, it, vi } from 'vitest'
import { qrSignIn, qrSignInLink, type QrSignInDeps } from './qrSignIn.js'
import { terminalQr } from './terminalQr.js'

/** A backend that answers the QR sign-in routes from a script of poll answers. */
function backend(polls: Array<{ status: string; email?: string }>, opts: { extend?: 'ok' | 'fail'; claim?: 'ok' | 'fail' } = {}) {
  const calls: Array<{ path: string; body: unknown }> = []
  let clock = 0
  const post = vi.fn(async (path: string, body: unknown) => {
    calls.push({ path, body })
    if (path === '/api/auth/qr/start') return { code: 'hnq_code', pollToken: 'hnp_poll', expiresIn: 120 }
    if (path === '/api/auth/qr/poll') return polls.shift() ?? { status: 'pending' }
    if (path === '/api/auth/qr/extend') {
      if (opts.extend === 'fail') throw new Error('This code has expired.')
      return { expiresIn: 120 }
    }
    if (path === '/api/auth/qr/claim') {
      if (opts.claim === 'fail') throw new Error('Nothing to claim')
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
