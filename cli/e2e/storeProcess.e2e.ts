/**
 * The Harness Store in its own process, beside the viewers (harnessd/services.ts `SERVICE_HOSTS`), on the
 * real daemon. The harnesses the release bundles are put in place by the Store's start; an install from a
 * repository runs there, its progress reaches the window as `dsh_install_status` through the core, and an
 * agent created on the harness the moment the install answers finds it installed, though the core keeps
 * the installed index for two seconds (dsh/installed.ts). Whatever happens to the process costs the Store
 * and the viewers alone: killed, a list asked meanwhile is answered SERVICE_UNAVAILABLE at once, agents go
 * on, and the master brings it back.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const HARNESS = 'e2e/installed-here'
const FIRST = 'e2e/installed-first'

/** A harness in a git repository of its own, whose setup says a line: what `dsh_install` clones and sets up. */
function repository(d: IsolatedDaemon, id = HARNESS, name = 'Installed Here', gate?: { ready: string; release: string }, initialization?: string): string {
  const dir = join(d.root, `repo-${id.replace('/', '-')}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id, name, engine: 'claude', toolchain: { setup: './setup.sh' }, ...(initialization ? { workspace: { init: './init.mjs' } } : {}) }))
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  // Found by QA on a quiet machine: hold setup while the core reads the uninstalled index. A
  // warming loop can cross the install's completion and mistake a successful create for a failure.
  const wait = gate ? `${quote(process.execPath)} -e ${quote(`
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(gate.ready)}, 'ready');
    setInterval(() => { if (fs.existsSync(${JSON.stringify(gate.release)})) process.exit(0); }, 10);
    setTimeout(() => { console.error('test did not release the install setup'); process.exit(1); }, 30000);
  `)}\n` : ''
  writeFileSync(join(dir, 'setup.sh'), `#!/bin/sh\necho setting up\n${wait}`, { mode: 0o755 })
  if (initialization) writeFileSync(join(dir, 'init.mjs'), `#!/usr/bin/env node\n${initialization}`, { mode: 0o755 })
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, HOME: d.env.HOME, GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'a harness')
  return dir
}

/** The process the Store runs in now, the viewers': the last one the master said it started. */
const viewersPid = (d: IsolatedDaemon): number | null => {
  const started = [...d.log().matchAll(/\[harnessd\] service viewers started \(pid (\d+)\)/g)]
  return started.length ? Number(started[started.length - 1][1]) : null
}
const connected = (d: IsolatedDaemon) => d.log().split('[services] store connected').length - 1
const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, folder: string, dsh?: string, engine: 'claude' | 'codex' = 'claude', codexHome?: string): Promise<Record<string, any>> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true, ...(dsh ? { dsh } : {}), ...(codexHome ? { codexHome } : {}) }, 90_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  return until(`${folder} to bind`, async () => {
    const found = await row(client, created.agent.id)
    return found?.sessionId && found.status === 'active' ? found : null
  }, 60_000, 500)
}
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}

describe('the Store in its own process, beside the viewers', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}) => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    await until('the Store to connect to the core', () => connected(d) >= 1 || null, 30_000, 200)
    return d
  }

  it('installs a harness there, says how it goes, and the agent created the moment it answers finds it', async () => {
    const d = await fresh()
    // The bundled harnesses, put in place by the Store's start (only a bundle carries them).
    if (process.env.E2E_BUNDLE_PATH) {
      await until('the bundled Model Manager in place', () => {
        try { return JSON.parse(readFileSync(join(d.env.DSH_DIR!, 'installed.json'), 'utf8')).some((record: { id: string }) => record.id === 'autonomous/autonomous-grid') || null } catch { return null }
      }, 30_000, 250)
    }
    const client = await LocalClient.connect(d)
    expect(await client.request('dsh_install', { url: repository(d, FIRST, 'Installed First') }, 180_000)).toMatchObject({ ok: true, id: FIRST })
    expect(await create(d, client, 'installed-first', FIRST)).toMatchObject({ dsh: FIRST, dshName: 'Installed First' })
    // The core keeps what is installed for two seconds (dsh/installed.ts). Read the missing
    // harness while setup is held, then finish the install inside that cache's lifetime.
    const cwd = join(d.projectsDir, 'installed-here')
    mkdirSync(cwd, { recursive: true })
    const createHere = () => client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, dsh: HARNESS }, 30_000)
    const gate = { ready: join(d.root, 'setup-ready'), release: join(d.root, 'setup-release') }
    const installing = client.request('dsh_install', { url: repository(d, HARNESS, 'Installed Here', gate) }, 180_000)
    let warmedAt = 0
    try {
      await until('the installer held in setup', () => existsSync(gate.ready) || null, 30_000, 10)
      warmedAt = Date.now()
      expect(await createHere()).toMatchObject({ error: 'INVALID_DSH' })
    } finally { writeFileSync(gate.release, 'continue') }
    expect(await installing).toMatchObject({ ok: true, id: HARNESS })
    const created = await createHere()
    // Expiry must not hide a missing invalidation: both requests completed inside the cache lifetime.
    expect(Date.now() - warmedAt, 'created inside the core cache lifetime').toBeLessThan(2_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the harness agent to bind', async () => {
      const found = await row(client, created.agent.id)
      return found?.sessionId && found.status === 'active' ? found : null
    }, 60_000, 500)
    expect(agent).toMatchObject({ dsh: HARNESS, dshName: 'Installed Here' })
    const statuses = client.frames.filter((frame) => frame.type === 'dsh_install_status').map((frame) => frame.payload ?? {})
    // Cloned before its manifest names it; set up and done under its id.
    expect(statuses.some((status) => status.phase === 'clone')).toBe(true)
    expect(statuses.filter((status) => status.id === HARNESS).map((status) => status.phase)).toEqual(expect.arrayContaining(['setup', 'done']))
    const catalog = (await client.request('dsh_list', {}, 60_000)).dsh as Array<Record<string, unknown>>
    expect(catalog.find((entry) => entry.id === HARNESS)).toMatchObject({ installed: true })
    await turn(client, agent.id, 'on a harness installed by the Store\'s process')
    expect(d.log()).toMatch(/\[services\] store connected/)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('killed outright: asked meanwhile it says so at once, agents go on, and the master brings it back', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'store-killed')
    const pid = viewersPid(d)!
    process.kill(pid, 'SIGKILL')
    const listed = await client.request('dsh_list', {}, 30_000)
    if (listed.error) expect(listed).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'store', retryable: true })
    await turn(client, agent.id, 'while the Store was gone')
    await until('the Store to be back', () => connected(d) >= 2 || null, 30_000, 200)
    await until('the Store to list again', async () => Array.isArray((await client.request('dsh_list', {}, 60_000)).dsh) || null, 60_000, 500)
    expect(viewersPid(d)).not.toBe(pid)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
  it.each(['killed', 'hung'] as const)('Store %s at boot: readiness and plain launches proceed, package agents wait prepared', async how => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '3000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' })
    let client = await LocalClient.connect(d)
    expect(await client.request('dsh_install', { url: repository(d) }, 180_000)).toMatchObject({ ok: true })
    const profile = join(d.root, 'held-codex-profile')
    mkdirSync(profile)
    const agents = [await create(d, client, 'held-claude', HARNESS), await create(d, client, 'held-codex', HARNESS, 'codex', profile)]
    const stopped = await create(d, client, 'stop-while-store-is-held', HARNESS)
    for (const agent of [...agents, stopped]) await turn(client, agent.id, 'before the reboot')
    const hold = join(d.root, 'hold-store')
    writeFileSync(hold, '')
    d.env.HARNESSD_TEST_HOLD_CONNECT = `store:${hold}`
    client.close()
    await d.stop()
    await d.tmux.run('kill-server')
    // Make pending instruction/profile work observable. Neither a Store outage nor a held retry
    // may perform it before the package preparation succeeds. Every path is private to this daemon.
    const instructionFiles = [join(d.projectsDir, 'held-claude', 'CLAUDE.md'), join(d.projectsDir, 'held-codex', 'AGENTS.md')]
    const instructionsBefore = instructionFiles.map(file => readFileSync(file, 'utf8'))
    const profileHooks = join(profile, 'hooks.json')
    const profileBefore = JSON.stringify({ fixtureOwner: 'preserve' })
    writeFileSync(profileHooks, profileBefore)
    const apiDir = join(d.dataDir, 'api-connections')
    mkdirSync(apiDir, { recursive: true })
    writeFileSync(join(apiDir, 'connections.json'), JSON.stringify({ version: 1, connections: [{
      id: 'fixture', provider: 'fixture', name: 'Fixture API', baseUrl: 'http://127.0.0.1:9/v1',
      keyEnv: 'FIXTURE_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer', apiKey: 'fixture-key',
    }] }), { mode: 0o600 })
    const started = Date.now()
    await d.start()
    expect(Date.now() - started).toBeLessThan(15_000)
    client = await LocalClient.connect(d)
    for (const agent of agents) {
      await until('a package launch held for Store', async () => (await row(client, agent.id))?.launch?.state === 'held' || null, 10_000, 100)
      expect(await row(client, agent.id)).toMatchObject({ status: 'offline', launch: { state: 'held', service: 'store' } })
    }
    const stopReply = await client.request('agent_delete', { agentId: stopped.id }, 10_000)
    expect(stopReply.error, JSON.stringify(stopReply)).toBeUndefined()
    await until('Stop completes while Store is unavailable', async () => (await row(client, stopped.id))?.status === 'stopped' || null, 10_000, 100)
    const pid = viewersPid(d)!
    process.kill(pid, how === 'killed' ? 'SIGKILL' : 'SIGSTOP')
    await until('Store supervised back', () => viewersPid(d) !== pid || null, 30_000, 100)
    const plain = await create(d, client, 'plain-during-store-outage')
    await turn(client, plain.id, 'ready without the Store')
    const cwd = join(d.projectsDir, 'refused-package')
    mkdirSync(cwd)
    const refused = await client.request('agent_create', { engine: 'claude', cwd, dsh: HARNESS, bypassPermission: true }, 10_000)
    expect(refused).toMatchObject({ error: 'DSH_UNAVAILABLE' })
    expect(readdirSync(cwd)).toEqual([])
    for (const agent of agents) expect(await row(client, agent.id)).toMatchObject({ launch: { state: 'held' } })
    expect(instructionFiles.map(file => readFileSync(file, 'utf8'))).toEqual(instructionsBefore)
    expect(readFileSync(profileHooks, 'utf8')).toBe(profileBefore)
    rmSync(hold)
    for (const agent of agents) {
      await until('the prepared package resumes its conversation', async () => {
        const now = await row(client, agent.id)
        return now?.status === 'active' && now.sessionId === agent.sessionId && now.launch?.state === 'ready' || null
      }, 90_000, 250)
      await turn(client, agent.id, 'after Store recovery')
    }
    for (const file of instructionFiles) expect(readFileSync(file, 'utf8')).toContain('<!-- harness:apis -->')
    expect(readFileSync(profileHooks, 'utf8')).toContain('SessionStart')
    expect(await row(client, stopped.id)).toMatchObject({ status: 'stopped', sessionId: stopped.sessionId })
    expect(d.log()).not.toContain('could not build its launch')
    expect(d.coresStarted()).toBe(2)
    client.close()
  })

  it('a Store killed during init preserves uncertain work and never repeats it under a new create label', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const release = join(d.root, 'release-init')
    const cwd = join(d.projectsDir, 'interrupted-init')
    mkdirSync(cwd)
    const script = `import fs from 'node:fs';
      fs.appendFileSync('attempts', 'once\\n'); fs.writeFileSync('init-ready', 'ready');
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { fs.writeFileSync('init-done', 'done'); clearInterval(timer); } }, 20);
      setTimeout(() => { clearInterval(timer); process.exit(2); }, 30000).unref();`
    expect(await client.request('dsh_install', { url: repository(d, HARNESS, 'Interrupted Init', undefined, script) }, 180_000)).toMatchObject({ ok: true })
    const request = { engine: 'claude', cwd, dsh: HARNESS, bypassPermission: true }
    const creating = client.request('agent_create', request, 45_000)
    try {
      await until('init writes its first part', () => existsSync(join(cwd, 'init-ready')) || null, 20_000, 50)
      process.kill(viewersPid(d)!, 'SIGKILL')
      expect(await creating).toMatchObject({ error: 'DSH_UNAVAILABLE' })
      await until('the replacement Store connects', () => connected(d) >= 2 || null, 20_000, 100)
      const retry = await client.request('agent_create', request, 10_000)
      expect(retry).toMatchObject({ error: 'DSH_UNAVAILABLE', detail: expect.stringContaining('unconfirmed') })
      expect(readFileSync(join(cwd, 'attempts'), 'utf8')).toBe('once\n')
      expect(existsSync(join(cwd, '.harness', 'runtime'))).toBe(false)
      const plain = await create(d, client, 'plain-after-interrupted-init')
      await turn(client, plain.id, 'workspace uncertainty is isolated')
      expect(d.coresStarted()).toBe(1)
    } finally {
      writeFileSync(release, 'finish')
      await until('the isolated orphaned init finishes', () => existsSync(join(cwd, 'init-done')) || null, 10_000, 50)
      client.close()
    }
  })

})
