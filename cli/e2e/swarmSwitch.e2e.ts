/**
 * The Swarm switch on the real daemon (harnessd/services.ts `HARNESS_SWARM`; Dee, v1's last item: the daemon core stays
 * small and reliable, and the Swarm is a subsystem that can be switched off). Off, the master never starts the Swarm's
 * process and the core loads none of its code (superTabs/inCore.ts), even on a computer that has the Swarm's saved state:
 * agents start, run and close exactly as without the Swarm, a Lead the Swarm keeps is no longer protected, a start that
 * asks for a Swarm role is refused, and the Swarm's requests are answered unavailable. On, the default, nothing changes:
 * the saved state wakes its process, its requests are answered, and its Lead is never closed.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const MACHINE = 'b9'.repeat(16)
/** The Swarm's code, as a process started from the sources loads it: its folder, its libraries and its service. */
const SWARM_CODE = /\/src\/(superTabs\/|lib\/swarm|services\/superTabs(Process)?\.ts$)/
/** Every module each daemon process loaded (harness/loadedModules.mjs), by process: started from the sources, so each
 *  file is the source it is (the shipped build's files are held to the same in src/leanEntry.spec.ts). */
function loadedModules(dir: string): Map<string, string[]> {
  return new Map(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)]))
}
const swarmStarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service superTabs started/g)].length

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, folder: string): Promise<Record<string, any>> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
/** What the Swarm's host keeps on a computer that contributed to one: its host file, which wakes the service at a start,
 *  and its retention naming `lead` as an active project's Lead, which the core never closes while the Swarm is on. */
function swarmState(d: IsolatedDaemon, lead?: string, buddy?: string): void {
  mkdirSync(join(d.dataDir, 'super-tabs'), { recursive: true, mode: 0o700 })
  writeFileSync(join(d.dataDir, 'super-tabs', `host-${MACHINE}.json`), JSON.stringify({ version: 1, machineId: MACHINE }), { mode: 0o600 })
  if (lead || buddy) {
    writeFileSync(join(d.dataDir, 'super-tabs', 'retained.json'), JSON.stringify({ version: 2, machineId: MACHINE,
      harnesses: [lead, buddy].filter(Boolean), leads: lead ? [lead] : [], buddies: buddy ? [buddy] : [] }), { mode: 0o600 })
  }
}
const close = (client: LocalClient, agent: Record<string, any>, mode = 'now') =>
  client.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode }, 60_000)

describe('the Swarm switch', () => {
  let daemon: IsolatedDaemon | undefined
  const clients: LocalClient[] = []
  const recorded: string[] = []
  const recordIn = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); recorded.push(dir); return dir }
  afterEach(async () => {
    clients.splice(0).forEach(client => client.close())
    await daemon?.close(); daemon = undefined
    recorded.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
  })
  const fresh = async (env: Record<string, string>, modules?: string) => {
    const record = modules ? { E2E_LOADED_MODULES_DIR: modules, NODE_OPTIONS: `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/loadedModules.mjs')).href}` } : {}
    const d = await IsolatedDaemon.create({ env: { ...env, ...record }, ...(modules ? { launch: ['--import', 'tsx', 'src/cli.ts', '__harnessd'] } : {}) })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    swarmState(d)
    await d.start()
    const client = await LocalClient.connect(d)
    clients.push(client)
    return { d, client }
  }

  it('off, runs agents as without the Swarm: its process never starts, its requests are unavailable, its Lead is not kept', async () => {
    const modules = recordIn('swarm-off-modules-')
    const { d, client } = await fresh({ HARNESS_SWARM: 'off' }, modules)
    const agent = await create(d, client, 'swarm-off')
    await turn(client, agent.id, 'the core works with the Swarm off')
    await until('the core to leave the Swarm off', () => d.log().includes('[services] superTabs is turned off on this computer') || null, 30_000, 200)
    expect(await client.request('super_tabs', { action: 'help' }, 30_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'superTabs' })
    const role = await client.request('agent_create', { engine: 'claude', cwd: join(d.projectsDir, 'swarm-off'), bypassPermission: true, swarmRole: 'dev' }, 30_000)
    expect(role).toMatchObject({ error: 'INVALID_SWARM_ROLE', detail: 'The Swarm is off on this computer (HARNESS_SWARM).' })
    // Named a Lead by the Swarm's saved retention, it closes as any agent does: no Swarm code guards it.
    swarmState(d, agent.id)
    expect(await close(client, agent)).toMatchObject({ closed: true })
    expect(swarmStarts(d), 'the Swarm\'s process, with the Swarm off').toBe(0)
    // No process loaded any of its code (the review of #1765): the master, the core and every service's process.
    const loaded = loadedModules(modules)
    expect(loaded.size, 'the master, the core and the edge host, at least').toBeGreaterThanOrEqual(3)
    expect([...loaded.values()].flat().some((url) => url.includes('/src/core/main.ts')), 'the core\'s own code, recorded').toBe(true)
    expect([...loaded.values()].flat().filter((url) => SWARM_CODE.test(url))).toEqual([])
  }, 240_000)

  // With every service in the core's process (`HARNESSD_SERVICES=none`): the agent cleanup, Share, the change-agent handoff
  // and models start there, and with the Swarm off none of them loads its retention, observers, records or grid code.
  it('off with every service in the core, runs agents and loads none of the Swarm\'s code', async () => {
    const modules = recordIn('swarm-off-inline-modules-')
    const { d, client } = await fresh({ HARNESS_SWARM: 'off', HARNESSD_SERVICES: 'none' }, modules)
    const agent = await create(d, client, 'swarm-off-inline')
    await turn(client, agent.id, 'the core works with every service in it and the Swarm off')
    await until('the core to leave the Swarm off', () => d.log().includes('[services] superTabs is turned off on this computer') || null, 30_000, 200)
    expect(await client.request('super_tabs', { action: 'help' }, 30_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'superTabs' })
    expect(await close(client, agent)).toMatchObject({ closed: true })
    const loaded = [...loadedModules(modules).values()].flat()
    expect(loaded.some((url) => url.includes('/src/services/inline.ts')), 'the services, in the core\'s process').toBe(true)
    expect(loaded.some((url) => url.includes('/src/services/agentCleanup.ts')), 'the agent cleanup, in the core\'s process').toBe(true)
    expect(loaded.filter((url) => SWARM_CODE.test(url))).toEqual([])
  }, 240_000)

  it('on by default, nothing changes: its saved state wakes its process, its requests are answered, its Lead is never closed', async () => {
    // Empty reads as unset, whatever the run was started with (`HARNESS_SWARM=off npm run test:e2e`).
    const modules = recordIn('swarm-on-modules-')
    const { d, client } = await fresh({ HARNESS_SWARM: '' }, modules)
    const agent = await create(d, client, 'swarm-on')
    await turn(client, agent.id, 'the core works with the Swarm on')
    await until('the Swarm\'s process, woken by its saved state', () => swarmStarts(d) > 0 || null, 60_000, 200)
    expect(await client.request('super_tabs', { action: 'help' }, 60_000)).toMatchObject({ ok: true })
    swarmState(d, agent.id)
    expect(await close(client, agent)).toMatchObject({ error: 'LEAD_PROTECTED' })
    expect(d.log()).not.toContain('[services] superTabs is turned off on this computer')
    // The recording sees the Swarm's code where it runs: its side of the core, and its own process.
    const loaded = [...loadedModules(modules).values()].flat()
    expect(loaded.some((url) => url.includes('/src/superTabs/inCore.ts'))).toBe(true)
    expect(loaded.some((url) => url.includes('/src/services/superTabsProcess.ts'))).toBe(true)
  }, 240_000)

  // Diego's Buddy, 10-30: closing the tab that showed it stopped it. A close (a window's, `harness close`, the cleanup) never
  // stops a Buddy the host keeps, and says it kept running; Stop Harness, the machine owner's own action, still stops it
  // (the Product Manager, 10-30).
  it('on, a close never stops a Buddy, and Stop Harness still does', async () => {
    const { d, client } = await fresh({ HARNESS_SWARM: '' })
    const agent = await create(d, client, 'swarm-buddy')
    await turn(client, agent.id, 'a Buddy answers its person')
    await until('the Swarm\'s process, woken by its saved state', () => swarmStarts(d) > 0 || null, 60_000, 200)
    swarmState(d, undefined, agent.id)
    expect(await close(client, agent, 'inspect')).toMatchObject({ activity: expect.any(String), keptRunning: true })
    for (const mode of ['idle', 'now']) {
      expect(await close(client, agent, mode)).toMatchObject({ error: 'BUDDY_PROTECTED', keptRunning: true,
        detail: 'This is a Swarm Buddy. Its person removes it from the Swarm, or Stop Harness stops it.' })
    }
    expect((await row(client, agent.id))?.status).toBe('active')
    expect((await client.request('agent_delete', { agentId: agent.id }, 90_000)).error).toBeUndefined()
    await until('Stop Harness to stop the Buddy', async () => ((await row(client, agent.id))?.status ?? 'stopped') !== 'active' || null, 60_000, 500)
  }, 240_000)
})
