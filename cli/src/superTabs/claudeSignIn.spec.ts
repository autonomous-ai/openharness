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
