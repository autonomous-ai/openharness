/** Real bundled Close callers, supervised storage workers and private Hermes stores. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { alive, harnessdProcesses } from './harness/endurance.js'
import { fakeHermesScript } from './harness/fakeHermes.mjs'
import { withFault } from './harness/release.js'

type Row = { id: string; sessionId: string; createdAt: number; status: string }
type Write = { pid: number; path: string; event: 'opened' | 'closed' }
let build: string, scriptPath: string
let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined, companion: LocalClient | undefined
beforeAll(() => {
  const bundle = process.env.E2E_BUNDLE_PATH
  if (!bundle) throw new Error('engineStorage requires E2E_BUNDLE=1 or E2E_BUNDLE_PATH')
  build = mkdtempSync(join(tmpdir(), 'engine-storage-bundle-'))
  scriptPath = join(build, 'cli.js')
  // A rendezvous on the actual output descriptor; no product hook and no timing assumption about SQLite reads.
  const fault = `
if (process.argv[2] === '__run' && process.env.E2E_STORAGE_OLD_MASTER === '1')
  process.env.HARNESSD_ENGINE_OTHERS = process.env.HARNESSD_ENGINE_OTHERS?.replace(/:[0-9]+$/, ':2');
if (process.env.E2E_STORAGE_WRITES) {
  const fs = process.getBuiltinModule('node:fs'), fsp = process.getBuiltinModule('node:fs/promises');
  const original = fsp.open;
  fsp.open = async (...args) => {
    const handle = await original(...args);
    if (/[\\\\/]history\\.tmp$/.test(String(args[0])) && (Number(args[1]) & 3) === fs.constants.O_WRONLY) {
      const record = event => fs.appendFileSync(process.env.E2E_STORAGE_WRITES, JSON.stringify({ pid: process.pid, path: String(args[0]), event }) + '\\n');
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); record('closed'); };
      record('opened');
      const hold = process.env.E2E_STORAGE_HOLD;
      if (hold && fs.existsSync(hold)) await new Promise(resolve => {
        const watcher = fs.watch(process.getBuiltinModule('node:path').dirname(hold), check);
        function check() { if (!fs.existsSync(hold)) { watcher.close(); resolve(); } }
        check();
      });
    }
    return handle;
  };
  process.getBuiltinModule('node:module').syncBuiltinESMExports();
}`
  writeFileSync(scriptPath, withFault(readFileSync(bundle, 'utf8'), fault), { mode: 0o755 })
  copyFileSync(join(dirname(bundle), 'notify.mjs'), join(build, 'notify.mjs'))
})
afterEach(async () => { client?.close(); companion?.close(); await daemon?.close(); client = undefined; companion = undefined; daemon = undefined })
afterAll(() => { if (build) rmSync(build, { recursive: true, force: true }) })

async function fresh(env: Record<string, string> = {}) {
  const d = daemon = await IsolatedDaemon.create({ scriptPath, env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
    HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '120000', ...env } })
  onTestFailed(() => console.log(d.log()))
  const home = d.env.HERMES_HOME = join(d.root, 'hermes')
  const commands = join(d.root, 'hermes-script.jsonl'), writes = join(d.root, 'storage-writes.jsonl'), hold = join(d.root, 'hold-storage')
  Object.assign(d.env, { HERMES_PATH: join(d.root, 'bin', 'hermes'), HOOK_INSTALL_ENGINES: 'hermes', E2E_STORAGE_WRITES: writes, E2E_STORAGE_HOLD: hold })
  mkdirSync(home, { recursive: true }); writeFileSync(commands, ''); writeFileSync(writes, '')
  writeFileSync(d.env.HERMES_PATH!, fakeHermesScript({ version: 'Hermes Agent v0.23.1 (2026.11.1)', script: commands }), { mode: 0o755 })
  await d.start()
  const c = client = await LocalClient.connect(d)
  const cwd = join(d.projectsDir, 'hermes'); mkdirSync(cwd, { recursive: true })
  const created = await c.request('agent_create', { engine: 'hermes', cwd }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const rows = async (connection = c) => (await connection.request('agents_list', { includeStopped: true })).agents as Row[]
  const bound = () => until('Hermes bound to its native session', async () =>
    (await rows()).find(row => row.id === created.agent.id && row.sessionId && row.status === 'active') ?? null, 30_000, 100)
  let agent = await bound()
  const tell = (step: Record<string, unknown>) => appendFileSync(commands, JSON.stringify(step) + '\n')
  tell({ say: 'saved before the worker fault' })
  await until('the Hermes history followed', async () => JSON.stringify(await c.request('session_get', { sessionId: agent.id, limit: 10 }, 15_000))
    .includes('saved before the worker fault') || null, 30_000, 100)
  const close = () => c.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode: 'now' }, 60_000)
  const directory = join(d.dataDir, 'session-checkpoints')
  const manifests = () => existsSync(directory) ? readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => readFileSync(join(directory, name), 'utf8')).sort() : []
  const written = (): Write[] => readFileSync(writes, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const nativeSession = () => {
    const started = JSON.parse(readFileSync(join(home, 'started.json'), 'utf8')) as { terminal: string }
    return JSON.parse(readFileSync(join(home, 'terminal-sessions', started.terminal), 'utf8')).session_id as string
  }
  const resume = async () => {
    const answer = await c.request('agent_resume', { agentId: agent.id }, 90_000)
    expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    agent = await bound()
  }
  return { d, c, home, tell, rows, close, manifests, written, nativeSession, hold, resume, agent: () => agent }
}

it.each(['worker', 'inline', 'older master'] as const)('saves the existing checkpoint format through the %s and never exposes private storage requests', async mode => {
  const r = await fresh(mode === 'inline' ? { HARNESSD_SERVICES: 'none' } : mode === 'older master' ? { E2E_STORAGE_OLD_MASTER: '1' } : {})
  for (const type of ['engine_storage_capabilities', 'engine_storage_lifetime', 'engine_storage_background', 'engine_storage_export'])
    expect((await r.c.request(type, { version: 1, engine: 'hermes', session: { sessionId: r.agent().sessionId } })).error).toBe('UNSUPPORTED')
  const core = r.d.corePid()
  expect(await r.close()).toMatchObject({ closed: true })
  const saved = JSON.parse(r.manifests()[0])
  expect(saved).toMatchObject({ version: 1, sessionId: r.agent().sessionId, engine: 'hermes' })
  expect(readFileSync(join(r.d.dataDir, 'session-checkpoints', saved.file), 'utf8')).toContain('saved before the worker fault')
  expect(new Set(r.written().map(row => row.pid))).toEqual(new Set([mode === 'worker' ? harnessdProcesses(r.d).get('engine-others') : core]))
  expect(r.written().filter(row => row.event === 'opened').length).toBeGreaterThan(0)
  expect(r.d.corePid()).toBe(core)
  await r.resume()
  expect(r.agent().sessionId).toBe(saved.sessionId)
})

it.each(['kill', 'freeze', 'cancel', 'rebind'] as const)('retains saved history when a real opened export is interrupted by %s', async fault => {
  const r = await fresh()
  expect(await r.close()).toMatchObject({ closed: true })
  const before = r.manifests()
  await r.resume()
  const observer = companion = await LocalClient.connect(r.d)
  const original = { ...r.agent() }, core = r.d.corePid(), from = r.written().length
  writeFileSync(r.hold, 'hold')
  const closing = r.close()
  void closing.catch(() => {})
  const opened = await until('the worker output descriptor opened', () => r.written().slice(from).find(row => row.event === 'opened') ?? null, 15_000, 50)
  const worker = harnessdProcesses(r.d).get('engine-others')!
  expect(opened.pid).toBe(worker)
  let frozen = false
  try {
    if (fault === 'kill') process.kill(worker, 'SIGKILL')
    if (fault === 'freeze') { process.kill(worker, 'SIGSTOP'); frozen = true }
    if (fault === 'cancel') expect(await observer.request('agent_close', { agentId: original.id, sessionId: original.sessionId,
      createdAt: original.createdAt, mode: 'cancel' })).toMatchObject({ cancelled: true })
    if (fault === 'rebind') {
      r.tell({ new: true }); r.tell({ say: 'replacement conversation stays open' })
      await until('the native terminal record changed before the export returns', () => r.nativeSession() !== original.sessionId || null, 15_000, 50)
    }
    if (fault === 'cancel' || fault === 'rebind') rmSync(r.hold)
    const answer = await closing
    expect(answer.closed).not.toBe(true)
    expect(answer.error).toBe('HISTORY_NOT_SAVED')
    expect(r.manifests()).toEqual(before)
    expect((await r.rows()).some(row => row.id === original.id && row.status === 'active')).toBe(true)
    expect(r.d.corePid()).toBe(core)
  } finally {
    rmSync(r.hold, { force: true })
    if (frozen && alive(worker)) process.kill(worker, 'SIGCONT')
    await closing.catch(() => {})
  }
  if (fault === 'kill') await until('a replacement storage worker connected', () => {
    const now = harnessdProcesses(r.d).get('engine-others')
    return now && now !== worker && alive(now) ? now : null
  }, 30_000, 100)
  else await until('the original output descriptor settled or its worker retired', () => !alive(worker)
    || r.written().slice(from).some(row => row.event === 'closed') || null, 15_000, 50)
  expect(r.manifests()).toEqual(before)
  expect(r.d.coresStarted()).toBe(1)
})
