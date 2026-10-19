import { request } from 'node:http'
import { lstatSync } from 'node:fs'
import { localCredentialHeaders } from './localCredential.js'
import { localSocketPath } from './localSocket.js'
import { readDaemonRecord, writeDaemonRecord, type DaemonPipeRecord } from './daemonRecord.js'
import { daemonPipe, type LocalDaemonOptions } from './windows/daemonPipe.js'
import { pipeAbsent, pipeRequest } from './windows/pipeClient.js'

// The configured port names the private socket. TCP may use another port when a different OS
// user's daemon already holds that number; remember it in THIS user's data directory (lib/daemonRecord.ts).
export function savedDaemonPort(dataDir: string, configuredPort: number): number {
  return readDaemonRecord(dataDir, configuredPort)?.port ?? configuredPort
}

/** [pipe]: on Windows, the daemon's pipe and the core's pid, which a client cannot derive. */
export function saveDaemonPort(dataDir: string, configuredPort: number, port: number, pipe?: DaemonPipeRecord): void {
  writeDaemonRecord(dataDir, configuredPort, port, pipe)
}

function statusObject(statusCode: number | undefined, text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return statusCode === 200 && value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null
  } catch { return null }
}

/**
 * A native client must reach this OS user's socket, never whoever happens to hold a TCP port. On Windows that is
 * the daemon's pipe, and only an answer that proves the token is taken.
 */
export async function localDaemonStatus(dataDir: string, configuredPort: number, options: LocalDaemonOptions = {}): Promise<Record<string, unknown> | null> {
  if ((options.platform ?? process.platform) === 'win32') {
    const target = await (options.pipe ?? daemonPipe)(dataDir, configuredPort)
    if (!target) return null
    try {
      const reply = await pipeRequest(target, { method: 'GET', path: '/api/status', timeoutMs: 2_000, maxBytes: 4 * 1024 * 1024 })
      return statusObject(reply.status, reply.body)
    } catch { return null }
  }
  const socketPath = localSocketPath(dataDir, configuredPort)
  if (!socketPath) return null
  try {
    const entry = lstatSync(socketPath)
    if (!entry.isSocket() || (process.geteuid && entry.uid !== process.geteuid()) || (entry.mode & 0o077) !== 0) return null
  } catch { return null }
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/api/status', signal: AbortSignal.timeout(2_000) }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
        if (text.length > 4 * 1024 * 1024) req.destroy(new Error('status response too large'))
      })
      res.on('error', () => resolve(null))
      res.on('end', () => resolve(statusObject(res.statusCode, text)))
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

export interface DaemonCallOptions extends LocalDaemonOptions {
  /** The TCP port a call falls back to: the daemon's actual one (`savedDaemonPort`). */
  tcpPort: number
  fetch?: typeof fetch
}

/** Statuses a `Response` may not have a body with. */
const NULL_BODY = new Set([204, 205, 304])

/**
 * A control call to the running daemon (cli.ts `daemonCall`: `harness pair`, `harness devices`, …). On Windows it
 * goes over the daemon's pipe when there is one, and only an answer that proves the token is taken. It falls back
 * to loopback TCP, as on every other OS, when there is nothing to reach: no record, a daemon proven gone, or
 * nothing listening. A pipe that answers without the proof is not retried over TCP: whatever answered took the
 * daemon's name, and the caller is told so.
 */
export async function localDaemonCall(
  dataDir: string, configuredPort: number, method: 'GET' | 'POST', path: string, body: unknown, options: DaemonCallOptions,
): Promise<Response> {
  const headers: Record<string, string> = { 'x-adapter-local': '1' } // passes the local API's CSRF gate
  if (body) headers['content-type'] = 'application/json'
  const text = body ? JSON.stringify(body) : undefined
  if ((options.platform ?? process.platform) === 'win32') {
    const target = await (options.pipe ?? daemonPipe)(dataDir, configuredPort)
    if (target) {
      try {
        const reply = await pipeRequest(target, { method, path, headers, body: text, timeoutMs: 60_000 })
        const type = reply.headers['content-type']
        return new Response(NULL_BODY.has(reply.status) ? null : reply.body,
          { status: reply.status, headers: typeof type === 'string' ? { 'content-type': type } : {} })
      } catch (error) {
        if (!pipeAbsent(error)) throw error
      }
    }
  }
  return (options.fetch ?? fetch)(`http://127.0.0.1:${options.tcpPort}${path}`, {
    method,
    headers: { ...headers, ...localCredentialHeaders(dataDir) },
    body: text,
  })
}

/** Read-only compatibility for CLI status with daemons that have neither a Unix socket nor a Windows pipe.
 * Native hn connections must use localDaemonStatus instead. Never accept another daemon's status.
 */
export async function legacyDaemonStatus(port: number, pid: number | null, computerId: string, dataDir?: string): Promise<Record<string, unknown> | null> {
  if (!pid || !computerId) return null
  try {
    // With the daemon's local credential, the whole status; without it, only who the daemon is.
    const headers = dataDir ? localCredentialHeaders(dataDir) : {}
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers, signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return null
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const status = value as Record<string, unknown>
    return status.pid === pid && status.computerId === computerId ? status : null
  } catch { return null }
}
