/**
 * A stop ends every process its engine started. OpenClaw spawns its tools `detached` on POSIX: each leaves the engine's
 * process group and session, so the engine's own SIGTERM and the pane's hangup never reach it, and a tool kept running
 * after its harness closed (#4173). The table is read once, before any signal: once the engine dies its children
 * re-parent away and nothing links them to it.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'
import { checkPidRuntime, terminateDeletedAgent } from './deleteAgentFallback.js'
import { engineDescendants, TREE_LIMIT, treeSurvivors, treeTargets, type TreeProcess } from './processTree.js'
import { processRows, type ProcessRow } from './processTable.js'
import type { RegisteredSession } from './registry.js'
import type { ProcessIdentity } from './terminalTypes.js'
import { processIdentityOf } from './terminalRuntime.js'

const ENGINE = { pid: 500, executable: 'claude', startMarker: 'Thu Nov 12 10:00:01 2026' }
/** `ps -axo pid=,ppid=,pgid=,lstart=,args=`: the pane's shell, the engine, a tool in the engine's group, a grandchild
 *  that left its session, Hermes' gateway with a hook it runs, and another program in the same pane. */
const PS = [
  '    1     0     1 Mon Nov  9 08:00:00 2026 /sbin/launchd',
  '  499     1   499 Thu Nov 12 10:00:00 2026 -zsh',
  '  500   499   500 Thu Nov 12 10:00:01 2026 claude --resume abc',
  '  501   500   500 Thu Nov 12 10:00:02 2026 /bin/bash -c npm test',
  '  502   501   502 Thu Nov 12 10:00:03 2026 sleep 600',
  '  503   500   503 Thu Nov 12 10:00:04 2026 python3 -m hermes_cli.main gateway run --quiet --idle-exit',
  '  504   503   503 Thu Nov 12 10:00:05 2026 /bin/sh -c hook',
  '  600   499   600 Thu Nov 12 10:00:06 2026 vim notes.md',
  '',
].join('\n')

const tree: TreeProcess[] = [
  { pid: 10, pgid: 4242, startMarker: 'm10' }, // in the engine's own group
  { pid: 20, pgid: 20, startMarker: 'm20' }, // left the session: leads its own group
  { pid: 21, pgid: 20, startMarker: 'm21' },
  { pid: 30, pgid: 77, startMarker: 'm30' }, // in a group led from outside the tree (the pane's shell)
]

describe('an engine\'s process tree', () => {
  it('signals a group only when one of the tree leads it', () => {
    expect(treeTargets(tree)).toEqual({ groups: [20], pids: [10, 30] })
  })

  it('walks down from the engine in one read, and leaves out a Hermes gateway and what it started', async () => {
    let reads = 0
    const found = await engineDescendants(ENGINE, 'darwin', async () => { reads++; return PS })
    expect(found!.map((p) => p.pid)).toEqual([501, 502])
    expect(found![1]).toEqual({ pid: 502, pgid: 502, startMarker: 'Thu Nov 12 10:00:03 2026' })
    expect(reads).toBe(1)
  })

  it('lists nothing on Windows, nothing for an engine that is not there, and null when the table cannot be read', async () => {
    expect(await engineDescendants(ENGINE, 'win32', async () => { throw new Error('never read') })).toEqual([])
    expect(await engineDescendants({ ...ENGINE, startMarker: 'another start' }, 'darwin', async () => PS)).toEqual([])
    expect(await engineDescendants(ENGINE, 'darwin', async () => null)).toBeNull()
    // `ps` lists itself at the least: a table with nobody in it is a read that failed.
    expect(await engineDescendants(ENGINE, 'darwin', async () => '')).toBeNull()
  })

  it('stops at 1024 processes', async () => {
    const children = Array.from({ length: 2000 }, (_, at) => `${1000 + at}   500   500 Thu Nov 12 10:00:02 2026 node tool.js`)
    const found = await engineDescendants(ENGINE, 'darwin', async () => `${PS}${children.join('\n')}\n`)
    expect(found).toHaveLength(TREE_LIMIT)
  })

  it('a survivor still runs with the same pid and start; a reused pid and a zombie are gone', async () => {
    const members = [
      { pid: 502, pgid: 502, startMarker: 'Thu Nov 12 10:00:03 2026' },
      { pid: 600, pgid: 600, startMarker: 'Thu Nov 12 09:00:00 2026' },
      // Above any pid Linux hands out, so no /proc entry makes it look running there.
      { pid: 9_999_999, pgid: 9_999_999, startMarker: 'Thu Nov 12 10:00:07 2026' },
    ]
    const zombie = '9999999   500 9999999 Thu Nov 12 10:00:07 2026 <defunct>\n'
    expect(await treeSurvivors(members, async () => PS + zombie)).toEqual([members[0]])
    expect(await treeSurvivors(members, async () => null)).toBeNull()
  })
})

/** A node "engine" that starts `sleep` detached (its own session and group), prints that pid, and waits. */
const ENGINE_SCRIPT = `
const child = require('node:child_process').spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
console.log(child.pid)
setInterval(() => {}, 1000)
`

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The process's row in the table, as the daemon saves an engine's identity. */
async function identityOf(pid: number): Promise<ProcessIdentity> {
  let row: ProcessRow | undefined
  await until(async () => !!(row = (await processRows())?.find((candidate) => candidate.pid === pid)))
  return processIdentityOf(row!)
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

describe.skipIf(process.platform === 'win32')('real processes', () => {
  it('a child that left the engine\'s session is gone after the stop', async () => {
    const engine = spawn(process.execPath, ['-e', ENGINE_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] })
    let listed: TreeProcess[] | null = null
    try {
      const [line] = await once(createInterface({ input: engine.stdout! }), 'line') as [string]
      const child = Number(line)
      const identity = await identityOf(engine.pid!)
      listed = await engineDescendants(identity)
      expect(listed!.find((p) => p.pid === child)!.pgid).toBe(child)
      const outcome = await terminateDeletedAgent({ engine: 'claude', processIdentity: identity } as RegisteredSession, {
        checkRuntime: checkPidRuntime, kill: (pid, signal) => process.kill(pid, signal), log: () => {},
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        descendants: () => engineDescendants(identity), survivors: treeSurvivors })
      expect(['terminated', 'killed']).toContain(outcome)
      await until(() => !alive(child))
    } finally {
      // Only what this test started, and only while it is still that process.
      engine.kill('SIGKILL')
      for (const left of listed ? await treeSurvivors(listed) ?? [] : []) process.kill(left.pid, 'SIGKILL')
    }
  })
})
