/**
 * Codex's rate limits, as Codex itself reports them: `account/rateLimits/read` asked of `codex app-server` over stdio,
 * under the owner's own CODEX_HOME. Harness never opens Codex's sign-in; the CLI answers with its own (#4137).
 *
 * The protocol is the one engines/codex/nativeControl.ts speaks over the proxy, framed here as the stdio transport
 * frames it: one JSON object per line, `{ id, method, params }` requests with no `jsonrpc` field (Codex 0.166).
 */
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { engineBin } from './engineBin.js'
import { spawnTied } from './tied.js'
import { ownProcessGroup } from './windows/noWindow.js'
import { windowsEngineArgv } from './windows/launch.js'
import { VERSION } from '../version.js'

/** One window as Codex reports it (`RateLimitWindow`): `resetsAt` in unix seconds. */
export interface CodexWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export type CodexRateLimits =
  | { ok: true; accountId: string | null; primary: CodexWindow | null; secondary: CodexWindow | null }
  | { ok: false; reason: 'missing' | 'signedOut' | 'failed' }

export interface CodexRateLimitsOptions {
  /** A profile's CODEX_HOME; without it the child inherits the daemon's own environment unchanged. */
  codexHome?: string
  spawn?: typeof spawnTied
  timeoutMs?: number
  codexPath?: string
}

const INITIALIZE = 1, READ = 2
/** Codex answering that the read needs a login, in the words its errors use. */
const SIGNED_OUT = /auth|log ?in|sign(ed)? ?in|unauthori[sz]ed/i

/** One read in flight per home: a second ask while one runs shares it, never a second app-server. */
const reading = new Map<string, Promise<CodexRateLimits>>()

export function readCodexRateLimits(options: CodexRateLimitsOptions = {}): Promise<CodexRateLimits> {
  const key = options.codexHome ?? ''
  const running = reading.get(key)
  if (running) return running
  const read = readOnce(options).finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}

function readOnce({ codexHome, spawn = spawnTied, timeoutMs = 10_000, codexPath = engineBin('codex') }: CodexRateLimitsOptions): Promise<CodexRateLimits> {
  return new Promise(resolve => {
    const env = codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env
    let child: ChildProcess
    try {
      const argv = windowsEngineArgv('codex', [codexPath, 'app-server'], { environment: env })
      child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['pipe', 'pipe', 'ignore'], ...ownProcessGroup() })
    } catch {
      resolve({ ok: false, reason: 'failed' })
      return
    }
    const lines = createInterface({ input: child.stdout! })
    let done = false
    const finish = (result: CodexRateLimits) => {
      if (done) return
      done = true
      clearTimeout(timer)
      lines.close()
      killGroup(child)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'failed' }), timeoutMs)
    const send = (message: Record<string, unknown>) => child.stdin!.write(JSON.stringify(message) + '\n')
    child.on('error', (error: NodeJS.ErrnoException) => finish({ ok: false, reason: error.code === 'ENOENT' ? 'missing' : 'failed' }))
    // Closed only once its output is read, so an answer written just before it exits still counts.
    child.on('close', () => finish({ ok: false, reason: 'failed' }))
    // A server gone before the request is written: its close says so.
    child.stdin!.on('error', () => {})
    lines.on('line', line => {
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } }
      try { message = JSON.parse(line) } catch { return }
      if (message.id !== INITIALIZE && message.id !== READ) return
      if (message.error) {
        finish({ ok: false, reason: message.id === READ && SIGNED_OUT.test(String(message.error.message ?? '')) ? 'signedOut' : 'failed' })
      } else if (message.id === INITIALIZE) {
        send({ method: 'initialized' })
        send({ id: READ, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
      } else finish(rateLimitsOf(message.result))
    })
    send({ id: INITIALIZE, method: 'initialize', params: { clientInfo: { name: 'harness', title: 'Harness', version: VERSION }, capabilities: null } })
  })
}

function rateLimitsOf(result: unknown): CodexRateLimits {
  const value = record(result), limits = record(value?.rateLimits)
  if (!limits) return { ok: false, reason: 'failed' }
  return { ok: true, accountId: typeof value!.accountId === 'string' ? value!.accountId : null, primary: windowOf(limits.primary), secondary: windowOf(limits.secondary) }
}

function windowOf(raw: unknown): CodexWindow | null {
  const w = record(raw)
  if (!w || !finite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return null
  return { usedPercent: w.usedPercent, windowDurationMins: finite(w.windowDurationMins) ? w.windowDurationMins : null, resetsAt: finite(w.resetsAt) ? w.resetsAt : null }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/** The app-server and anything it started: its group off Windows (ownProcessGroup), the child itself on Windows. */
function killGroup(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return
  if (child.pid !== undefined && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* fall back to the child alone */ }
  }
  child.kill('SIGKILL')
}
