/** Restart keeps the pane's identity; legacy default-profile archives hand their views to its live owner. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

it('keeps a named Codex harness through restart and hides an archive of its explicit default profile', async () => {
  const d = await IsolatedDaemon.create()
  daemon = d
  onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
  await d.start()
  const client = await LocalClient.connect(d)
  const cwd = join(d.projectsDir, 'builder-3')
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'codex', cwd, name: 'Builder 3', bypassPermission: true }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const id = created.agent.id
  const rows = async () => (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })).agents
  const before = await until('Builder 3 to bind', async () => (await rows()).find(a => a.id === id && a.sessionId && a.status === 'active') || null, 45_000, 250)
  const restarted = await client.request('agent_restart', { agentId: id }, 90_000)
  expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
  expect(restarted.agent).toMatchObject({ id, name: 'Builder 3', sessionId: before.sessionId, tmuxPane: before.tmuxPane })
  expect((await client.request('agent_resume', { agentId: id }, 60_000)).error).toBeUndefined()
  expect((await rows()).filter(a => a.sessionId === before.sessionId)).toHaveLength(1)

  // The observed incident: the old archive named ~/.codex explicitly; the replacement used the default.
  // Seed only the disposable daemon's archive, using its real registered row and private engine home.
  const live = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((a: Record<string, any>) => a.agentId === id)
  expect(live).toBeDefined()
  const staleId = 'old-builder-3'
  const archive = join(d.dataDir, 'stopped-agents')
  mkdirSync(archive, { recursive: true, mode: 0o700 })
  writeFileSync(join(archive, `${staleId}.json`), JSON.stringify({ version: 1,
    session: { ...live, agentId: staleId, active: false, codexHome: live.codexHome ? null : d.engineConfig.codexHome },
  }), { mode: 0o600 })
  expect((await rows()).filter(a => a.sessionId === before.sessionId).map(a => a.id)).toEqual([id])
  await d.restart()
  client.close()
  const again = await LocalClient.connect(d)
  await until('the stale profile archive to be set aside for the running owner', async () =>
    existsSync(join(archive, 'superseded', `${staleId}.json`)) || null, 45_000, 250)
  const back = await again.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })
  expect(back.agents.filter(a => a.sessionId === before.sessionId).map(a => a.id)).toEqual([id])
  const ended = again.next(f => f.type === 'turn_ended' && f.agentId === id, 30_000, 'Builder 3 next turn')
  again.send('message', { agentId: id, content: 'continue after reopening the same conversation' })
  await ended
  again.close()
})
