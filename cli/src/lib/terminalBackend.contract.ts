import { rmSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

/** An interactive shell on this platform. */
export const SHELL = process.platform === 'win32' ? ['powershell.exe', '-NoLogo', '-NoProfile'] : ['/bin/sh']
/** How long a shell has to show what a case waits for. PowerShell in a fresh console can take seconds to start. */
export const WAIT_MS = process.platform === 'win32' ? 15_000 : 5_000
/** Each case's own limit: a backend that hangs fails that case, not the run. */
const CASE_TIMEOUT_MS = process.platform === 'win32' ? 40_000 : 15_000

/**
 * Remove [dir], trying again for a while: on Windows a directory cannot be removed while a process has it as its
 * working directory, and a killed host's panes (and their consoles) take a moment to end.
 */
export async function removeTree(dir: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (Date.now() > end) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * The acceptance suite every terminal backend must pass. It describes what the tmux backend does today.
 *
 * [make] readies the backend, and cleans up after itself when it cannot (an unready backend is a thrown error that
 * says why). Every pane a case makes is killed after it, whether it passed or not.
 */
export function runTerminalBackendContract(name: string, make: () => Promise<{ backend: TerminalBackend; cleanup(): Promise<void> }>): void {
  describe(`TerminalBackend contract: ${name}`, () => {
    let backend: TerminalBackend
    let cleanup: (() => Promise<void>) | undefined
    const made: TerminalRuntimeRef[] = []
    beforeAll(async () => { ({ backend, cleanup } = await make()) }, CASE_TIMEOUT_MS)
    afterEach(async () => {
      for (const runtime of made.splice(0)) await backend.kill(runtime).catch(() => {})
    }, CASE_TIMEOUT_MS)
    afterAll(async () => { await cleanup?.() }, CASE_TIMEOUT_MS)

    async function pane(): Promise<TerminalRuntimeRef> {
      const created = await backend.create({ command: SHELL, cwd: process.cwd() })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      made.push(created.runtime)
      return created.runtime
    }
    const text = async (r: TerminalRuntimeRef) => {
      const read = await backend.capture(r, { mode: 'recent_unwrapped', historyLines: 50, ansi: false })
      return read.state === 'succeeded' ? read.value : ''
    }

    it('creates a pane that inventory lists and kill removes', async () => {
      const r = await pane()
      const inv = await backend.inventory()
      expect(inv.state).toBe('available')
      if (inv.state === 'available') expect(inv.roots.some((root) => root.runtime.paneId === r.paneId)).toBe(true)
      expect((await backend.kill(r)).state).toBe('succeeded')
      expect(await until(() => backend.paneState(r), (s) => s === 'gone')).toBe('gone')
    }, CASE_TIMEOUT_MS)

    it('submitText reaches the program and capture shows it', async () => {
      const r = await pane()
      // The shell works the sum out, so the output is not the echo of what was typed: `$((40+2))` is arithmetic to
      // sh, and a subexpression around `(40+2)` to PowerShell.
      await backend.submitText(r, 'echo contract-$((40+2))')
      expect(await until(() => text(r), (t) => t.includes('contract-42'))).toContain('contract-42')
      await backend.kill(r)
    }, CASE_TIMEOUT_MS)

    it('paste unicode arrives intact', async () => {
      const r = await pane()
      const sample = 'Tiếng Việt 漢字 😀'
      await backend.submitText(r, `echo '${sample}'`)
      expect(await until(() => text(r), (t) => t.split('\n').some((l) => l.trim() === sample))).toContain(sample)
      await backend.kill(r)
    }, CASE_TIMEOUT_MS)

    it('holdOpen keeps a pane whose process exited, respawn reuses it, releaseHold lets it go', async () => {
      const r = await pane()
      expect((await backend.holdOpen!(r)).state).toBe('succeeded')
      await backend.submitText(r, 'exit')
      const held = await until(() => backend.paneState(r), (s) => typeof s === 'object' && s.dead)
      expect(held).toMatchObject({ dead: true })
      expect((await backend.respawn!(r, { command: SHELL })).state).toBe('succeeded')
      expect(await until(() => backend.paneState(r), (s) => typeof s === 'object' && !s.dead)).toMatchObject({ dead: false })
      await backend.releaseHold(r)
      await backend.submitText(r, 'exit')
      expect(await until(() => backend.paneState(r), (s) => s === 'gone')).toBe('gone')
    }, CASE_TIMEOUT_MS)

    it('rootProcess names a live pid and says missing for an unknown pane', async () => {
      const r = await pane()
      expect(typeof await backend.rootProcess(r)).toBe('number')
      await backend.kill(r)
      await until(() => backend.paneState(r), (s) => s === 'gone')
      expect(await backend.rootProcess(r)).toBe('missing')
    }, CASE_TIMEOUT_MS)

    it('stream: snapshot then live output, resize, close', async () => {
      const r = await pane()
      const chunks: Uint8Array[] = []
      const opened = await backend.openStream!(r, { engine: 'terminal' }, { cols: 100, rows: 30 }, {
        onData: (b) => chunks.push(b), onClose: () => {},
      })
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') return
      const stream = opened.value
      stream.beginSnapshot()
      const snap = await stream.snapshot()
      expect(snap.state).toBe('succeeded')
      stream.endSnapshot()
      await stream.writeRaw(new TextEncoder().encode('echo live-$((1+1))\r'))
      await until(async () => Buffer.concat(chunks).toString(), (t) => t.includes('live-2'))
      expect(Buffer.concat(chunks).toString()).toContain('live-2')
      expect((await stream.resize({ cols: 80, rows: 24 })).state).toBe('succeeded')
      await stream.close()
      await backend.kill(r)
    }, CASE_TIMEOUT_MS)
  })
}
