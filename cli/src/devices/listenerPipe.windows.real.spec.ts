// The devices' pipe on real Windows (spec, "The devices pipe's API"): the listener serves a real named pipe with its own
// token and record, and tellDevices, askDevices and streamDevices find it by the record and prove the token, with this
// process's own proof of the recorded pid (the real process table). The unit specs stand the pipe in with a Unix socket
// named harness-<id> (listenerClient.spec.ts, services/devicesListener.spec.ts); this is the one run of the real pipe.
// Windows only.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newPipeNonce, newPipePath, PIPE_AUTH_HEADER, pipeAuthValue } from '../lib/windows/pipeAuth.js'
import { frontHandler, notifyHandler, openDevicesListener, tabsStream } from '../services/devicesListener.js'
import { askDevices, streamDevices, tellDevices } from './listenerClient.js'
import { devicesRecordPath } from './listenerPipe.js'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

/** One message on [pipe] with [auth] in x-harness-auth, or none, sent as any program could: its status and body. */
function raw(pipe: string, auth: string | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath: pipe, agent: false, method: 'POST', path: '/', headers: auth === null ? {} : { [PIPE_AUTH_HEADER]: auth } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    sent.on('error', reject)
    sent.end('{"type":"front","app":"vscode"}')
  })
}

describe.runIf(process.platform === 'win32')('the devices over a real pipe on Windows', () => {
  it('tell, ask and stream reach the listener the record names; no auth or another token is 401; once closed the record is gone and a tell is false', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'devices-pipe-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const pipe = newPipePath()
    const fronts: string[] = []
    const tabs = tabsStream()
    const lines: string[] = []
    const listener = await openDevicesListener({
      path: null,
      pipe: { path: pipe, dataDir },
      handlers: {
        front: frontHandler((app) => fronts.push(app)),
        // The answer, then this process's loop held past the ask's 2 s bound, as in run 45948212750: the answer is
        // still taken.
        notify: notifyHandler((mode) => {
          setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500))
          return { mode }
        }),
        tabs: tabs.handler,
      },
      log: (line) => lines.push(line),
    })
    expect(lines).toEqual(['[devices] listener open'])
    let open = true
    cleanup.push(() => open && listener!.close())

    expect(await tellDevices(dataDir, { type: 'front', app: 'vscode' })).toBe(true)
    expect(fronts).toEqual(['vscode'])

    const stop = new AbortController()
    const chunks: Buffer[] = []
    const streamed = streamDevices(dataDir, { type: 'tabs' }, (data) => { chunks.push(data) }, { signal: stop.signal })
    await vi.waitFor(() => expect(tabs.isOpen()).toBe(true))
    expect(tabs.select({ app: 'terminal-app', tty: '/dev/ttys023' }, true)).toBe(true)
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toBe('{"app":"terminal-app","tty":"/dev/ttys023","raise":true}\n'))
    stop.abort()
    expect(await streamed).toBe(true)

    // The last message on a connection this process keeps: the hold outlasts the listener's 2 s deadline too, so the
    // listener, in this process as well, ends the ask's connection as the hold ends, before this side reads that end
    // and lets the connection go; a message sent next on it fails with EPIPE (CI run 45968139151). The 401s below
    // connect anew.
    expect(await askDevices(dataDir, { type: 'notify', mode: 'you' })).toEqual({ mode: 'you' })

    const refused = { status: 401, body: '{"error":"PIPE_AUTH_REQUIRED"}' }
    expect(await raw(pipe, null)).toEqual(refused)
    expect(await raw(pipe, pipeAuthValue(randomBytes(32), newPipeNonce(pipe)))).toEqual(refused)
    expect(fronts).toEqual(['vscode'])

    await listener!.close()
    open = false
    expect(existsSync(devicesRecordPath(dataDir))).toBe(false)
    expect(await tellDevices(dataDir, { type: 'front', app: 'none' })).toBe(false)
  }, 60_000)
})
