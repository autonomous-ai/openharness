/**
 * A desk of agents working, for Claude Code and Codex, on the real daemon: two of each run turn after
 * turn together, and the core's memory and open files settle instead of growing with them. A leak per
 * turn shows here long before it shows on a machine that has been running for a week.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const exec = promisify(execFile)
const ROUNDS = Number(process.env.SOAK_ROUNDS ?? 40)

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 60_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
async function openFiles(pid: number | null): Promise<number> {
  if (!pid) return 0
  const { stdout } = await exec('lsof', ['-n', '-P', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  return stdout.trim().split('\n').length
}
/** The lowest of a few samples: what the process holds, not a moment's garbage before a collection. */
async function settledRss(daemon: IsolatedDaemon): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < 5; i++) { samples.push(await daemon.rssMiB()); await new Promise((resolve) => setTimeout(resolve, 1_000)) }
  return Math.min(...samples)
}

describe('a desk of agents working', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it(`four agents, ${ROUNDS} rounds of turns together: memory and open files settle`, async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const ids: string[] = []
    for (const [i, engine] of (['claude', 'codex', 'claude', 'codex'] as const).entries()) {
      const cwd = join(d.projectsDir, `desk-${i}`)
      mkdirSync(cwd, { recursive: true })
      const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      ids.push(created.agent.id)
    }
    for (const id of ids) await until(`${id.slice(0, 8)} to bind`, async () => (await row(client, id))?.sessionId || null, 60_000, 500)

    // Warm: pools, caches and the first transcripts reach their working size.
    for (let round = 0; round < 5; round++) await Promise.all(ids.map((id) => turn(client, id, `warm ${round}`)))
    const rssBefore = await settledRss(d)
    const filesBefore = await openFiles(d.corePid())

    for (let round = 0; round < ROUNDS; round++) {
      await Promise.all(ids.map((id) => turn(client, id, `round ${round} — ${'some words '.repeat(20)}`)))
      // The client keeps only what it still needs, so its own memory is not the one measured.
      client.frames.splice(0, client.frames.length)
    }
    const rssAfter = await settledRss(d)
    const filesAfter = await openFiles(d.corePid())
    const report = `rss ${rssBefore.toFixed(1)} → ${rssAfter.toFixed(1)} MiB · open files ${filesBefore} → ${filesAfter} · ${ROUNDS * ids.length} turns`
    if (process.env.SOAK_REPORT) writeFileSync(process.env.SOAK_REPORT, `${report}\n`)
    expect(rssAfter - rssBefore, report).toBeLessThan(96)
    expect(filesAfter - filesBefore, report).toBeLessThan(16)
    expect(d.coresStarted()).toBe(1)
    client.close()
  // A round takes a second or two; the suite's own limit fits only the default 40.
  }, 120_000 + ROUNDS * 3_000)
})
