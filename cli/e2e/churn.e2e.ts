/**
 * Agents made and closed all day, for Claude Code and Codex, on the real daemon. A person opens an
 * agent, gives it a task and closes it, again and again, on a daemon that runs for weeks. Whatever the
 * daemon keeps per agent (watchers, caches, timers, maps, open files, panes) must leave with the agent:
 * memory and open files settle, no pane or engine is left behind, and the live list ends empty.
 * `CHURN_ROUNDS` scales it (the suite runs a few; a hundred is a better soak).
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>
const exec = promisify(execFile)
const ROUNDS = Number(process.env.CHURN_ROUNDS ?? 10)

const rows = async (client: LocalClient, includeStopped = true): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 250)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
async function close(client: LocalClient, agentId: string): Promise<void> {
  const now = (await row(client, agentId))!
  const answer = await client.request('agent_close', { agentId, sessionId: now.sessionId, createdAt: now.createdAt, mode: 'now' }, 60_000)
  expect(answer, JSON.stringify(answer)).toMatchObject({ closed: true })
}
async function openFiles(pid: number | null): Promise<number> {
  if (!pid) return 0
  const { stdout } = await exec('lsof', ['-n', '-P', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  return stdout.trim().split('\n').length
}
/** The lowest of a few samples: what the core holds, not a moment's garbage before a collection. */
async function settledRss(daemon: IsolatedDaemon): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < 5; i++) { samples.push(await daemon.rssMiB()); await new Promise((resolve) => setTimeout(resolve, 1_000)) }
  return Math.min(...samples)
}
/** The fake engines running for this daemon: an engine-titled process under one of its launch shells. */
function engines(d: IsolatedDaemon): number {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() }))
  const launchers = new Set(table.filter((p) => p.command.includes(join(d.root, 'bin'))).map((p) => p.pid))
  return table.filter((p) => /^(claude|codex)(?:\s|$)/.test(p.command) && launchers.has(p.ppid)).length
}
const panes = async (d: IsolatedDaemon): Promise<number> =>
  (await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}').catch(() => '')).split('\n').filter(Boolean).length

describe('agents made and closed all day', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it(`${ROUNDS} rounds of a Claude Code and a Codex agent made, given a task and closed: nothing builds up`, async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    let n = 0
    const round = async (): Promise<void> => {
      const made = [await create(d, client, 'claude', `churn-${n}-claude`), await create(d, client, 'codex', `churn-${n}-codex`)]
      n++
      await Promise.all(made.map((agent) => turn(client, agent.id, `task ${n} for ${agent.engine}`)))
      for (const agent of made) await close(client, agent.id)
      // The client keeps only what it still needs, so its own memory is not the one measured.
      client.frames.splice(0, client.frames.length)
    }
    // Warm: pools, caches and the first transcripts reach their working size.
    for (let i = 0; i < 3; i++) await round()
    await until('the warm-up\'s panes and engines to be gone', async () => (await panes(d)) === 0 && engines(d) === 0 || null, 30_000, 500)
    const rssBefore = await settledRss(d)
    const filesBefore = await openFiles(d.corePid())

    for (let i = 0; i < ROUNDS; i++) await round()

    await until('every closed agent\'s pane and engine to be gone', async () => (await panes(d)) === 0 && engines(d) === 0 || null, 30_000, 500)
    const rssAfter = await settledRss(d)
    const filesAfter = await openFiles(d.corePid())
    const live = (await rows(client, false)).filter((agent) => agent.status === 'active')
    const report = `rss ${rssBefore.toFixed(1)} → ${rssAfter.toFixed(1)} MiB · open files ${filesBefore} → ${filesAfter} · ${(ROUNDS + 3) * 2} agents made and closed · ${live.length} left live`
    if (process.env.CHURN_REPORT) writeFileSync(process.env.CHURN_REPORT, `${report}\n`)
    expect(live, report).toEqual([])
    expect(rssAfter - rssBefore, report).toBeLessThan(96)
    expect(filesAfter - filesBefore, report).toBeLessThan(16)
    expect(d.coresStarted()).toBe(1)
    client.close()
  // A round takes several seconds: two binds, two turns and two closes.
  }, 180_000 + ROUNDS * 20_000)
})
