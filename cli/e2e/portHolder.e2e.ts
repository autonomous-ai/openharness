/**
 * Audit H1 (docs/security/2026-11-02-team-account-boundary.md), with the real daemon and the real hook. Another account
 * holds the daemon's port from boot, before this user's daemon starts at login. Here a plain listener of this user stands
 * for that account: no second account is made on a shared computer, so the refusal by account is proved in
 * src/hookServer.spec.ts with a stand-in, and the lookup itself in src/lib/peerAccount.spec.ts.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const started: IsolatedDaemon[] = []
afterEach(async () => { for (const each of started.splice(0)) await each.close() })

it('a daemon that lost its port still hears hooks, and the holder of the port hears nothing', async () => {
  const heard: Array<{ method?: string; url?: string; headers: IncomingMessage['headers'] }> = []
  const holder = createServer((req, res) => { heard.push({ method: req.method, url: req.url, headers: req.headers }); req.resume(); res.end('{}') })
  holder.on('upgrade', (req, socket) => { heard.push({ method: req.method, url: req.url, headers: req.headers }); socket.destroy() })
  await new Promise<void>((resolve) => { holder.listen(0, '127.0.0.1', resolve) })
  const port = (holder.address() as AddressInfo).port
  try {
    const d = await IsolatedDaemon.create({ port })
    started.push(d)
    // Until the daemon says where it listens the harness has no port for it: never the one it asked for.
    expect(d.configuredPort).toBe(port)
    expect(() => d.port).toThrow('the daemon has not said which port it listens on yet')
    await d.start({ ready: 'none' })
    await until('the daemon to open its socket', () => existsSync(d.socketPath), 60_000)
    await until('the daemon to move off the held port', () => /assigning a separate port/.test(d.log()), 60_000)
    // The harness follows it there, and the daemon answers on that port as itself. Asked with no credential, as
    // anyone can: this request must never carry one to the holder.
    const bound = await until('the daemon to say which port it took', () => d.port, 30_000)
    expect(bound).not.toBe(port)
    const status = await until('the daemon to answer on the port it took', async () => {
      const answer = await (await fetch(`http://127.0.0.1:${bound}/api/status`)).json() as Record<string, unknown>
      return answer.corePid ? answer : null
    }, 30_000, 200)
    expect(status).toMatchObject({ pid: d.pid, corePid: d.corePid() })
    const hook = spawn(process.execPath, [join(CLI_ROOT, 'hook', 'notify.mjs'), '--port', String(port), '--data-dir', d.dataDir], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { PATH: process.env.PATH, HOME: d.env.HOME, TMUX_PANE: '%999', TMUX_TMPDIR: d.root },
    })
    hook.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'a private prompt', session_id: '11111111-1111-4111-8111-111111111111', cwd: d.root }))
    await new Promise<void>((resolve) => { hook.on('exit', () => resolve()) })
    // The daemon took it, over the socket: it says what it did with a hook whose pane is not one of its own.
    await until('the daemon to hear the hook', () => /\[hooks\] 11111111/.test(d.log()), 30_000)
    // A start may ask the port who is there, with no secret: `GET /api/health` or `/api/status`, as anyone can. Nothing else
    // reaches the holder: no hook, no request with a body, no header carrying a secret.
    for (const request of heard) {
      expect(`${request.method} ${request.url}`).toMatch(/^GET \/api\/(health|status)$/)
      expect(Object.keys(request.headers).filter(name => /harness|authorization|cookie/i.test(name))).toEqual([])
    }
  } finally {
    holder.closeAllConnections()
    await new Promise<void>((resolve) => { holder.close(() => resolve()) })
  }
}, 180_000)

it('start() follows the daemon to the port it took, and again when a restart moves it', async () => {
  // cli-e2e run 43568618113, shard 2 (turns.e2e.ts): the port picked for the daemon was taken before it bound. The
  // daemon said `control port 34881 unavailable`, listened on 42457, and the harness asked 34881 until its 60 s ran
  // out. A stranger that is no daemon: it answers 503 to everything.
  const strangers: Server[] = []
  const hold = (port: number) => new Promise<number>((resolve, reject) => {
    const stranger = createServer((_req, res) => { res.writeHead(503).end() })
    stranger.once('error', reject)
    stranger.listen(port, '127.0.0.1', () => { strangers.push(stranger); resolve((stranger.address() as AddressInfo).port) })
  })
  try {
    const port = await hold(0)
    const d = await IsolatedDaemon.create({ port })
    started.push(d)
    await d.start()
    const first = d.port
    expect(first).not.toBe(port)
    let client = await LocalClient.connect(d, { tcp: true })
    client.close()
    // Stopped, and the port it had is taken too: the next start moves again, and the harness with it.
    await d.stop()
    await until('the port the daemon left to be taken', () => hold(first).catch(() => null), 10_000, 100)
    await d.start()
    expect([port, first]).not.toContain(d.port)
    client = await LocalClient.connect(d, { tcp: true })
    client.close()
  } finally {
    for (const stranger of strangers) {
      stranger.closeAllConnections()
      await new Promise<void>((resolve) => { stranger.close(() => resolve()) })
    }
  }
}, 180_000)
