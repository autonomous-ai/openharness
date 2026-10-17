// TerminateProcess ends the one process: its child lives on. Windows only. Build the host first:
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/terminate.real.spec.ts
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { processExists } from '../processLiveness.js'
import { windowsProcessRows } from './processTable.js'
import { terminateVerified } from './terminate.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN

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
      childPid = Number(await new Promise<string>((resolve) => parent.stdout!.once('data', (chunk) => resolve(String(chunk).trim()))))
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
