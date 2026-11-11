/**
 * Audit H1 (docs/security/2026-11-02-team-account-boundary.md), with the real daemon and the real hook. Another account
 * holds the daemon's port from boot, before this user's daemon starts at login. Here a plain listener of this user stands
 * for that account: no second account is made on a shared computer, so the refusal by account is proved in
 * src/hookServer.spec.ts with a stand-in, and the lookup itself in src/lib/peerAccount.spec.ts.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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
    await d.start({ ready: 'none' })
    await until('the daemon to open its socket', () => existsSync(d.socketPath), 60_000)
    await until('the daemon to move off the held port', () => /assigning a separate port/.test(d.log()), 60_000)
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
