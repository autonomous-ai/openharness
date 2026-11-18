/**
 * A full disk, for Claude Code and Codex: the daemon's data folder runs out of space while agents are
 * at work, as a disk filled by logs did on 2026-10-04. The core must keep serving the agents it has,
 * must refuse by name what must be written down first (a rename, a new agent), must not restart over
 * it, and once space is back must write again: what it is told after that survives a restart.
 *
 * The data folder lives on a small disk image of its own (macOS `hdiutil`, mounted where only this
 * test sees it), so nothing else on the machine runs short. Opt-in, because it mounts a volume:
 * `DISKFULL=1 npm run test:e2e -- diskfull`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { fillVolume } from './harness/fullDisk.js'

const ON = process.env.DISKFULL === '1' && process.platform === 'darwin'

type Row = Record<string, any>
const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

describe.skipIf(!ON)('a full disk', () => {
  let scratch = ''
  let volume = ''
  let daemon: IsolatedDaemon | undefined

  beforeAll(() => {
    // Short names: the daemon's socket lives in the data folder, and a Unix socket's path has a
    // 104-byte limit on macOS that a long temporary folder alone nearly uses up.
    scratch = mkdtempSync(join(tmpdir(), 'hd-'))
    volume = join(scratch, 'v')
    mkdirSync(volume)
    const image = join(scratch, 'data.dmg')
    execFileSync('hdiutil', ['create', '-size', '64m', '-fs', 'HFS+', '-volname', 'hdtest', '-type', 'UDIF', image], { stdio: 'pipe' })
    execFileSync('hdiutil', ['attach', image, '-mountpoint', volume, '-nobrowse', '-noverify', '-noautoopen'], { stdio: 'pipe' })
  }, 120_000)

  afterEach(async () => {
    // A failed assertion must not leave this test's filler behind for the next case.
    if (volume) {
      rmSync(join(volume, 'filler'), { force: true }); rmSync(join(volume, 'filler-tail'), { force: true })
    }
    await daemon?.close(); daemon = undefined
  })

  afterAll(() => {
    if (volume) { try { execFileSync('hdiutil', ['detach', volume, '-force'], { stdio: 'pipe' }) } catch { /* already gone */ } }
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('agents keep working while the data folder is full, a rename and a create are refused by name, and once there is room again a rename holds', async () => {
    const data = join(volume, 'd')
    mkdirSync(data, { recursive: true })
    const d = await IsolatedDaemon.create({ dataDir: data })
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      // The runner swallows console output: DISKFULL_LOG=<file> keeps the daemon's whole log for reading.
      if (process.env.DISKFULL_LOG) writeFileSync(process.env.DISKFULL_LOG, d.log())
    })
    await d.start()
    let client = await LocalClient.connect(d)
    const agents: Row[] = []
    for (const engine of ['claude', 'codex'] as const) {
      const cwd = join(d.projectsDir, `full-${engine}`)
      mkdirSync(cwd, { recursive: true })
      const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      agents.push(await until(`${engine} to bind`, async () => {
        const now = await row(client, created.agent.id)
        return now?.sessionId && now.status === 'active' ? now : null
      }, 60_000, 500))
    }
    for (const agent of agents) await turn(client, agent.id, `before the disk filled (${agent.engine})`)

    // The disk fills.
    const filler = fillVolume(volume)
    // The agents it has keep working: their turns, their rows.
    for (const agent of agents) await turn(client, agent.id, `while the disk is full (${agent.engine})`)
    // A rename is a choice that must be written down before it is answered: refused, and nothing is renamed.
    const refusedName = await client.request('agent_update', { agentId: agents[0].id, name: 'Named while full' }, 30_000)
    if (process.env.DISKFULL_REPORT) writeFileSync(process.env.DISKFULL_REPORT, `rename while full: ${JSON.stringify(refusedName.error ?? refusedName.agent?.name)}\n`)
    expect(refusedName.error, JSON.stringify(refusedName)).toBe('PERSISTENCE_UNCONFIRMED')
    expect((await row(client, agents[0].id))?.name).toBe(agents[0].name)
    // A new agent's binding must be saved before it is acknowledged: refused, naming the disk, its one pane closed.
    const cwd = join(d.projectsDir, 'made-while-full')
    mkdirSync(cwd, { recursive: true })
    const panes = async () => (await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}')).split('\n').filter(Boolean).length
    const panesBefore = await panes()
    const made = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(made.error, JSON.stringify(made)).toBe('PERSISTENCE_UNCONFIRMED')
    expect(String(made.detail)).toContain('ENOSPC')
    await until('the refused create\'s pane to be closed', async () => await panes() === panesBefore || null, 15_000, 200)
    expect((await rows(client)).map((agent) => agent.id).sort()).toEqual(agents.map((agent) => agent.id).sort())
    expect(d.log()).not.toContain('could not be registered after')
    for (const agent of agents) await turn(client, agent.id, `after a create was refused (${agent.engine})`)
    expect(d.coresStarted()).toBe(1)

    // Space comes back: a rename is written down, and survives a restart.
    rmSync(filler, { force: true })
    rmSync(join(volume, 'filler-tail'), { force: true })
    const renamed = await client.request('agent_update', { agentId: agents[0].id, name: 'Named once there is room' }, 30_000)
    expect(renamed.error, JSON.stringify(renamed)).toBeUndefined()
    expect(renamed.agent?.name).toBe('Named once there is room')
    await until('the full disk\'s holds to clear', async () => (await rows(client)).every((agent) => !agent.identityHold) || null, 60_000, 500)
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    const after = await until('both agents back after the restart', async () => {
      const now = await rows(client)
      return agents.every((agent) => now.some((one) => one.id === agent.id && one.status === 'active')) ? now : null
    }, 90_000, 500)
    expect(after.find((one) => one.id === agents[0].id)?.name).toBe('Named once there is room')
    for (const agent of agents) await turn(client, agent.id, `after the space came back (${agent.engine})`)
    expect(d.log()).not.toContain('unhandledRejection')
    if (process.env.DISKFULL_LOG) writeFileSync(process.env.DISKFULL_LOG, d.log())
    client.close()
  }, 600_000)

  it('the first turn on a data folder that never ran a project ends, though the disk is full', async () => {
    // A turn's end asks the orchestrator whether its agent is a specialist, and reading makes the
    // orchestrator's folder: on a full disk the mkdir threw out of the transcript's line handler, and the
    // turn never ended for the windows (found by e2e/updateHostile.e2e.ts, round 40). The turn's end no
    // longer depends on it (core/turns/recaps.ts); the orchestrator itself is left as it is for now.
    const data = join(volume, 'd2')
    mkdirSync(data, { recursive: true })
    const d = await IsolatedDaemon.create({ dataDir: data })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'first-turn-full')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the agent to bind', async () => {
      const now = await row(client, created.agent.id)
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500)
    expect(existsSync(join(data, 'orchestrator')), 'no turn has asked the orchestrator yet').toBe(false)
    const filler = fillVolume(volume)
    try {
      await turn(client, agent.id, 'the first turn, on a full disk')
      expect(d.log()).not.toContain('line handler error')
    } finally {
      rmSync(filler, { force: true })
      rmSync(join(volume, 'filler-tail'), { force: true })
    }
    expect(d.coresStarted()).toBe(1)
    client.close()
  }, 300_000)
})
