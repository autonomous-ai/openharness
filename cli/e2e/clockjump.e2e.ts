/**
 * The wall clock jumping while agents work, for Claude Code and Codex. A laptop closed mid-turn sleeps
 * with every process on it, and wakes with the wall clock hours ahead while the monotonic clocks (on
 * macOS) never counted the sleep; an NTP correction, a virtual machine resumed or a time zone synced
 * after travel moves it back. Every Node process here runs with `Date` shifted from a file
 * (harness/clockShift.mjs): the daemon, and the engines through the person's shell. A turn in flight
 * must still read as working, end once, and every agent must go on working, in order.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}
async function said(client: LocalClient, sessionId: string): Promise<string[]> {
  const page = await client.request('session_get', { sessionId, limit: 50 }, 60_000)
  expect(page.error, JSON.stringify(page)).toBeUndefined()
  return (page.events as Row[]).filter((event) => event.type === 'user_message').map((event) => String(event.payload.content))
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const SHIM = resolve(CLI_ROOT, 'e2e/harness/clockShift.mjs')

describe('the wall clock jumping while agents work', () => {
  let daemon: IsolatedDaemon | undefined
  let scratch: string | undefined
  const paused: number[] = []
  afterEach(async () => {
    for (const pid of paused.splice(0)) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
    await daemon?.close(); daemon = undefined
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it.each([
    ['forward three hours, as a laptop closed mid-turn wakes', 3 * 3_600_000],
    ['back an hour, as an NTP correction does', -3_600_000],
  ] as const)('%s: the turn in flight reads as working, ends once, and every agent goes on', async (_what, jump) => {
    scratch = mkdtempSync(join(tmpdir(), 'clock-'))
    const shiftFile = join(scratch, 'shift')
    writeFileSync(shiftFile, '0')
    const clock = { NODE_OPTIONS: `--import ${SHIM}`, E2E_CLOCK_SHIFT_FILE: shiftFile }
    const d = await IsolatedDaemon.create({ env: clock })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    // The engines run through the person's shell: the same clock reaches them there.
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export NODE_OPTIONS=${JSON.stringify(clock.NODE_OPTIONS)} E2E_CLOCK_SHIFT_FILE=${JSON.stringify(shiftFile)}\n`)
    await d.start()
    const client = await LocalClient.connect(d)
    const claude = await create(d, client, 'claude', 'clock-claude')
    const codex = await create(d, client, 'codex', 'clock-codex')
    await turn(client, claude.id, 'before the jump (claude)')
    await turn(client, codex.id, 'before the jump (codex)')

    // A long turn in flight when everything stops.
    const from = client.frames.length
    client.send('message', { agentId: claude.id, content: '!slow 12000' })
    await client.next(isTurn('turn_started', claude.id), 30_000, 'the long turn to start')
    // The daemon is paused, not the panes: tmux resumes a stopped pane's shell at once, and an
    // interactive shell whose engine stays stopped ends and takes it with it. A real sleep stops
    // everything together; what is under test is the daemon waking to a moved clock.
    const everything = [d.pid!, d.corePid()!]
    // A short-lived child seen in the snapshot may be gone by now.
    for (const pid of everything) { try { process.kill(pid, 'SIGSTOP'); paused.push(pid) } catch { /* gone */ } }
    await sleep(3_000)
    writeFileSync(shiftFile, String(jump))
    for (const pid of paused.splice(0)) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }

    await sleep(2_000)
    if (process.env.CLOCK_PROBE) {
      const { appendFileSync } = await import('node:fs')
      appendFileSync(process.env.CLOCK_PROBE, `--- jump ${jump}\n${JSON.stringify(await row(client, claude.id))}\n`)
    }
    expect((await row(client, claude.id))?.activity?.state, 'the turn in flight still reads as working').toBe('working')
    await client.waitFor((frame) => isTurn('turn_ended', claude.id)(frame) && client.frames.indexOf(frame) >= from, 45_000, 'the long turn to end')
    await sleep(3_000)
    expect(client.frames.slice(from).filter(isTurn('turn_ended', claude.id))).toHaveLength(1)
    expect((await row(client, claude.id))?.activity?.state).not.toBe('working')

    await turn(client, claude.id, 'after the jump (claude)')
    await turn(client, codex.id, 'after the jump (codex)')
    expect(await said(client, claude.sessionId)).toEqual(['before the jump (claude)', '!slow 12000', 'after the jump (claude)'])
    expect(await said(client, codex.sessionId)).toEqual(['before the jump (codex)', 'after the jump (codex)'])
    for (const agent of [claude, codex]) expect((await row(client, agent.id))?.status).toBe('active')
    expect(d.coresStarted()).toBe(1)
    client.close()
  }, 240_000)
})
