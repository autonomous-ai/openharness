/**
 * Runs one command for the guest accounts and the installers beside them, and collects what it says. In a file of its
 * own: the core starts a Windows guest's terminal host with it (lib/windows/guestHostBackend.ts), and loaded the
 * whole of the guests' accounts for it (lib/guestAccounts.ts; the audit of 2026-11-12).
 */
import { spawn } from 'node:child_process'

export interface GuestRunResult { code: number | null; stdout: string; stderr: string }
export interface GuestRunOptions {
  timeoutMs?: number
  /** The terminal's own stdin/stdout/stderr: a password prompt (Linux `sudo`) must reach the person. */
  interactive?: boolean
  /** Each line of stdout as it comes (an engine install's progress). */
  onLine?: (line: string) => void
}
export type GuestRunner = (command: string, args: readonly string[], options?: GuestRunOptions) => Promise<GuestRunResult>

/** Runs a command and collects its output; never rejects (a spawn error is `code: null`). */
export const runGuestCommand: GuestRunner = (command, args, options = {}) => new Promise((resolve) => {
  let stdout = '', stderr = '', pending = ''
  const child = spawn(command, [...args], { stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
  const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : null
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    stdout += text
    if (!options.onLine) return
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) options.onLine(line)
  })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.on('error', (error) => { if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr || error.message }) })
  child.on('close', (code) => {
    if (timer) clearTimeout(timer)
    if (pending && options.onLine) options.onLine(pending)
    resolve({ code, stdout, stderr })
  })
})
