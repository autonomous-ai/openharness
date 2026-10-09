/** Aggregate reads never own readiness, turns or stopped work. Every process/file is a private fixture. */
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { LocalClient } from './harness/client.js'

let daemon: IsolatedDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })
const row = async (client: LocalClient, id: string) =>
  (await client.request('agents_list', { includeStopped: true }, 30_000)).agents.find((a: any) => a.id === id)
const turn = async (client: LocalClient, id: string, content: string) => {
  const ended = client.next(f => f.type === 'turn_ended' && f.agentId === id, 45_000, content)
  client.send('message', { agentId: id, content }); await ended
}
const fresh = async (mode = 'usage', hold = false) => {
  const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICES: mode,
    HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000' } })
  const gate = join(d.root, 'usage-connect-hold')
  d.env.HARNESSD_TEST_HOLD_CONNECT = `usage:${gate}`
  if (hold) writeFileSync(gate, '')
  onTestFailed(() => console.log(d.log().split('\n').slice(-150).join('\n')))
  await d.start()
  return { d, gate, client: await LocalClient.connect(d) }
}
const create = async (d: IsolatedDaemon, client: LocalClient, engine: 'claude' | 'codex') => {
  const cwd = join(d.projectsDir, engine); mkdirSync(cwd)
  const result = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 60_000)
  expect(result.error).toBeUndefined()
  return until(`${engine} bound`, async () => {
    const a = await row(client, result.agent.id)
    return a?.sessionId && a.status === 'active' ? a : null
  }, 60_000, 250)
}
const usage = async (d: IsolatedDaemon, agent: any, n = 1) => {
  const path = await until('private transcript path attached', () => {
    const registered = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((r: any) => r.agentId === agent.id)
    return typeof registered?.transcriptPath === 'string' ? registered.transcriptPath as string : null
  }, 30_000, 100)
  expect(typeof path).toBe('string')
  expect(relative(d.root, path).startsWith('..')).toBe(false)
  const timestamp = new Date().toISOString()
  const entry = agent.engine === 'claude'
    ? { type: 'assistant', timestamp, sessionId: agent.sessionId, message: { id: `usage-${n}`, role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 20 } } }
    : { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 * n, output_tokens: 20 * n, cached_input_tokens: 0 } } } }
  appendFileSync(path, JSON.stringify(entry) + '\n')
}
const totals = async (client: LocalClient, id: string, expected: number) => until(`usage ${expected}`, async () =>
  (await row(client, id))?.tokenUsage?.totalTokens === expected || null, 45_000, 250)
const edge = (d: IsolatedDaemon) => Number([...d.log().matchAll(/\[harnessd\] service edge started \(pid (\d+)\)/g)].at(-1)![1])

it('usage unavailable at boot never delays readiness or binding; recovery updates both engines and stopped work', async () => {
  const { d, gate, client } = await fresh('usage', true)
  const agents = [await create(d, client, 'claude'), await create(d, client, 'codex')]
  for (const a of agents) {
    await usage(d, a); await turn(client, a.id, 'usage can wait')
    expect((await row(client, a.id)).tokenUsage).toBeNull()
  }
  expect(d.coresStarted()).toBe(1)
  unlinkSync(gate)
  for (const a of agents) await totals(client, a.id, 120)
  writeFileSync(gate, '')
  process.kill(edge(d), 'SIGKILL')
  await until('usage disconnected', () => d.log().includes('[services] usage disconnected') || null, 20_000, 200)
  for (const a of agents) {
    await usage(d, a, 2); await turn(client, a.id, 'usage is gone again')
    expect((await row(client, a.id)).tokenUsage?.totalTokens).toBe(120)
    const stopped = await client.request('agent_delete', { agentId: a.id }, 30_000)
    expect(stopped.error).toBeUndefined()
    expect((await row(client, a.id)).status).toBe('stopped')
  }
  unlinkSync(gate)
  for (const a of agents) {
    await totals(client, a.id, 240)
    expect((await row(client, a.id)).status).toBe('stopped')
  }
  expect(d.coresStarted()).toBe(1)
  client.close()
})

it('a new core receives an unchanged warm worker snapshot', async () => {
  const { d, client } = await fresh()
  const a = await create(d, client, 'claude')
  await usage(d, a); await totals(client, a.id, 120)
  const worker = edge(d), before = d.corePid()!
  const ready = [...d.log().matchAll(/\[cli\] ready/g)].length
  client.close(); process.kill(before, 'SIGKILL')
  await until('new core', () => d.corePid() !== before && d.coresStarted() >= 2 || null, 30_000, 250)
  await until('new core ready', () => [...d.log().matchAll(/\[cli\] ready/g)].length > ready || null, 60_000, 250)
  const next = await LocalClient.connect(d)
  await totals(next, a.id, 120)
  expect(edge(d)).toBe(worker)
  await turn(next, a.id, 'after core restart')
  next.close()
})

it('explicit inline usage follows the same aggregate boundary', async () => {
  const { d, client } = await fresh('none')
  const a = await create(d, client, 'codex')
  await usage(d, a); await totals(client, a.id, 120)
  await turn(client, a.id, 'inline remains usable')
  expect(d.coresStarted()).toBe(1)
  client.close()
})
