import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCodexRateLimits } from './codexRateLimits.js'

type Message = { id?: number; method?: string; params?: unknown }

/** A `codex app-server` over stdio: one JSON object per line each way. [answer] replies to each request it reads. */
function fakeServer(answer: (message: Message) => unknown | undefined) {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: null, pid: undefined, exitCode: null, kill: vi.fn(() => true) })
  const received: Message[] = []
  let buffered = ''
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString()
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const message = JSON.parse(buffered.slice(0, at)) as Message
      buffered = buffered.slice(at + 1)
      received.push(message)
      const reply = answer(message)
      if (reply !== undefined) stdout.write(JSON.stringify(reply) + '\n')
    }
  })
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
  const spawn = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    return child as unknown as ChildProcess
  })
  return { spawn, child, received, calls }
}

const LIMITS = {
  rateLimits: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_762_500_000 },
    secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_763_000_000 },
    credits: null, planType: 'pro',
  },
  accountId: 'acct-codex',
}

const answering = (result: unknown) => (message: Message) =>
  message.method === 'initialize' ? { id: message.id, result: { userAgent: 'codex/0.166.0' } }
    : message.method === 'account/rateLimits/read' ? { id: message.id, ...(result as object) } : undefined

describe('readCodexRateLimits', () => {
  it('asks codex app-server for its own rate limits: initialize, initialized, then account/rateLimits/read', async () => {
    const server = fakeServer(answering({ result: LIMITS }))
    const read = await readCodexRateLimits({ spawn: server.spawn, codexPath: 'codex' })
    expect(read).toEqual({
      ok: true, accountId: 'acct-codex',
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_762_500_000 },
      secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_763_000_000 },
    })
    expect(server.received).toEqual([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'harness', title: 'Harness', version: expect.any(String) }, capabilities: null } },
      { method: 'initialized' },
      { id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } },
    ])
    expect(server.calls[0]).toMatchObject({ command: 'codex', args: ['app-server'] })
    // Done: the child is never left running.
    expect(server.child.kill).toHaveBeenCalled()
  })

  it('runs under the owner\'s own environment, with CODEX_HOME only when a home is named', async () => {
    const plain = fakeServer(answering({ result: LIMITS }))
    await readCodexRateLimits({ spawn: plain.spawn, codexPath: 'codex' })
    expect((plain.calls[0]!.options.env as NodeJS.ProcessEnv).CODEX_HOME).toBe(process.env.CODEX_HOME)
    const profile = fakeServer(answering({ result: LIMITS }))
    await readCodexRateLimits({ codexHome: '/fixture/codex-work', spawn: profile.spawn, codexPath: 'codex' })
    expect((profile.calls[0]!.options.env as NodeJS.ProcessEnv).CODEX_HOME).toBe('/fixture/codex-work')
    expect(profile.calls[0]!.options.stdio).toEqual(['pipe', 'pipe', 'ignore'])
  })

  it('opens no window on Windows and its own process group elsewhere', async () => {
    const server = fakeServer(answering({ result: LIMITS }))
    await readCodexRateLimits({ spawn: server.spawn, codexPath: 'codex' })
    const options = server.calls[0]!.options
    if (process.platform === 'win32') expect(options).toMatchObject({ windowsHide: true, detached: undefined })
    else expect(options.detached).toBe(true)
  })

  it('reads a window it does not report as null, and an account it does not name as null', async () => {
    const server = fakeServer(answering({ result: { rateLimits: { primary: null, secondary: { usedPercent: 3, windowDurationMins: null, resetsAt: null } }, accountId: null } }))
    expect(await readCodexRateLimits({ spawn: server.spawn, codexPath: 'codex' }))
      .toEqual({ ok: true, accountId: null, primary: null, secondary: { usedPercent: 3, windowDurationMins: null, resetsAt: null } })
  })

  it('takes a window that is not a measured percentage for none, and a reply with no rate limits for a failure', async () => {
    const odd = fakeServer(answering({ result: { rateLimits: { primary: { usedPercent: 'lots' }, secondary: { usedPercent: 150 } }, accountId: 7 } }))
    expect(await readCodexRateLimits({ spawn: odd.spawn, codexPath: 'codex' })).toEqual({ ok: true, accountId: null, primary: null, secondary: null })
    const none = fakeServer(answering({ result: { accountId: 'a' } }))
    expect(await readCodexRateLimits({ spawn: none.spawn, codexPath: 'codex' })).toEqual({ ok: false, reason: 'failed' })
  })

  it('says signed out when codex answers that it needs a login', async () => {
    const server = fakeServer(answering({ error: { code: -32600, message: 'codex account authentication required to read rate limits' } }))
    expect(await readCodexRateLimits({ spawn: server.spawn, codexPath: 'codex' })).toEqual({ ok: false, reason: 'signedOut' })
    const login = fakeServer(answering({ error: { code: -32603, message: 'Not logged in: run codex login' } }))
    expect(await readCodexRateLimits({ spawn: login.spawn, codexPath: 'codex' })).toEqual({ ok: false, reason: 'signedOut' })
  })

  it('reads any other error reply as a failure, at initialize too', async () => {
    const server = fakeServer(answering({ error: { code: -32601, message: 'method not found' } }))
    expect(await readCodexRateLimits({ spawn: server.spawn, codexPath: 'codex' })).toEqual({ ok: false, reason: 'failed' })
    const refused = fakeServer(message => ({ id: message.id, error: { code: -32600, message: 'unsupported client' } }))
    expect(await readCodexRateLimits({ spawn: refused.spawn, codexPath: 'codex' })).toEqual({ ok: false, reason: 'failed' })
    expect(refused.received).toHaveLength(1)
  })

  it('says missing when there is no codex to start', async () => {
    const server = fakeServer(() => undefined)
    server.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => server.child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })))
      return server.child as unknown as ChildProcess
    })
    expect(await readCodexRateLimits({ spawn: server.spawn, codexPath: 'codex' })).toEqual({ ok: false, reason: 'missing' })
    const thrown = fakeServer(() => undefined)
    thrown.spawn.mockImplementationOnce(() => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) })
    expect(await readCodexRateLimits({ spawn: thrown.spawn, codexPath: 'codex' })).toEqual({ ok: false, reason: 'failed' })
  })

  it('reads a server that ends before it answers as a failure, skipping lines that are not JSON', async () => {
    const server = fakeServer(() => undefined)
    server.child.stdout.write('starting up\n')
    queueMicrotask(() => server.child.emit('close', 1, null))
    expect(await readCodexRateLimits({ spawn: server.spawn, codexPath: 'codex' })).toEqual({ ok: false, reason: 'failed' })
  })

  it('shares one read per home while it is in flight, and reads two homes apart', async () => {
    const one = fakeServer(answering({ result: LIMITS }))
    const [a, b] = [readCodexRateLimits({ codexHome: '/fixture/one', spawn: one.spawn, codexPath: 'codex' }),
      readCodexRateLimits({ codexHome: '/fixture/one', spawn: one.spawn, codexPath: 'codex' })]
    const two = fakeServer(answering({ result: LIMITS }))
    const c = readCodexRateLimits({ codexHome: '/fixture/two', spawn: two.spawn, codexPath: 'codex' })
    expect(await a).toEqual(await b)
    await c
    expect(one.spawn).toHaveBeenCalledOnce()
    expect(two.spawn).toHaveBeenCalledOnce()
    // Settled, the next ask reads again.
    const again = fakeServer(answering({ result: LIMITS }))
    await readCodexRateLimits({ codexHome: '/fixture/one', spawn: again.spawn, codexPath: 'codex' })
    expect(again.spawn).toHaveBeenCalledOnce()
  })

  describe('a real child', () => {
    let dir: string | null = null
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

    it('kills a hung server and its process group at the timeout, and says it failed', async () => {
      dir = mkdtempSync(join(tmpdir(), 'codex-rate-limits-'))
      const script = join(dir, 'hung.mjs')
      // Reads its requests and never answers, as a stuck app-server does.
      writeFileSync(script, 'process.stdin.resume(); setInterval(() => {}, 60_000)\n')
      let exitedWith: (signal: NodeJS.Signals | null) => void = () => {}
      const exited = new Promise<NodeJS.Signals | null>(resolve => { exitedWith = resolve })
      const spawn = (_command: string, args: string[], options: object) => {
        const child = nodeSpawn(process.execPath, [script, ...args], options)
        child.once('exit', (_code, signal) => exitedWith(signal))
        return child
      }
      expect(await readCodexRateLimits({ spawn, codexPath: 'codex', timeoutMs: 200 })).toEqual({ ok: false, reason: 'failed' })
      expect(await exited).toBe('SIGKILL')
    })
  })
})
