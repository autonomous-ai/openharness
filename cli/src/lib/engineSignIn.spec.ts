import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { claudeSignInPageOf, EngineSignIns, finishFirstRun, loopbackRedirectOf, trustHarnessFolder, type EngineLogin, type SignInEngine } from './engineSignIn.js'

/** What a finished sign-in recorded of the engine's first-run screens: never the person's own `.claude.json`. */
const firstRuns: SignInEngine[] = []
/** The folders a finished sign-in trusted: never in the person's own settings. */
const trusted: string[] = []
const signInsOf = (start: (engine: SignInEngine) => EngineLogin, replay?: (url: string) => Promise<number>, now?: () => number) =>
  new EngineSignIns(start, replay, now, (engine) => { firstRuns.push(engine) }, (engine, folder) => { trusted.push(`${engine} ${folder}`) })

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

describe('Codex signed in from Chat UI', () => {
  it('starts codex login when asked for Codex, answers its localhost page alone, and is done when it ends', async () => {
    const f = fakeLogin(CODEX_PAGE)
    const login = { ...f.login, codePages: false }
    const start = vi.fn(() => login)
    const replay = vi.fn(async () => 302)
    const signIns = signInsOf(start, replay)
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
    const signIns = signInsOf(() => ({ ...f.login, page: () => page, codePages: false }), vi.fn(async () => 302))
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
        const signIns = signInsOf(() => ({ ...f.login, codePages: false }))
        await signIns.read({ operationId: 'op1', engine: 'codex' })
        expect(await signIns.read({ operationId: 'op1', engine: 'codex', callback })).toMatchObject({ state: 'checking' })
      }
      expect(seen).toEqual(['/auth/callback?code=c', '/success', '/auth/callback?code=away'])
    } finally {
      server.close()
    }
  })
})

describe('Claude Code signed in from Chat UI', () => {
  it('reads both pages: the one for a browser elsewhere, and where the localhost one returns', () => {
    expect(claudeSignInPageOf(OUTPUT)).toBe(CODE_PAGE)
    expect(claudeSignInPageOf('Opening browser to sign in…')).toBeNull()
    expect(loopbackRedirectOf(LOCAL_PAGE)?.port).toBe('57823')
    expect(loopbackRedirectOf(CODE_PAGE)).toBeNull()
  })

  it('answers the localhost page, hands the caught redirect to the login there, and is done when it ends', async () => {
    const f = fakeLogin()
    const replay = vi.fn(async () => 200)
    const signIns = signInsOf(() => f.login, replay)
    expect(await signIns.read({ operationId: 'op1', engine: 'claude' })).toMatchObject({ state: 'starting' })
    f.child.stdout.write(OUTPUT)
    await tick()
    expect(await signIns.read({ operationId: 'op1', engine: 'claude' })).toEqual({ ok: true, state: 'page', url: LOCAL_PAGE, codeUrl: CODE_PAGE })
    expect(await signIns.read({ operationId: 'op1', engine: 'claude', callback: 'http://localhost:57823/callback?code=c&state=s' }))
      .toMatchObject({ state: 'checking' })
    expect(replay).toHaveBeenCalledWith('http://127.0.0.1:57823/callback?code=c&state=s')
    f.close(0)
    expect(await signIns.read({ operationId: 'op1', engine: 'claude' })).toEqual({ ok: true, state: 'done' })
    expect(f.done).toHaveBeenCalled()
  })

  // Review of #3149: a token exchange slower than the replay's 20 s wait still signs in.
  it('lets the login\'s own exit decide when the replay of its redirect fails, and says not delivered only when it failed', async () => {
    for (const [status, after] of [[0, { ok: true, state: 'done' }], [1, { error: 'NOT_DELIVERED' }]] as const) {
      const f = fakeLogin()
      const signIns = signInsOf(() => f.login, vi.fn(async () => { throw new Error('timed out') }))
      await signIns.read({ operationId: 'op1', engine: 'claude' })
      f.child.stdout.write(OUTPUT)
      await tick()
      await signIns.read({ operationId: 'op1', engine: 'claude' })
      expect(await signIns.read({ operationId: 'op1', engine: 'claude', callback: 'http://localhost:57823/callback?code=c&state=s' }))
        .toMatchObject({ state: 'checking' })
      f.close(status)
      expect(await signIns.read({ operationId: 'op1', engine: 'claude' })).toMatchObject(after)
    }
    // Already gone when the replay failed: not delivered at once.
    const f = fakeLogin()
    const signIns = signInsOf(() => f.login, vi.fn(async () => { f.child.exitCode = 1; throw new Error('refused') }))
    await signIns.read({ operationId: 'op1', engine: 'claude' })
    f.child.stdout.write(OUTPUT)
    await tick()
    await signIns.read({ operationId: 'op1', engine: 'claude' })
    expect(await signIns.read({ operationId: 'op1', engine: 'claude', callback: 'http://localhost:57823/callback?code=c&state=s' }))
      .toMatchObject({ error: 'NOT_DELIVERED' })
  })

  it('tells a redirect or code for a sign-in no longer here to start again, and starts none for it', async () => {
    const start = vi.fn(() => fakeLogin().login)
    const signIns = signInsOf(start, vi.fn(async () => 200))
    expect(await signIns.read({ operationId: 'gone', engine: 'claude', callback: 'http://localhost:57823/callback?code=c' }))
      .toMatchObject({ error: 'SIGN_IN_EXPIRED' })
    expect(await signIns.read({ operationId: 'gone', engine: 'claude', code: 'abc#def' })).toMatchObject({ error: 'SIGN_IN_EXPIRED' })
    expect(start).not.toHaveBeenCalled()
  })

  it('never reaches another port or path of this machine', async () => {
    const f = fakeLogin()
    const replay = vi.fn(async () => 200)
    const signIns = signInsOf(() => f.login, replay)
    await signIns.read({ operationId: 'op1', engine: 'claude' })
    f.child.stdout.write(OUTPUT)
    await tick()
    for (const callback of ['http://localhost:22/callback?code=c', 'http://localhost:57823/admin', 'https://localhost:57823/callback']) {
      expect(await signIns.read({ operationId: 'op1', engine: 'claude', callback })).toMatchObject({ error: 'NOT_EXPECTED' })
    }
    expect(replay).not.toHaveBeenCalled()
  })

  it('falls back to the code page, a few seconds on, when BROWSER was handed nothing; the code goes into its input', async () => {
    const f = fakeLogin(null)
    let now = 0
    const signIns = signInsOf(() => f.login, vi.fn(), () => now)
    await signIns.read({ operationId: 'op1', engine: 'claude' })
    f.child.stdout.write(OUTPUT)
    await tick()
    expect(await signIns.read({ operationId: 'op1', engine: 'claude' })).toMatchObject({ state: 'starting' })
    now = 5_000
    expect(await signIns.read({ operationId: 'op1', engine: 'claude' })).toMatchObject({ state: 'page', url: CODE_PAGE })
    await signIns.read({ operationId: 'op1', engine: 'claude', code: ' abc#def \n' })
    await tick()
    expect(f.typed.join('')).toBe('abc#def\n')
  })

  it('says why Claude refused, without a page; a new id stops the sign-in before it', async () => {
    const first = fakeLogin(), second = fakeLogin()
    const start = vi.fn().mockReturnValueOnce(first.login).mockReturnValueOnce(second.login)
    const signIns = signInsOf(start, vi.fn())
    await signIns.read({ operationId: 'op1', engine: 'claude' })
    first.child.stdout.write(`${OUTPUT}\nInvalid code`)
    await tick()
    first.close(1)
    expect(await signIns.read({ operationId: 'op1', engine: 'claude' })).toEqual({ error: 'SIGN_IN_FAILED', detail: 'Claude did not take it: Invalid code' })
    await signIns.read({ operationId: 'op2', engine: 'claude' })
    expect(start).toHaveBeenCalledTimes(2)
    expect(await signIns.read({})).toEqual({ error: 'INVALID_REQUEST' })
  })

  it('names the engine it signs in, and only Claude Code or Codex', async () => {
    const start = vi.fn(() => fakeLogin().login)
    const signIns = signInsOf(start)
    for (const engine of [undefined, 'opencode', 'claude; rm -rf /']) {
      expect(await signIns.read({ operationId: 'op1', engine })).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(await signIns.read({ operationId: 'not an id!', engine: 'claude' })).toEqual({ error: 'INVALID_REQUEST' })
    expect(start).not.toHaveBeenCalled()
  })

  // Pixel, 2026-11-26: a harness started signed out waits on Claude Code's first-run screens, which Chat UI cannot show;
  // the phone restarts it once signed in, past them.
  it('records the first-run screens done once signed in, and not when the sign-in failed', async () => {
    firstRuns.length = 0
    for (const status of [1, 0]) {
      const f = fakeLogin()
      const signIns = signInsOf(() => f.login, vi.fn(async () => 200))
      await signIns.read({ operationId: 'op1', engine: 'claude' })
      f.close(status)
    }
    expect(firstRuns).toEqual(['claude'])
  })

  // MSI, 2026-11-26: signed in from the phone, the app gone before it started the harness again, which stayed on
  // Claude Code's theme screen.
  it('records the first-run screens of an engine signed in already, asked alone, with no login', async () => {
    firstRuns.length = 0
    const start = vi.fn(() => fakeLogin().login)
    expect(await signInsOf(start).read({ engine: 'claude', firstRun: true })).toEqual({ ok: true, state: 'done' })
    expect(firstRuns).toEqual(['claude'])
    expect(start).not.toHaveBeenCalled()
    const failing = new EngineSignIns(start, vi.fn(), Date.now, () => { throw new Error('read-only home') })
    expect(await failing.read({ engine: 'claude', firstRun: true })).toMatchObject({ error: 'FIRST_RUN_UNRECORDED' })
    expect(await failing.read({ firstRun: true })).toEqual({ error: 'INVALID_REQUEST' })
  })

  // MSI, 2026-11-26, after a factory reset: signed in, Claude Code then stopped at "Is this a project you trust?".
  it('trusts the harness\'s folder it is told of once signed in, and not before', async () => {
    trusted.length = 0
    const f = fakeLogin()
    const signIns = signInsOf(() => f.login, vi.fn(async () => 200))
    await signIns.read({ operationId: 'op1', engine: 'claude', folder: '/home/me/projects/a' })
    expect(trusted).toEqual([])
    f.close(0)
    expect(await signIns.read({ operationId: 'op1', engine: 'claude', folder: '/home/me/projects/a' })).toEqual({ ok: true, state: 'done' })
    expect(await signInsOf(vi.fn()).read({ engine: 'codex', firstRun: true, folder: '/home/me/projects/b' })).toEqual({ ok: true, state: 'done' })
    expect(trusted).toEqual(['claude /home/me/projects/a', 'codex /home/me/projects/b'])
    const failing = new EngineSignIns(vi.fn(), vi.fn(), Date.now, () => {}, () => { throw new Error('read-only home') })
    expect(await failing.read({ engine: 'claude', firstRun: true, folder: '/home/me/projects/a' })).toEqual({ ok: true, state: 'done' })
  })

  it('is signed in even when the first-run screens could not be recorded', async () => {
    const f = fakeLogin()
    const signIns = new EngineSignIns(() => f.login, vi.fn(async () => 200), Date.now, () => { throw new Error('read-only home') })
    await signIns.read({ operationId: 'op1', engine: 'claude' })
    f.close(0)
    expect(await signIns.read({ operationId: 'op1', engine: 'claude' })).toEqual({ ok: true, state: 'done' })
  })

  it('says the engine is not here when its login cannot start', async () => {
    const f = fakeLogin()
    const signIns = signInsOf(() => f.login)
    await signIns.read({ operationId: 'op1', engine: 'codex' })
    f.child.emit('error', new Error('ENOENT'))
    expect(await signIns.read({ operationId: 'op1', engine: 'codex' }))
      .toEqual({ error: 'ENGINE_UNAVAILABLE', detail: 'Codex is not installed on this computer.' })
  })
})

describe("Claude Code's first-run screens, recorded as finishing them would", () => {
  const home = () => mkdtempSync(join(tmpdir(), 'engine-first-run-'))

  it('writes its default text style and the screens done, in CLAUDE_CONFIG_DIR', () => {
    const folder = home()
    try {
      finishFirstRun('claude', { CLAUDE_CONFIG_DIR: folder })
      expect(JSON.parse(readFileSync(join(folder, '.claude.json'), 'utf8'))).toEqual({ theme: 'dark', hasCompletedOnboarding: true })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('keeps what the person has, their own text style included, and leaves a file it cannot read', () => {
    const folder = home()
    try {
      const file = join(folder, '.claude.json')
      writeFileSync(file, JSON.stringify({ theme: 'light', projects: { '/p': {} } }))
      finishFirstRun('claude', { CLAUDE_CONFIG_DIR: folder })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'light', hasCompletedOnboarding: true, projects: { '/p': {} } })
      for (const text of ['not json', '[1]']) {
        writeFileSync(file, text)
        finishFirstRun('claude', { CLAUDE_CONFIG_DIR: folder })
        expect(readFileSync(file, 'utf8')).toBe(text)
      }
      writeFileSync(file, JSON.stringify({ theme: 'light', hasCompletedOnboarding: false }))
      finishFirstRun('claude', { CLAUDE_CONFIG_DIR: folder })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'light', hasCompletedOnboarding: false })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('does nothing for Codex, which has no such screens', () => {
    const folder = home()
    try {
      finishFirstRun('codex', { CLAUDE_CONFIG_DIR: folder })
      expect(() => readFileSync(join(folder, '.claude.json'))).toThrow()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("a harness's folder trusted once signed in", () => {
  const ROOT = process.env.HARNESS_OS === '1' ? 'projects' : 'harnesses'
  const home = () => mkdtempSync(join(tmpdir(), 'engine-trust-'))

  it('trusts a folder in the projects root, making the settings file of an engine that never ran', () => {
    const personal = home()
    try {
      const folder = join(personal, ROOT, 'claude-1')
      mkdirSync(folder, { recursive: true })
      const environment = { HOME: personal, CODEX_HOME: join(personal, '.codex') }
      trustHarnessFolder('claude', folder, environment)
      expect(JSON.parse(readFileSync(join(personal, '.claude.json'), 'utf8')).projects[folder]).toMatchObject({ hasTrustDialogAccepted: true })
      trustHarnessFolder('codex', folder, environment)
      expect(readFileSync(join(personal, '.codex', 'config.toml'), 'utf8')).toContain('trust_level = "trusted"')
    } finally {
      rmSync(personal, { recursive: true, force: true })
    }
  })

  it('leaves a folder the person chose, one not there, and a path spelled oddly to the engine', () => {
    const personal = home()
    try {
      const chosen = join(personal, 'code')
      mkdirSync(chosen)
      for (const folder of [chosen, join(personal, ROOT, 'gone'), `${join(personal, ROOT)}/x/../code`, 'projects/claude-1']) {
        trustHarnessFolder('claude', folder, { HOME: personal })
      }
      expect(() => readFileSync(join(personal, '.claude.json'))).toThrow()
    } finally {
      rmSync(personal, { recursive: true, force: true })
    }
  })
})
