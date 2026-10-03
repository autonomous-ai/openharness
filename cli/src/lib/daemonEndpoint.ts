import { request } from 'node:http'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localSocketPath } from './localSocket.js'

// The configured port names the private socket. TCP may use another port when a different OS
// user's daemon already holds that number; remember it in THIS user's data directory.
function portFile(dataDir: string, configuredPort: number): string {
  return join(dataDir, `daemon-${configuredPort}.json`)
}

export function savedDaemonPort(dataDir: string, configuredPort: number): number {
  try {
    const { port } = JSON.parse(readFileSync(portFile(dataDir, configuredPort), 'utf8'))
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  } catch { /* a first start, or an unreadable old record */ }
  return configuredPort
}

export function saveDaemonPort(dataDir: string, configuredPort: number, port: number): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const target = portFile(dataDir, configuredPort)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ port }) + '\n', { mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** A native client must reach this OS user's socket, never whoever happens to hold a TCP port. */
export async function localDaemonStatus(dataDir: string, configuredPort: number): Promise<Record<string, unknown> | null> {
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
      res.on('end', () => {
        try {
          const value: unknown = JSON.parse(text)
          resolve(res.statusCode === 200 && value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown> : null)
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

/** Read-only compatibility for CLI status on Windows and older daemons without a Unix socket.
 * Native hn connections must use localDaemonStatus instead. Never accept another daemon's status.
 */
export async function legacyDaemonStatus(port: number, pid: number | null, computerId: string): Promise<Record<string, unknown> | null> {
  if (!pid || !computerId) return null
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return null
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const status = value as Record<string, unknown>
    return status.pid === pid && status.computerId === computerId ? status : null
  } catch { return null }
}
