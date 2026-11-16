/** Reader loss must not revoke the original Close while its exact engine handles SIGTERM. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { alive, harnessdProcesses } from './harness/endurance.js'
import { fakeHermesScript } from './harness/fakeHermes.mjs'

type Row = { id: string; sessionId: string; createdAt: string; status: string; identityHold?: string }
let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined, release: string | undefined
afterEach(async () => {
  if (release) writeFileSync(release, '')
  client?.close(); await daemon?.close()
  daemon = undefined; client = undefined; release = undefined
})

it('closes and resumes the same conversation after its reader dies during the real engine exit', async () => {
  const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
    HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000' } })
  onTestFailed(() => console.log(d.log()))
  const home = d.env.HERMES_HOME = join(d.root, 'hermes'), commands = join(d.root, 'hermes-script.jsonl')
  const signalled = join(d.root, 'engine-signalled.json')
  release = join(d.root, 'release-engine')
  writeFileSync(release, '')
  Object.assign(d.env, { HERMES_PATH: join(d.root, 'bin', 'hermes'), HOOK_INSTALL_ENGINES: 'hermes' })
  mkdirSync(home, { recursive: true }); writeFileSync(commands, '')
  // An explicit fixture barrier holds the original process after SIGTERM. The test releases it only after the
  // core observes its own worker's disconnection. The existing native identity checks and real signal stay intact.
  const fake = fakeHermesScript({ version: 'Hermes Agent v0.23.1 (2026.11.1)', script: commands }).trimEnd() + `.then(() => {
    const fs = process.getBuiltinModule('node:fs');
    const handlers = process.listeners('SIGTERM');
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {
      const finish = () => { for (const handler of handlers) handler(); };
      if (fs.existsSync(${JSON.stringify(release)})) { finish(); return; }
      const watcher = fs.watch(${JSON.stringify(d.root)}, () => {
        if (fs.existsSync(${JSON.stringify(release)})) { clearTimeout(deadline); watcher.close(); finish(); }
      });
      const deadline = setTimeout(() => { watcher.close(); finish(); }, 10000);
      fs.writeFileSync(${JSON.stringify(signalled)}, JSON.stringify({ pid: process.pid, signal: 'SIGTERM' }));
    });
  })\n`
  writeFileSync(d.env.HERMES_PATH!, fake, { mode: 0o755 })
  await d.start()
  const c = client = await LocalClient.connect(d), core = d.corePid()
  const cwd = join(d.projectsDir, 'hermes'); mkdirSync(cwd)
  const created = await c.request('agent_create', { engine: 'hermes', cwd }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const rows = async () => (await c.request('agents_list', { includeStopped: true })).agents as Row[]
  const active = () => until('the original Hermes conversation active without a hold', async () =>
    (await rows()).find(row => row.id === created.agent.id && row.sessionId && row.status === 'active' && !row.identityHold) ?? null, 30_000, 100)
  const original = await active()
  const nativeRow = () => (JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as
    { agentId: string; sessionId: string; hermesHome: string | null; processIdentity?: { pid: number } }[])
    .find(row => row.agentId === original.id)!
  const attached = (from: number) => until('a completed native-history attachment for this conversation', () => {
    const line = `[agent] ${original.id.slice(0, 8)} attached · engine=hermes`
    return d.log().slice(from).split('\n').some(text => text.includes(line) && text.includes(`session=${original.sessionId.slice(0, 8)}`)) || null
  }, 30_000, 50)
  const history = 'history retained across reader loss during Close'
  appendFileSync(commands, JSON.stringify({ say: history }) + '\n')
  await until('the initial native history available', async () =>
    JSON.stringify(await c.request('session_get', { sessionId: original.id, limit: 10 }, 15_000)).includes(history) || null, 30_000, 100)
  // Reading the store must leave the implicit default alone. Filling it here made the next attach revoke itself.
  expect(nativeRow().hermesHome).toBeNull()
  // Fresh creation does not always emit a completed-attach line. Resume supplies the explicit attachment
  // boundary needed here, as it does in the storage acceptance fixture.
  const close = () => c.request('agent_close', { agentId: original.id, sessionId: original.sessionId,
    createdAt: original.createdAt, mode: 'now' }, 60_000)
  expect(await close()).toMatchObject({ closed: true })
  const readyFrom = d.log().length
  expect(await c.request('agent_resume', { agentId: original.id }, 90_000)).not.toHaveProperty('error')
  expect((await active()).sessionId).toBe(original.sessionId)
  await attached(readyFrom)
  expect(nativeRow().hermesHome).toBeNull()
  rmSync(release)
  const live = 'the reader is active before the fault', from = c.frames.length
  appendFileSync(commands, JSON.stringify({ say: live }) + '\n')
  await c.waitFor(frame => frame.type === 'turn_started' && frame.agentId === original.id && frame.payload?.userMessage === live,
    15_000, 'the native reader following the fixture turn', from)
  await c.waitFor(frame => frame.type === 'turn_ended' && frame.agentId === original.id, 15_000, 'the fixture turn ending', from)
  const worker = harnessdProcesses(d).get('engine-others')!
  expect(worker).toBeGreaterThan(0)
  const saved = nativeRow()
  expect(saved.sessionId).toBe(original.sessionId)
  expect(saved.processIdentity?.pid).toBeGreaterThan(0)
  const mark = d.log().length
  const closing = close()
  void closing.catch(() => {})
  await until('the original engine handling its real SIGTERM', () => existsSync(signalled) || null, 15_000, 25)
  expect(JSON.parse(readFileSync(signalled, 'utf8'))).toEqual({ pid: saved.processIdentity!.pid, signal: 'SIGTERM' })
  process.kill(worker, 'SIGKILL')
  await until('the core observing its private reader worker disconnect', () =>
    d.log().slice(mark).includes("the other engines' worker is gone") || null, 5_000, 25)
  expect(alive(saved.processIdentity!.pid)).toBe(true)
  writeFileSync(release, '')
  expect(await closing).toMatchObject({ closed: true })
  expect(alive(saved.processIdentity!.pid)).toBe(false)
  expect(d.corePid()).toBe(core)
  expect((await rows()).find(row => row.id === original.id)).toMatchObject({ status: 'stopped', sessionId: original.sessionId })
  const directory = join(d.dataDir, 'session-checkpoints')
  const manifest = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))!), 'utf8'))
  expect(manifest).toMatchObject({ version: 1, sessionId: original.sessionId, engine: 'hermes' })
  expect(readFileSync(join(directory, manifest.file), 'utf8')).toContain(history)
  const resumedAt = d.log().length
  expect(await c.request('agent_resume', { agentId: original.id }, 90_000)).not.toHaveProperty('error')
  expect((await active()).sessionId).toBe(original.sessionId)
  await attached(resumedAt)
  expect(nativeRow().hermesHome).toBeNull()
  expect(JSON.stringify(await c.request('session_get', { sessionId: original.id, limit: 10 }, 15_000))).toContain(history)
  const afterResume = 'a fresh turn after the final resume', deliveredFrom = c.frames.length
  appendFileSync(commands, JSON.stringify({ say: afterResume }) + '\n')
  await c.waitFor(frame => frame.type === 'turn_started' && frame.agentId === original.id && frame.payload?.userMessage === afterResume,
    15_000, 'the resumed native reader following a fresh turn', deliveredFrom)
  await c.waitFor(frame => frame.type === 'turn_ended' && frame.agentId === original.id, 15_000, 'the resumed fixture turn ending', deliveredFrom)
  expect(d.corePid()).toBe(core)
})
