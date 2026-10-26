// Windows process control against the real Harness PTY host: its process table, the Job check in `validate`, the
// agent signaller. Windows only. Build the host first:
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/processControl.real.spec.ts
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PtyHostBackend } from '../ptyHostBackend.js'
import { listDiscoveries } from '../ptyHost/launch.js'
import { PTY_PROTOCOL } from '../ptyHost/protocol.js'
import { processRows } from '../processTable.js'
import { signalAgentProcess } from '../processSignals.js'
import { removeTree } from '../terminalBackend.contract.js'
import { processIdentityOf } from '../terminalRuntime.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN
const CASE_TIMEOUT_MS = 90_000

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const running = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

;(enabled ? describe : describe.skip)('Windows process control on the real pty host', () => {
  it('lists a pane\'s tree, validates its engine by the Job, and ends the tree through the host', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pty-windows-'))
    const dir = mkdtempSync(join(tmpdir(), 'pty-windows-engine-'))
    // An "engine" the process table recognises by its name (opencode's signature), which runs until killed.
    const engine = join(dir, 'opencode.exe')
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), engine)
    const backend = new PtyHostBackend({ home })
    let foreign: ReturnType<typeof spawn> | null = null
    try {
      const prepared = await backend.prepare({ ownedPanes: new Map() })
      if (prepared.state !== 'ready') throw new Error(`the pty host is unavailable: ${prepared.reason}`)
      const created = await backend.create({
        command: ['powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-Command',
          `$p = Start-Process -PassThru -WindowStyle Hidden '${engine}' -ArgumentList '-n','600','127.0.0.1'; echo "child=$($p.Id)"`],
      })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      const pane = created.runtime
      const root = await backend.rootProcess(pane)
      if (typeof root !== 'number') throw new Error(`no root: ${String(root)}`)

      // The table (the host's `processes`, set by prepare) has the root and its child, linked.
      const rows = await until(processRows, (table) => !!table?.some((row) => row.parentPid === root && row.executable.toLowerCase() === 'opencode.exe'))
      const rootRow = rows?.find((row) => row.pid === root)
      const child = rows?.find((row) => row.parentPid === root && row.executable.toLowerCase() === 'opencode.exe')
      expect(rootRow?.startMarker).toMatch(/^w:\d+$/)
      expect(child?.startMarker).toMatch(/^w:\d+$/)
      const identity = processIdentityOf(child!)

      // validate: the child is the engine, and in the pane's Job.
      expect(await backend.validate(pane, { engine: 'opencode', processIdentity: identity })).toEqual({ state: 'alive' })
      // The same pid recorded with another start: a recycled pid is never the engine.
      expect(await backend.validate(pane, { engine: 'opencode', processIdentity: { ...identity, startMarker: 'w:1' } }))
        .toEqual({ state: 'gone', reason: 'process changed under ptyhost pane', replaced: true })
      // A process outside the pane with the engine's name is someone else's.
      foreign = spawn(engine, ['-n', '600', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
      const foreignRow = (await until(processRows, (table) => !!table?.some((row) => row.pid === foreign!.pid)))?.find((row) => row.pid === foreign!.pid)
      expect(await backend.validate(pane, { engine: 'opencode', processIdentity: processIdentityOf(foreignRow!) }))
        .toMatchObject({ state: 'gone' })

      // The agent signaller: SIGKILL of the pane root ends its whole tree, and leaves the held pane (dead).
      signalAgentProcess(root, 'SIGKILL')
      expect(await until(async () => running(root) || running(identity.pid), (alive) => !alive)).toBe(false)
      expect(await until(() => backend.paneState(pane), (state) => state !== 'gone' && state !== 'unknown' && state.dead))
        .toMatchObject({ dead: true })
      expect((await backend.kill(pane)).state).toBe('succeeded')
    } finally {
      foreign?.kill()
      backend.dispose()
      const pid = listDiscoveries(home).findLast((found) => found.protocol === PTY_PROTOCOL)?.pid
      if (pid) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
      await removeTree(home).catch(() => {})
      await removeTree(dir).catch(() => {})
    }
  }, CASE_TIMEOUT_MS)

  // A restart or swap on a pty host pane: hold the pane, end its engine (the pane's root) through the agent
  // signaller, respawn in the same pane (restartAgent.ts, core/agents/swap.ts). The signaller must never close
  // the pane, or the respawn finds none.
  it('a restart through signalAgentProcess keeps the pane: the respawn runs in the same pane id', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pty-windows-restart-'))
    const backend = new PtyHostBackend({ home })
    try {
      const prepared = await backend.prepare({ ownedPanes: new Map() })
      if (prepared.state !== 'ready') throw new Error(`the pty host is unavailable: ${prepared.reason}`)
      const created = await backend.create({ command: ['powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-Command', 'echo first-run'] })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      const pane = created.runtime
      const screen = async (): Promise<string> => {
        const read = await backend.capture(pane, { historyLines: 100, ansi: false })
        return read.state === 'succeeded' ? read.value : ''
      }
      await until(screen, (text) => /^first-run$/m.test(text))
      const root = await backend.rootProcess(pane)
      if (typeof root !== 'number') throw new Error(`no root: ${String(root)}`)

      expect((await backend.holdOpen(pane)).state).toBe('succeeded')
      signalAgentProcess(root, 'SIGTERM')
      expect(await until(async () => running(root), (alive) => !alive)).toBe(false)
      expect(await until(() => backend.paneState(pane), (state) => state !== 'gone' && state !== 'unknown' && state.dead))
        .toMatchObject({ dead: true })

      const respawned = await backend.respawn(pane, { command: ['powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-Command', 'echo second-run'] })
      expect(respawned.state).toBe('succeeded')
      expect(await until(screen, (text) => /^second-run$/m.test(text))).toMatch(/^second-run$/m)
      const again = await backend.rootProcess(pane)
      expect(typeof again === 'number' && again !== root && running(again)).toBe(true)
      expect(await backend.paneState(pane)).toMatchObject({ dead: false })
      expect((await backend.kill(pane)).state).toBe('succeeded')
    } finally {
      backend.dispose()
      const pid = listDiscoveries(home).findLast((found) => found.protocol === PTY_PROTOCOL)?.pid
      if (pid) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
      await removeTree(home).catch(() => {})
    }
  }, CASE_TIMEOUT_MS)
})
