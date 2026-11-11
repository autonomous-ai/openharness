import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { claudeSignInPageOf, ClaudeSignIns, loopbackRedirectOf } from './claudeSignIn.js'

const CODE_PAGE = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s'
const LOCAL_PAGE = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A57823%2Fcallback&state=s'
const OUTPUT = `Opening browser to sign in…\nIf the browser didn't open, visit: ${CODE_PAGE}\nPaste code here if prompted > `

/** A `claude auth login` that hands BROWSER [local], prints its code page and waits. */
function fakeLogin(local: string | null = LOCAL_PAGE) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    kill: vi.fn(),
  })
  const typed: string[] = []
  child.stdin.on('data', (d: Buffer) => typed.push(d.toString()))
  const close = (status: number) => { child.exitCode = status; child.emit('close', status) }
  const done = vi.fn()
  return { login: { child: child as never, page: () => local, done }, child, typed, close, done }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

// Codex 0.167's `codex login`: it hands BROWSER its page, which returns to 127.0.0.1:1455, prints the same page, and asks for
// no code; its callback answers 302 to its own /success, and it ends once a browser opens that (the Dell, 2026-11-06).
const CODEX_PAGE = 'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=s'
const CODEX_OUTPUT = `Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n${CODEX_PAGE}\n`

describe('Codex signed in from the phone', () => {
  it('starts codex login when asked for Codex, answers its localhost page alone, and is done when it ends', async () => {
    const f = fakeLogin(CODEX_PAGE)
    const login = { ...f.login, codePages: false }
    const start = vi.fn(() => login)
    const replay = vi.fn(async () => 302)
    const signIns = new ClaudeSignIns(start, replay)
    expect(await signIns.read({ operationId: 'op1', engine: 'codex' })).toEqual({ ok: true, state: 'page', url: CODEX_PAGE, codeUrl: null })
    expect(start).toHaveBeenCalledWith('codex')
    f.child.stdout.write(CODEX_OUTPUT)
    await tick()
    expect(await signIns.read({ operationId: 'op1', engine: 'codex', callback: 'http://127.0.0.1:1455/auth/callback?code=c&state=s' }))
      .toMatchObject({ state: 'checking' })
    expect(replay).toHaveBeenCalledWith('http://127.0.0.1:1455/auth/callback?code=c&state=s')
    f.close(0)
    expect(await signIns.read({ operationId: 'op1', engine: 'codex' })).toEqual({ ok: true, state: 'done' })
  })

  it('waits for BROWSER\'s page, and says Codex when it refuses', async () => {
    let page: string | null = null
    const f = fakeLogin()
    const signIns = new ClaudeSignIns(() => ({ ...f.login, page: () => page, codePages: false }), vi.fn(async () => 302))
    expect(await signIns.read({ operationId: 'op1', engine: 'codex' })).toMatchObject({ state: 'starting' })
    page = CODEX_PAGE
    expect(await signIns.read({ operationId: 'op1', engine: 'codex' })).toMatchObject({ state: 'page', url: CODEX_PAGE })
    f.child.stdout.write('Error logging in: bad\n')
    await tick()
    f.close(1)
    expect(await signIns.read({ operationId: 'op1', engine: 'codex' })).toEqual({ error: 'SIGN_IN_FAILED', detail: 'Codex did not take it: Error logging in: bad' })
  })

  it('follows the login to its own page on the same port, and nowhere else', async () => {
    const { createServer } = await import('node:http')
    const seen: string[] = []
    const server = createServer((request, response) => {
      seen.push(request.url ?? '')
      if (request.url?.startsWith('/auth/callback')) response.writeHead(302, { location: request.url.includes('away') ? 'http://example.com/x' : '/success' })
      else response.writeHead(200)
      response.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const page = `https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A${port}%2Fauth%2Fcallback&state=s`
    try {
      for (const callback of [`http://127.0.0.1:${port}/auth/callback?code=c`, `http://127.0.0.1:${port}/auth/callback?code=away`]) {
        const f = fakeLogin(page)
        const signIns = new ClaudeSignIns(() => ({ ...f.login, codePages: false }))
        await signIns.read({ operationId: 'op1', engine: 'codex' })
        expect(await signIns.read({ operationId: 'op1', engine: 'codex', callback })).toMatchObject({ state: 'checking' })
      }
      expect(seen).toEqual(['/auth/callback?code=c', '/success', '/auth/callback?code=away'])
    } finally {
      server.close()
    }
  })
})

describe('Claude Code signed in from the phone', () => {
  it('reads both pages: the one for a browser elsewhere, and where the localhost one returns', () => {
    expect(claudeSignInPageOf(OUTPUT)).toBe(CODE_PAGE)
    expect(claudeSignInPageOf('Opening browser to sign in…')).toBeNull()
    expect(loopbackRedirectOf(LOCAL_PAGE)?.port).toBe('57823')
    expect(loopbackRedirectOf(CODE_PAGE)).toBeNull()
  })

  it('answers the localhost page, hands the caught redirect to the login there, and is done when it ends', async () => {
    const f = fakeLogin()
    const replay = vi.fn(async () => 200)
    const signIns = new ClaudeSignIns(() => f.login, replay)
    expect(await signIns.read({ operationId: 'op1' })).toMatchObject({ state: 'starting' })
    f.child.stdout.write(OUTPUT)
    await tick()
    expect(await signIns.read({ operationId: 'op1' })).toEqual({ ok: true, state: 'page', url: LOCAL_PAGE, codeUrl: CODE_PAGE })
    expect(await signIns.read({ operationId: 'op1', callback: 'http://localhost:57823/callback?code=c&state=s' }))
      .toMatchObject({ state: 'checking' })
    expect(replay).toHaveBeenCalledWith('http://127.0.0.1:57823/callback?code=c&state=s')
    f.close(0)
    expect(await signIns.read({ operationId: 'op1' })).toEqual({ ok: true, state: 'done' })
    expect(f.done).toHaveBeenCalled()
  })

  // Review of #3149: a token exchange slower than the replay's 20 s wait still signs in.
  it('lets the login\'s own exit decide when the replay of its redirect fails, and says not delivered only when it failed', async () => {
    for (const [status, after] of [[0, { ok: true, state: 'done' }], [1, { error: 'NOT_DELIVERED' }]] as const) {
      const f = fakeLogin()
      const signIns = new ClaudeSignIns(() => f.login, vi.fn(async () => { throw new Error('timed out') }))
      await signIns.read({ operationId: 'op1' })
      f.child.stdout.write(OUTPUT)
      await tick()
      await signIns.read({ operationId: 'op1' })
      expect(await signIns.read({ operationId: 'op1', callback: 'http://localhost:57823/callback?code=c&state=s' }))
        .toMatchObject({ state: 'checking' })
      f.close(status)
      expect(await signIns.read({ operationId: 'op1' })).toMatchObject(after)
    }
    // Already gone when the replay failed: not delivered at once.
    const f = fakeLogin()
    const signIns = new ClaudeSignIns(() => f.login, vi.fn(async () => { f.child.exitCode = 1; throw new Error('refused') }))
    await signIns.read({ operationId: 'op1' })
    f.child.stdout.write(OUTPUT)
    await tick()
    await signIns.read({ operationId: 'op1' })
    expect(await signIns.read({ operationId: 'op1', callback: 'http://localhost:57823/callback?code=c&state=s' }))
      .toMatchObject({ error: 'NOT_DELIVERED' })
  })

  it('tells a redirect or code for a sign-in no longer here to start again, and starts none for it', async () => {
    const start = vi.fn(() => fakeLogin().login)
    const signIns = new ClaudeSignIns(start, vi.fn(async () => 200))
    expect(await signIns.read({ operationId: 'gone', callback: 'http://localhost:57823/callback?code=c' }))
      .toMatchObject({ error: 'SIGN_IN_EXPIRED' })
    expect(await signIns.read({ operationId: 'gone', code: 'abc#def' })).toMatchObject({ error: 'SIGN_IN_EXPIRED' })
    expect(start).not.toHaveBeenCalled()
  })

  it('never reaches another port or path of this machine', async () => {
    const f = fakeLogin()
    const replay = vi.fn(async () => 200)
    const signIns = new ClaudeSignIns(() => f.login, replay)
    await signIns.read({ operationId: 'op1' })
    f.child.stdout.write(OUTPUT)
    await tick()
    for (const callback of ['http://localhost:22/callback?code=c', 'http://localhost:57823/admin', 'https://localhost:57823/callback']) {
      expect(await signIns.read({ operationId: 'op1', callback })).toMatchObject({ error: 'NOT_EXPECTED' })
    }
    expect(replay).not.toHaveBeenCalled()
  })

  it('falls back to the code page, a few seconds on, when BROWSER was handed nothing; the code goes into its input', async () => {
    const f = fakeLogin(null)
    let now = 0
    const signIns = new ClaudeSignIns(() => f.login, vi.fn(), () => now)
    await signIns.read({ operationId: 'op1' })
    f.child.stdout.write(OUTPUT)
    await tick()
    expect(await signIns.read({ operationId: 'op1' })).toMatchObject({ state: 'starting' })
    now = 5_000
    expect(await signIns.read({ operationId: 'op1' })).toMatchObject({ state: 'page', url: CODE_PAGE })
    await signIns.read({ operationId: 'op1', code: ' abc#def \n' })
    await tick()
    expect(f.typed.join('')).toBe('abc#def\n')
  })

  it('says why Claude refused, without a page; a new id stops the sign-in before it', async () => {
    const first = fakeLogin(), second = fakeLogin()
    const start = vi.fn().mockReturnValueOnce(first.login).mockReturnValueOnce(second.login)
    const signIns = new ClaudeSignIns(start, vi.fn())
    await signIns.read({ operationId: 'op1' })
    first.child.stdout.write(`${OUTPUT}\nInvalid code`)
    await tick()
    first.close(1)
    expect(await signIns.read({ operationId: 'op1' })).toEqual({ error: 'SIGN_IN_FAILED', detail: 'Claude did not take it: Invalid code' })
    await signIns.read({ operationId: 'op2' })
    expect(start).toHaveBeenCalledTimes(2)
    expect(await signIns.read({})).toEqual({ error: 'INVALID_REQUEST' })
  })
})
