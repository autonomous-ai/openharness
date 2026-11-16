/**
 * A Codex resume whose rollout must be repaired, on the real daemon: 200 MB with a relay's reasoning item, made
 * resumable a chunk at a time while the core goes on (engines/kit/resumeRepair.ts). Read in line, the repair held the
 * core's loop 2.4 s, and every request and terminal waited behind it.
 *
 * The core's loop is measured in its own process (harness/corePerf.cjs). The conversation must come back whole:
 * repaired, its original kept as a backup, and nothing of it replayed as new turns.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { appendCodexHistory } from '../src/testing/codexRollout.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Row = Record<string, any>

const row = async (client: LocalClient, agentId: string): Promise<Row | undefined> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents.find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

/** The rollout of [sessionId] under a Codex home. */
function rolloutOf(home: string, sessionId: string): string | null {
  const walk = (folder: string): string[] => {
    let entries
    try { entries = readdirSync(folder, { withFileTypes: true }) } catch { return [] }
    return entries.flatMap((entry) => entry.isDirectory() ? walk(join(folder, entry.name))
      : entry.name.endsWith(`${sessionId}.jsonl`) ? [join(folder, entry.name)] : [])
  }
  return walk(join(home, 'sessions'))[0] ?? null
}

let daemon: IsolatedDaemon | undefined
let perf: string | undefined
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  if (perf) rmSync(perf, { recursive: true, force: true })
})

it('resumes a Codex agent whose 200 MB rollout needs a repair, and the core loop is never held for long', async () => {
  perf = mkdtempSync(join(tmpdir(), 'resume-perf-'))
  const token = randomBytes(24).toString('hex')
  const preload = fileURLToPath(new URL('./harness/corePerf.cjs', import.meta.url))
  const d = await IsolatedDaemon.create({ env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, HARNESS_E2E_PERF_DIR: perf, HARNESS_E2E_PERF_TOKEN: token } })
  daemon = d
  onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
  const cwd = join(d.projectsDir, 'long-conversation')
  mkdirSync(cwd, { recursive: true })
  await d.start()
  const client = await LocalClient.connect(d)
  const created = await client.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const bound = (what: string, sessionId?: string) => until(what, async () => {
    const now = await row(client, created.agent.id)
    return now?.sessionId && now.status === 'active' && (!sessionId || now.sessionId === sessionId) ? now : null
  }, 60_000, 500)
  const agent = await bound('the codex agent to bind')
  await turn(client, agent.id, 'before the stop')
  const stopped = await client.request('agent_delete', { agentId: agent.id }, 60_000)
  expect(stopped.error, JSON.stringify(stopped)).toBeUndefined()
  await until('the codex agent to stop', async () => (await row(client, agent.id))?.status === 'stopped' || null, 45_000, 500)

  // The conversation grows long, and a relay's reasoning item at its end must be repaired before Codex reads it again.
  const rollout = rolloutOf(d.env.CODEX_HOME!, agent.sessionId)
  expect(rollout).not.toBeNull()
  appendCodexHistory(rollout!, 200 * 1024 ** 2)

  // The core's own loop, measured in its process while the resume runs.
  const core = await until('the core\'s loop probe', () => readdirSync(perf!).find((name) => /^core-\d+\.json$/.test(name)), 30_000)
  const { port } = JSON.parse(readFileSync(join(perf, core), 'utf8')) as { port: number }
  const probe = async (command: 'start' | 'end') => (await fetch(`http://127.0.0.1:${port}/${command}`, {
    method: 'POST', headers: { 'x-harness-perf-token': token }, body: JSON.stringify({ label: 'resume' }),
  })).json() as Promise<Record<string, any>>
  await probe('start')
  const since = client.frames.length
  const resumed = await client.request('agent_resume', { agentId: agent.id }, 120_000)
  const measured = await probe('end')
  expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
  await bound('the codex agent back on its conversation', agent.sessionId)
  expect(d.log()).toContain('[resume] repaired 1 Codex reasoning items')
  // Its original kept beside it, and the relay's item without the id the next model call would refuse.
  expect(readdirSync(dirname(rollout!)).some((name) => name.includes('.reasoning-backup-'))).toBe(true)
  const last = readFileSync(rollout!, 'utf8').trimEnd().split('\n').filter((line) => line.includes('Prior summary.')).at(-1)!
  expect(JSON.parse(last).payload).toEqual({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Prior summary.' }], content: [] })
  // Read in line, the repair alone held it 2.3 s on a quiet Mac, 4.8 s at load 23. The repair's own chunks hold it a few
  // ms (core/agents/launch.loop.spec.ts); what is left of a resume's longest holds, 130 to 230 ms at load 20, is the
  // engine command lookup of discovery (lib/engineBin.ts) and the registry's save (lib/registry.ts).
  expect(measured.eventLoop.maxMs, JSON.stringify(measured.eventLoop)).toBeLessThan(1_000)

  await turn(client, agent.id, 'after the resume')
  // The tail moved to the repaired history's end before Codex wrote again: nothing of it came back as a new turn.
  const replayed = client.frames.slice(since).filter((frame) => isTurn('turn_started', agent.id)(frame) && frame.payload?.userMessage === 'before the stop')
  expect(replayed).toEqual([])
  client.close()
}, 300_000)
