// The hook's caller on real Windows (Task 31 of docs/plans/2026-11-19-dial-windows-plan.md): a hook that a real
// PowerShell or a real cmd runs, as Codex and Command Code run theirs, names the process above the shell, read from the
// real pty host's table. hookNotify.spec.ts fakes the table; this is the one run of real shells. Windows only, and only
// with a built pty host (HARNESS_PTY_BIN).
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeDaemonRecord } from './lib/daemonRecord.js'
import { listenLocalSocket } from './lib/localSocket.js'
import { newPipePath } from './lib/windows/pipeAuth.js'

const HOOK = fileURLToPath(new URL('../hook/notify.mjs', import.meta.url))
const STOP = JSON.stringify({ hook_event_name: 'Stop', session_id: '22222222-2222-4222-8222-222222222222' })
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

/** A stand-in daemon: a data folder with its token and the record of a real pipe served here, keeping each body. */
async function daemon(): Promise<{ data: string; port: number; bodies: Array<Record<string, unknown>> }> {
  const data = mkdtempSync(join(tmpdir(), 'hook-caller-'))
  cleanup.push(() => rmSync(data, { recursive: true, force: true }))
  const token = randomBytes(32), pipe = newPipePath()
  writeFileSync(join(data, 'daemon-token'), `${token.toString('hex')}\n`)
  const bodies: Array<Record<string, unknown>> = []
  const served = await listenLocalSocket((req: IncomingMessage, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  }, pipe, { token })
  cleanup.push(served.close)
  // The record names a port as well as the pipe; a holder keeps that port this run's.
  const holder = createServer((_req, res) => { res.end('{}') })
  await new Promise<void>((resolve) => { holder.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>((resolve) => { holder.closeAllConnections(); holder.close(() => resolve()) }))
  const port = (holder.address() as AddressInfo).port
  writeDaemonRecord(data, port, port, { pipe, pid: process.pid })
  return { data, port, bodies }
}

/** Runs [child] with a paneless Stop on its stdin, and answers the caller the hook named. */
async function callerOf(child: ChildProcess, bodies: Array<Record<string, unknown>>): Promise<unknown> {
  child.stdin!.end(STOP)
  await new Promise<void>((resolve) => { child.on('exit', () => resolve()) })
  await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 10_000 })
  return bodies[0].callerPid
}

/** This process's environment, outside any pane, with no endpoint of the runner's own. */
function hookEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOOK_DEADLINE_MS: '30000' }
  for (const name of ['TMUX', 'TMUX_PANE', 'HARNESS_PANE', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']) delete env[name]
  return env
}

describe.runIf(process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN)('the hook\'s caller through real shells on Windows', () => {
  it('through powershell -Command, as Codex runs it, the caller is the process above PowerShell', async () => {
    const { data, port, bodies } = await daemon()
    const quote = (text: string): string => `'${text.replaceAll('\'', '\'\'')}'`
    const command = `& ${quote(process.execPath)} ${quote(HOOK)} --port ${port} --data-dir ${quote(data)} --engine codex`
    const shell = spawn('powershell.exe', ['-NoProfile', '-Command', command], { env: hookEnv(), stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true })
    expect(await callerOf(shell, bodies)).toBe(process.pid)
  }, 60_000)

  it('through cmd /c, as Command Code runs it, the caller is the process above cmd', async () => {
    const { data, port, bodies } = await daemon()
    const quote = (text: string): string => `"${text}"`
    // Verbatim: Node would escape the inner quotes with backslashes, which cmd does not read; /s takes the outer pair.
    const line = `"${quote(process.execPath)} ${quote(HOOK)} --port ${port} --data-dir ${quote(data)} --engine commandcode"`
    const shell = spawn('cmd.exe', ['/d', '/s', '/c', line], { env: hookEnv(), stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true, windowsVerbatimArguments: true })
    expect(await callerOf(shell, bodies)).toBe(process.pid)
  }, 60_000)

  it('run with no shell and no engine named, the caller is its parent', async () => {
    const { data, port, bodies } = await daemon()
    const hook = spawn(process.execPath, [HOOK, '--port', String(port), '--data-dir', data], { env: hookEnv(), stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true })
    expect(await callerOf(hook, bodies)).toBe(process.pid)
  }, 60_000)
})
