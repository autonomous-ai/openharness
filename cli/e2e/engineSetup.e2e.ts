/** Optional setup cannot hold terminal launches or input; every process/home/socket here is disposable. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'
import { harnessPath, thisComputer } from '../src/config/harnessHome.js'

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
async function project(c: LocalClient, input: Record<string, unknown> & { creationId: string }) {
  const first = await c.request('agent_create', { bypassPermission: false, ...input }, 90_000)
  expect(first.error, JSON.stringify(first)).toBeUndefined()
  const made = first.agent ? first : await until('the project pane', async () => {
    const answer = await c.request('agent_create_status', { creationId: input.creationId }, 30_000)
    expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    return answer.agent ? answer : null
  }, 60_000, 100)
  return made.agent
}
async function bound(c: LocalClient, id: string) {
  await c.waitFor(frame => frame.type === 'agent_synced' && frame.payload?.agent?.id === id
    && !!frame.payload.agent.sessionId && frame.payload.agent.launch?.state === 'ready', 30_000, 'the accepted native session')
}

it('starts setup only for an engine launch and keeps every private setup route off the client router', async () => {
  const { d, c } = await fresh({ DISABLE_HOOK_INSTALL: 'true' })
  expect(setupPid(d)).toBeUndefined()
  for (const type of ['setup_capture', 'setup_probe', 'setup_download', 'setup_version', 'setup_status', 'setup_prepare', 'setup_commit', 'setup_files_prepare', 'setup_files_commit', 'setup_trust_prepare', 'setup_trust_commit']) {
    expect((await c.request(type, { engine: 'claude', allowed: true })).error).toBe('UNSUPPORTED')
  }
  await create(d, c, 'terminal', 'shell')
  expect(setupPid(d)).toBeUndefined()
  const agent = await create(d, c, 'claude', 'native')
  expect(setupPid(d)).toBeGreaterThan(1)
  await turn(c, agent.id, 'setup-on-demand')
  expect(d.coresStarted()).toBe(1)
})

it.each(['claude', 'codex'] as const)('keeps a materialized template’s %s trust prompt usable through a real terminal', async engine => {
  const d = daemon = await IsolatedDaemon.create({ trustPrompt: true })
  onTestFailed(() => console.log(d.log()))
  const id = 'e2e/trust-template', directory = join(d.env.DSH_DIR!, id)
  mkdirSync(join(directory, 'template'), { recursive: true })
  writeFileSync(join(directory, 'harness.json'), JSON.stringify({ spec: 1, id, name: 'Trust Template', engine,
    workspace: { template: 'template', marker: 'README.md' } }))
  writeFileSync(join(directory, 'template/README.md'), 'Private template fixture\n')
  writeFileSync(join(d.env.DSH_DIR!, 'installed.json'), JSON.stringify([
    { id, dir: directory, source: directory, ref: null, commit: null, linked: false, installedAt: Date.now() },
  ]))
  writeFileSync(join(d.env.HOME!, '.claude.json'), '{}')
  await d.start(); const c = client = await LocalClient.connect(d)
  const creationId = `trust-template-${engine}`
  const agent = await project(c, { engine, dsh: id, projectSource: 'new', projectName: `template-${engine}`, creationId })
  const pane = agent.tmuxPane as string, cwd = (agent.project?.cwd ?? agent.cwd) as string
  await until('the native folder question', async () => {
    const screen = await d.capture(pane)
    return screen.includes(engine === 'claude' ? 'Yes, I trust this folder' : 'Trust and continue') ? screen : null
  }, 30_000, 100)
  expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('Private template fixture\n')
  expect(d.log()).toContain('TEMPLATE_TRUST_UNCONFIRMED')
  await d.tmux.run('send-keys', '-t', pane, 'Enter')
  await bound(c, agent.id)
  await turn(c, agent.id, 'after-template-trust')
  expect(d.coresStarted()).toBe(1)
})

it.each(['claude', 'codex'] as const)('inherits a trusted source for a %s worktree through setup and a real terminal', async engine => {
  const d = daemon = await IsolatedDaemon.create({ trustPrompt: true })
  onTestFailed(() => console.log(d.log()))
  const source = join(d.projectsDir, 'trusted-source'); mkdirSync(source)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'gc.auto=0', '-C', source, ...args],
    { env: { ...d.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(source, 'README.md'), 'Private source fixture\n')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture')
  const config = engine === 'claude' ? join(d.env.HOME!, '.claude.json') : join(d.env.CODEX_HOME!, 'config.toml')
  writeFileSync(config, engine === 'claude' ? JSON.stringify({ projects: { [source]: { hasTrustDialogAccepted: true } } })
    : `model = "fixture"\n[projects.${JSON.stringify(source)}]\ntrust_level = "trusted"\n`)
  await d.start(); const c = client = await LocalClient.connect(d)
  const agent = await project(c, { engine, projectSource: 'worktree', gitSource: source, branchRef: 'refs/heads/main',
    creationId: `trust-worktree-${engine}` })
  await bound(c, agent.id)
  const cwd = (agent.project?.cwd ?? agent.cwd) as string
  expect(cwd).not.toBe(source)
  expect(readFileSync(config, 'utf8')).toContain(JSON.stringify(cwd))
  await turn(c, agent.id, 'after-inherited-trust')
  expect(d.coresStarted()).toBe(1)
})

it.each(['unavailable', 'late', 'malformed'] as const)('keeps the native trust prompt usable when optional setup replies are %s', async mode => {
  const d = daemon = await IsolatedDaemon.create({ trustPrompt: true })
  onTestFailed(() => console.log(d.log()))
  d.env.NODE_OPTIONS = `--import=${pathToFileURL(join(CLI_ROOT, 'e2e/harness/setupTrustFault.mjs')).href}`
  d.env.HARNESS_E2E_SETUP_TRUST_ROOT = d.root
  writeFileSync(join(d.root, 'setup-trust-fault'), mode, { mode: 0o600 })
  const config = join(d.env.HOME!, '.claude.json'); writeFileSync(config, '{}')
  await d.start(); const c = client = await LocalClient.connect(d)
  const agent = await project(c, { engine: 'claude', projectSource: 'new', projectName: `trust-${mode}`,
    creationId: `trust-fallback-${mode}` })
  expect(readFileSync(join(d.root, 'setup-trust-fault.observed'), 'utf8')).toBe(mode)
  expect(readFileSync(join(d.root, 'setup-trust-operations'), 'utf8').trim().split('\n')).toEqual([
    'setup_trust_prepare_result', ...(mode === 'malformed' ? ['setup_trust_commit_result'] : []),
  ])
  expect(readFileSync(config, 'utf8')).toBe('{}')
  expect(d.log()).toContain('FOLDER_TRUST_UNAVAILABLE')
  await until('the fallback trust prompt', async () => (await d.capture(agent.tmuxPane)).includes('Yes, I trust this folder') || null, 30_000, 100)
  await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Enter')
  await bound(c, agent.id)
  await turn(c, agent.id, `after-${mode}-trust`)
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
  return [join(d.env.HOME!, '.claude', 'settings.json'), join(d.env.HARNESS_AGENT_MESSAGES_DIR || harnessPath('agent-messages', d.env.HOME!, process.platform, thisComputer(d.env)), 'hook.mjs')]
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
