// endProcessTree ends a process and what it started, leaves first, with TerminateProcess. Windows only. Build the host first:
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/treeKill.real.spec.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { processExists } from '../processLiveness.js'
import { windowsProcessRows } from './processTable.js'
import { endProcessTree, processTreeKillDeps } from './treeKill.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN

/** The first line [child] prints, or a rejection when it exits first or says nothing within [ms]: never a wait for ever. */
function firstLine(child: ChildProcess, ms = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no line from pid ${child.pid} within ${ms} ms`)), ms)
    child.stdout!.once('data', (chunk) => { clearTimeout(timer); resolve(String(chunk).trim()) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`pid ${child.pid} exited (code ${code}) before it printed`)) })
  })
}

describe.skipIf(!enabled)('endProcessTree on Windows', () => {
  it('ends a parent, its child and its grandchild, the furthest first, and nothing else', async () => {
    // node → cmd /c ping -t → ping. The cmd is detached, as the pty host is: a child Node starts otherwise sits in
    // libuv's kill-on-close job and would end with its parent whatever ended it (task-B3.21's terminate spec).
    const parent = spawn(process.execPath, ['-e', `
      const child = require('node:child_process').spawn('cmd.exe', ['/d', '/c', 'ping -t 127.0.0.1'], { stdio: 'ignore', detached: true, windowsHide: true })
      console.log(child.pid)
      setTimeout(() => {}, 60000)
    `], { stdio: ['ignore', 'pipe', 'ignore'] })
    // A bystander: started by this process, not under the parent, and must live on.
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    let cmdPid: number | undefined
    let pingPid: number | undefined
    try {
      cmdPid = Number(await firstLine(parent))
      for (let tries = 0; tries < 50 && pingPid === undefined; tries++) {
        const rows = await windowsProcessRows(null)
        pingPid = rows?.find((row) => row.parentPid === cmdPid && /ping\.exe$/i.test(row.executable))?.pid
        if (pingPid === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(pingPid).toBeDefined()
      const real = processTreeKillDeps(null)
      const killed: number[] = []
      const outcome = await endProcessTree(parent.pid!, { ...real, kill: (pid) => { killed.push(pid); real.kill(pid) } })
      expect(outcome).toBe('sent')
      // Every process ended before its parent: the ping, then the cmd, then the root, last.
      expect(killed.at(-1)).toBe(parent.pid)
      expect(killed.indexOf(pingPid!)).toBeGreaterThanOrEqual(0)
      expect(killed.indexOf(pingPid!)).toBeLessThan(killed.indexOf(cmdPid))
      expect(killed).not.toContain(bystander.pid)
      expect(killed).not.toContain(process.pid)
      await new Promise((resolve) => setTimeout(resolve, 500))
      for (const pid of [parent.pid!, cmdPid, pingPid!]) expect(processExists(pid), `pid ${pid}`).toBe(false)
      expect(processExists(bystander.pid!)).toBe(true)
      // Ended already: gone.
      await expect(endProcessTree(parent.pid!, real)).resolves.toBe('gone')
    } finally {
      for (const pid of [pingPid, cmdPid]) { try { if (pid) process.kill(pid) } catch { /* gone */ } }
      parent.kill()
      bystander.kill()
    }
  }, 30_000)
})
