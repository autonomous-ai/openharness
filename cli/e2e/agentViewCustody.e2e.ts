/** A real core's viewer lifecycle and reconnect replies must not hand its saved launch key to a service. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, onTestFailed } from 'vitest'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from '../src/services/process.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

it('keeps grid launch custody in the real core while a viewer attaches, reads frames and reconnects', async () => {
  const token = 'isolated-agent-view-service-token'
  // The test supplies only the viewers peer; Store and models remain inline. No real account is involved.
  const daemon = await IsolatedDaemon.create({ noMaster: true, env: {
    HARNESS_NO_MASTER: '1', HARNESSD_SUPERVISED: '1', HARNESSD_SERVICE_TOKEN: token,
    HARNESSD_SERVICE_PROCESSES: 'viewers', HARNESSD_SERVICES: 'viewers',
  } })
  let client: LocalClient | undefined, viewer: ServiceProcess | undefined
  let connected: CoreConnection | undefined
  let followed = false
  const events: Record<string, unknown>[] = []
  const attach = () => runServiceProcess({ name: 'viewers', socketPath: daemon.socketPath, machineId: daemon.computerId,
    token, requests: {}, onConnected: core => {
      connected = core
      void core.query('follow_agents', { each: true, having: ['dsh'] }).then(snapshot => {
        events.push({ kind: 'catch-up', ...snapshot }); followed = true
      })
    }, onDisconnected: () => { connected = undefined; followed = false },
    onEvent: event => { events.push(event) },
  })
  onTestFailed(() => console.log(`---- daemon log\n${daemon.log()}`))
  try {
    const id = 'e2e/custody', dir = join(daemon.env.DSH_DIR!, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id, name: 'Custody', engine: 'claude' }))
    writeFileSync(join(daemon.env.DSH_DIR!, 'installed.json'), JSON.stringify([
      { id, dir, source: dir, ref: null, commit: null, linked: false, installedAt: Date.now() },
    ]))
    await daemon.start()
    const corePid = daemon.corePid()
    viewer = attach()
    await until('the test viewer peer to connect', () => connected ?? null, 30_000, 50)
    await until('the test viewer to follow agents', () => followed || null, 30_000, 50)
    client = await LocalClient.connect(daemon)
    const cwd = join(daemon.projectsDir, 'custody')
    mkdirSync(cwd, { recursive: true })
    const grid = { networkId: 'fixture-grid', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/relay',
      apiKey: 'synthetic-viewer-custody-canary', model: 'Fixture-Q4' }
    const created = await client.request('agent_create', { engine: 'claude', cwd, dsh: id, grid, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId = created.agent.id
    const attached = await until('the viewer running event', () => events.map(event => event.event as Record<string, unknown> | undefined)
      .find(event => event?.kind === 'running' && (event.session as { agentId?: string } | undefined)?.agentId === agentId) ?? null, 30_000, 50)
    expect(attached.session).toMatchObject({ agentId, dsh: id, grid: { baseUrl: grid.baseUrl } })
    expect(Object.hasOwn(attached.session!, 'gridLaunch')).toBe(false)
    expect(JSON.stringify(attached)).not.toContain(grid.apiKey)

    // The viewer's metadata becomes a public frame through main.ts's frame provider.
    const context = { id, name: 'Custody', viewerName: 'Fixture Viewer', viewerUrl: 'http://127.0.0.1:9/', verdict: null }
    expect(await connected!.query('context', { agentId, context, forwardingUrl: context.viewerUrl })).toEqual({ kept: true })
    const frame = await until('the public viewer frame', async () => {
      const reply = await client!.request('agents_list', {})
      return (reply.agents as Array<Record<string, unknown>>).find(row => row.id === agentId && row.sessionId
        && row.viewerName === context.viewerName) ?? null
    }, 30_000, 50)
    expect(frame.viewerUrl).toBe(context.viewerUrl)
    expect(JSON.stringify(frame)).not.toContain(grid.apiKey)

    await viewer.stop()
    connected = undefined
    followed = false
    viewer = attach()
    await until('the test viewer peer to reconnect', () => connected ?? null, 30_000, 50)
    await until('the test viewer catch-up after reconnect', () => followed || null, 30_000, 50)
    const catchUp = events.filter(event => event.kind === 'catch-up').at(-1)!
    expect(catchUp.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agentId, dsh: id })]))
    expect(JSON.stringify(catchUp)).not.toContain('gridLaunch')
    const snapshot = await connected!.query('agents', {})
    const rows = snapshot.agents as Array<Record<string, unknown>>
    expect(rows.some(row => row.agentId === agentId && row.dsh === id)).toBe(true)
    expect(rows.every(row => !Object.hasOwn(row, 'gridLaunch'))).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain(grid.apiKey)
    expect(daemon.corePid()).toBe(corePid)

    // A first turn completes the fixture's native conversation opening before Stop checks its identity.
    const ended = client.next(event => event.type === 'turn_ended' && event.agentId === agentId, 45_000, 'the custody fixture turn')
    client.send('message', { agentId, content: 'fixture custody verification' })
    await ended
    // Stop through the public command, then read only this fixture's saved record: Resume still has its key.
    const closed = await client.request('agent_close', { agentId, sessionId: frame.sessionId, createdAt: frame.createdAt, mode: 'now' }, 60_000)
    expect(closed.error, JSON.stringify(closed)).toBeUndefined()
    const saved = JSON.parse(readFileSync(join(daemon.dataDir, 'stopped-agents', `${agentId}.json`), 'utf8'))
    expect(saved.session.gridLaunch).toEqual(grid)
  } finally {
    await viewer?.stop()
    client?.close()
    await daemon.close()
  }
})
