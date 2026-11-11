// Audit W1 (docs/security/2026-11-02-team-account-windows.md), on real Windows: an engine hook and the CLI's fetch reach the
// daemon over a real named pipe, proving its token, and nothing goes to the port. The unit specs fake win32 over a Unix
// socket (hookNotify.spec.ts, lib/localTransport.spec.ts); this is the one run of the real pipe. Windows only; the Windows
// workflow runs it with src/lib/windows.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { writeDaemonRecord } from '../daemonRecord.js'
import { isTrustedLocal, listenLocalSocket } from '../localSocket.js'
import { daemonFetch } from '../localTransport.js'
import { newPipePath } from './pipeAuth.js'

const WINDOWS = process.platform === 'win32'
const HOOK = fileURLToPath(new URL('../../../hook/notify.mjs', import.meta.url))
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

/** A data folder with the daemon's token and its record of a real pipe, the daemon's served on it, and a holder on the port. */
async function daemon(): Promise<{ data: string; port: number; seen: Array<{ url: string; trusted: boolean; credential: unknown }>; heard: string[] }> {
  const data = mkdtempSync(join(tmpdir(), 'w1-pipe-'))
  cleanup.push(() => rmSync(data, { recursive: true, force: true }))
  const token = randomBytes(32), pipe = newPipePath()
  writeFileSync(join(data, 'daemon-token'), `${token.toString('hex')}\n`)
  const seen: Array<{ url: string; trusted: boolean; credential: unknown }> = []
  const served = await listenLocalSocket((req: IncomingMessage, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ url: req.url ?? '', trusted: isTrustedLocal(req), credential: req.headers['x-harness-local'] ?? req.headers['x-harness-hook-token'] })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  }, pipe, { token })
  cleanup.push(served.close)
  const heard: string[] = []
  const holder = createServer((req, res) => { heard.push(req.url ?? ''); req.resume(); res.end('{}') })
  await new Promise<void>((resolve) => { holder.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>((resolve) => { holder.closeAllConnections(); holder.close(() => resolve()) }))
  const port = (holder.address() as AddressInfo).port
  writeDaemonRecord(data, port, port, { pipe, pid: process.pid })
  return { data, port, seen, heard }
}

describe.runIf(WINDOWS)('the daemon\'s clients over a real pipe on Windows', () => {
  it('an engine hook posts over the pipe, proving the token, and the port hears nothing', async () => {
    const { data, port, seen, heard } = await daemon()
    const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_PANE: 'p1:%1', HARNESS_HOOK_DEADLINE_MS: '30000' }
    delete env.TMUX
    delete env.TMUX_PANE
    const hook = spawn(process.execPath, [HOOK, '--port', String(port), '--data-dir', data], { env, stdio: ['pipe', 'ignore', 'inherit'] })
    hook.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: '11111111-1111-4111-8111-111111111111', cwd: data }))
    await new Promise<void>((resolve) => { hook.on('exit', () => resolve()) })
    expect(seen).toEqual([{ url: '/api/hook/session-start', trusted: true, credential: undefined }])
    expect(heard).toEqual([])
  }, 60_000)

  it('the CLI\'s fetch goes over the pipe, and the port hears nothing', async () => {
    const { data, port, seen, heard } = await daemon()
    const answer = await daemonFetch(data, port)(`http://127.0.0.1:${port}/api/machines`, { headers: { 'x-adapter-local': '1' } })
    expect(answer.status).toBe(200)
    expect(seen).toEqual([{ url: '/api/machines', trusted: true, credential: undefined }])
    expect(heard).toEqual([])
  }, 60_000)
})
