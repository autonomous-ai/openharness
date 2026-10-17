// TerminateProcess ends the one process: its child lives on. Windows only. Build the host first:
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/terminate.real.spec.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { processExists } from '../processLiveness.js'
import { windowsProcessRows } from './processTable.js'
import { terminateVerified } from './terminate.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN

/** The first line [child] prints, or a rejection when it exits first or says nothing within [ms]: never a wait for ever. */
function firstLine(child: ChildProcess, ms = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no line from pid ${child.pid} within ${ms} ms`)), ms)
    child.stdout!.once('data', (chunk) => { clearTimeout(timer); resolve(String(chunk).trim()) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`pid ${child.pid} exited (code ${code}) before it printed`)) })
  })
}

describe.skipIf(!enabled)('TerminateProcess on Windows', () => {
  it('ends the process it identified and never its child: the pty host outlives a core ended this way', async () => {
    // The child is detached, as the core starts the pty host (lib/ptyHost/launch.ts): Node puts every other child in
    // a job object that ends it with its parent (libuv's kill-on-close job), which is not TerminateProcess's doing.
    const parent = spawn(process.execPath, ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true })
      console.log(child.pid)
      setTimeout(() => {}, 60000)
    `], { stdio: ['ignore', 'pipe', 'ignore'] })
    let childPid: number | undefined
    try {
      // Inside the try: a parent that never prints still ends in the finally below.
      childPid = Number(await firstLine(parent))
      const rows = await windowsProcessRows(null)
      const marker = rows!.find((row) => row.pid === parent.pid)!.startMarker
      await expect(terminateVerified(parent.pid!, 'w:1')).resolves.toBe('mismatch')
      await expect(terminateVerified(parent.pid!, marker)).resolves.toBe('ended')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(processExists(parent.pid!)).toBe(false)
      expect(processExists(childPid)).toBe(true)
      await expect(terminateVerified(parent.pid!, marker)).resolves.toBe('gone')
    } finally {
      try { if (childPid) process.kill(childPid) } catch { /* gone */ }
      parent.kill()
    }
  }, 30_000)
})
