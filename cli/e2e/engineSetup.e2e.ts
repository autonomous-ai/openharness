/** Optional setup cannot hold terminal launches or input; every process/home/socket here is disposable. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
const setupPid = (d: IsolatedDaemon) => harnessdProcesses(d).get('engineSetup')
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
async function fresh(env: Record<string, string> = {}) {
  const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env } })
  onTestFailed(() => console.log(d.log()))
  await d.start(); client = await LocalClient.connect(d)
  return { d, c: client }
}
async function create(d: IsolatedDaemon, c: LocalClient, engine: 'terminal' | 'claude', name: string) {
  const cwd = join(d.projectsDir, name); mkdirSync(cwd, { recursive: true })
  const result = await c.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(result.error, JSON.stringify(result)).toBeUndefined()
  if (engine !== 'terminal') {
    // Creation opens a pending pane; input before its native process is bound can be refused.
    await c.waitFor(frame => frame.type === 'agent_synced' && frame.payload?.agent?.id === result.agent.id
      && frame.payload.agent.launch?.state === 'ready' && !!frame.payload.agent.sessionId,
    30_000, 'the native engine ready and bound')
  }
  return result.agent
}
async function turn(c: LocalClient, agentId: string, content: string) {
  await c.turn(agentId, content, 30_000)
}

it('starts setup only for an engine launch and keeps every private setup route off the client router', async () => {
  const { d, c } = await fresh({ DISABLE_HOOK_INSTALL: 'true' })
  expect(setupPid(d)).toBeUndefined()
  for (const type of ['setup_capture', 'setup_probe', 'setup_download', 'setup_version', 'setup_status', 'setup_prepare', 'setup_commit', 'setup_files_prepare', 'setup_files_commit']) {
    expect((await c.request(type, { engine: 'claude', allowed: true })).error).toBe('UNSUPPORTED')
  }
  await create(d, c, 'terminal', 'shell')
  expect(setupPid(d)).toBeUndefined()
  const agent = await create(d, c, 'claude', 'native')
  expect(setupPid(d)).toBeGreaterThan(1)
  await turn(c, agent.id, 'setup-on-demand')
  expect(d.coresStarted()).toBe(1)
})

/** Every path and fault belongs to this daemon before its master starts. */
async function fileFixture() {
  const d = daemon = await IsolatedDaemon.create({ env: { HOOK_INSTALL_ENGINES: 'claude',
    HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
    HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '60000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' } })
  d.env.NODE_OPTIONS = `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/setupFilesFault.mjs')).href}`
  d.env.HARNESS_E2E_SETUP_FILES_ROOT = d.root
  d.env.HARNESSD_TEST_HOLD_CONNECT = `engineSetup:${join(d.root, 'setup-files-off')}`
  onTestFailed(() => console.log(d.log()))
  await d.start(); client = await LocalClient.connect(d)
  return { d, c: client }
}
function operations(d: IsolatedDaemon): Array<{ type: string; pid: number }> {
  const file = join(d.root, 'setup-files-operations')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function nativeFiles(d: IsolatedDaemon): Array<string | null> {
  return [join(d.env.HOME!, '.claude', 'settings.json'), join(d.env.HOME!, '.harness', 'agent-messages', 'hook.mjs')]
    .map(file => existsSync(file) ? readFileSync(file, 'utf8') : null)
}

it.each(['off', 'kill', 'freeze', 'malformed'] as const)('contains file preparation while setup is %s and recovers real native hooks', async failure => {
  const { d, c } = await fileFixture()
  const agent = await create(d, c, 'claude', 'file-before')
  await turn(c, agent.id, 'file-before-failure')
  const pid = setupPid(d)!, core = d.corePid(), before = nativeFiles(d)
  const connections = () => d.log().split('[services] engineSetup connected').length - 1
  const connectedBefore = connections()
  expect(before[0]).toContain('SessionStart')
  expect(before[1]).toContain('Agent Messages')
  expect(operations(d)).toEqual(expect.arrayContaining([
    { type: 'setup_files_prepare_result', pid }, { type: 'setup_files_commit_result', pid },
  ]))
  const fault = join(d.root, 'setup-files-fault'), observed = fault + '.observed', off = join(d.root, 'setup-files-off')
  if (failure === 'off') { writeFileSync(off, '', { mode: 0o600 }); process.kill(pid, 'SIGKILL') }
  else writeFileSync(fault, failure, { mode: 0o600 })
  const cwd = join(d.projectsDir, `file-held-${failure}`); mkdirSync(cwd, { recursive: true })
  const launchClient = await LocalClient.connect(d)
  let replied = false
  const pending = launchClient.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000).finally(() => { replied = true })
  void pending.catch(() => {}) // A failing assertion still closes this fixture connection below.
  try {
    if (failure !== 'off') {
      await until('the exact setup files reply fault', () => existsSync(observed) || null, 30_000, 100)
      expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
        type: failure === 'malformed' ? 'setup_files_commit_result' : 'setup_files_prepare_result', pid,
      })
    }
    await Promise.all([turn(c, agent.id, `file-during-${failure}`), create(d, c, 'terminal', `file-shell-${failure}`)])
    if (failure === 'off' || failure === 'freeze') expect(replied).toBe(false)
    expect((await pending).error).toBe('NATIVE_LAUNCH_HELD')
    expect(nativeFiles(d)).toEqual(before)
    expect(d.corePid()).toBe(core)
    if (failure === 'freeze') expect(setupPid(d)).toBe(pid)
  } finally {
    launchClient.close()
    rmSync(fault, { force: true }); rmSync(off, { force: true })
    if (failure === 'freeze' && setupPid(d) === pid) process.kill(pid, 'SIGKILL')
  }
  if (failure === 'kill' || failure === 'freeze' || failure === 'off') {
    await until('setup files worker recovery', () => { const next = setupPid(d); return next && next !== pid && connections() > connectedBefore ? next : null }, 30_000, 100)
  }
  const recovered = await create(d, c, 'claude', `file-recovered-${failure}`)
  await turn(c, recovered.id, 'file-after-recovery')
  expect(d.hookLog()).toMatch(/claude .*SessionStart.*ran.*exit=0/)
  expect(nativeFiles(d)).toEqual(before)
  expect(d.corePid()).toBe(core); expect(d.coresStarted()).toBe(1)
})

it.each(['kill', 'freeze'] as const)('keeps input and unrelated shell launches working after setup %s', async failure => {
  const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: failure === 'freeze' ? '60000' : '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' })
  const agent = await create(d, c, 'claude', 'already-running')
  await turn(c, agent.id, 'before-setup-failure')
  const core = d.corePid(), before = setupPid(d)!
  process.kill(before, failure === 'kill' ? 'SIGKILL' : 'SIGSTOP')
  try {
    await Promise.all([turn(c, agent.id, 'during-setup-failure'), create(d, c, 'terminal', `shell-${failure}`)])
    expect(d.corePid()).toBe(core)
    if (failure === 'freeze') {
      // Prove both operations completed while setup was still frozen, then request its recovery.
      expect(setupPid(d)).toBe(before)
      process.kill(before, 'SIGKILL')
    }
    await until('setup replacement', () => { const pid = setupPid(d); return pid && pid !== before ? pid : null }, 30_000, 100)
    const next = await create(d, c, 'claude', `after-${failure}`)
    await turn(c, next.id, 'setup-recovered')
    expect(d.coresStarted()).toBe(1)
  } finally {
    // Never signal a reused PID: only resume the still-listed fixture service.
    if (failure === 'freeze' && setupPid(d) === before) process.kill(before, 'SIGCONT')
  }
})

it('keeps the explicit inline compatibility composition working', async () => {
  const { d, c } = await fresh({ HARNESSD_SERVICES: 'none' })
  const agent = await create(d, c, 'claude', 'inline')
  await turn(c, agent.id, 'setup-inline')
  expect(setupPid(d)).toBeUndefined(); expect(d.coresStarted()).toBe(1)
})
