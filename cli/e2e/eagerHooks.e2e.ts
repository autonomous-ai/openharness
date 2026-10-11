/** Startup and pre-spawn hook preparation cannot wait for the obsolete shared optional installer. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, onTestFailed } from 'vitest'
import { readLeanBundle } from '../src/harnessd/leanBundle.js'
import { LocalClient } from './harness/client.js'
import { assertHooksContained, CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { withLean } from './harness/release.js'
import { shellSingleQuote } from '../src/lib/shellQuote.js'

let scratch = '', bundle = ''
let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'eager-hooks-'))
  bundle = join(scratch, 'build', 'cli.js')
  execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT,
    env: { ...process.env, BUNDLE_OUT_DIR: dirname(bundle) }, stdio: 'pipe' })
}, 120_000)
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

it('refuses a native hook destination outside the test, including the OpenCode sibling directory', async () => {
  const d = daemon = await IsolatedDaemon.create()
  d.env.HOOK_INSTALL_ENGINES = 'opencode'
  expect(() => assertHooksContained(d.root, d.env)).toThrow('OPENCODE_PLUGIN_DIR')
  d.env.OPENCODE_PLUGIN_DIR = d.root
  expect(() => assertHooksContained(d.root, d.env)).toThrow('OpenCode plugin parent')
  d.env.OPENCODE_PLUGIN_DIR = join(d.root, 'opencode', 'plugin')
  expect(() => assertHooksContained(d.root, d.env)).not.toThrow()
  d.env.HOOK_INSTALL_ENGINES = 'unknown'
  expect(() => assertHooksContained(d.root, d.env)).toThrow('supported hook engines')
})

it('becomes ready and serves control while startup hook preparation is still waiting', async () => {
  const d = daemon = await IsolatedDaemon.create({ scriptPath: bundle, env: { HARNESS_CONNECTIONS_PORT: '0' } })
  onTestFailed(() => console.log(d.log()))
  const binary = join(d.root, 'bin', 'opencode'), entered = join(d.root, 'startup-probe'), release = join(d.root, 'release-probe')
  d.env.OPENCODE_PATH = binary
  d.env.OPENCODE_PLUGIN_DIR = join(d.root, 'opencode', 'plugin')
  d.env.HOOK_INSTALL_ENGINES = 'opencode'
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
if (!process.argv.includes('--version')) process.exit(2);
fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('opencode v2.0.18'); } }, 10);
`, { mode: 0o755 })
  try {
    await d.start()
    const pid = await until('the unreleased startup probe to enter', () => {
      try {
        const value = Number(readFileSync(entered, 'utf8'))
        return Number.isSafeInteger(value) && value > 1 ? value : null
      } catch { return null }
    }, 3_000, 10)
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    // Waiting for the bounded probe's timeout is still waiting for a dependency.
    // The former startup only became ready after killing this unreleased child.
    expect(alive()).toBe(true)
    const c = client = await LocalClient.connect(d)
    expect((await c.request('agents_list', { includeStopped: true }, 1_500)).agents).toEqual([])
    expect(alive()).toBe(true)
    expect(d.coresStarted()).toBe(1)
  } finally { writeFileSync(release, '') }
  await until('the startup hook to finish after its probe is released', () =>
    existsSync(join(d.root, 'opencode', 'plugins', 'launcher-register', 'tui.js')), 10_000)
}, 30_000)

it('keeps Stop and agent listing responsive while a native launch version probe waits', async () => {
  const d = daemon = await IsolatedDaemon.create({ scriptPath: bundle, env: { HARNESS_CONNECTIONS_PORT: '0' } })
  onTestFailed(() => console.log(d.log()))
  const binary = join(d.root, 'bin', 'opencode'), entered = join(d.root, 'version-entered'), release = join(d.root, 'version-release')
  d.env.OPENCODE_PATH = binary
  d.env.OPENCODE_PLUGIN_DIR = join(d.root, 'opencode', 'plugin')
  writeFileSync(binary, `#!${process.execPath}\nconsole.log('opencode v2.0.18')\n`, { mode: 0o755 })
  await d.start()
  const c = client = await LocalClient.connect(d)
  const cwd = join(d.projectsDir, 'responsive'); mkdirSync(cwd)
  const created = await c.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 30_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const id = created.agent.id
  await until('the sibling to bind', async () => {
    const list = await c.request('agents_list', { includeStopped: true })
    return list.agents.find((row: any) => row.id === id && row.status === 'active' && row.sessionId)
  }, 30_000)
  const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === id, 30_000)
  c.send('message', { agentId: id, content: 'native probe responsiveness fixture' }); await ended
  // Replace the fixture after startup so no earlier observation can satisfy this
  // launch. Only this test releases the child; it cannot acknowledge prematurely.
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
if (!process.argv.includes('--version')) process.exit(2);
fs.writeFileSync(${JSON.stringify(entered)}, '');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('opencode v2.0.18'); } }, 10);
`, { mode: 0o755 })
  // A connection intentionally handles its requests in order. Use another
  // private connection so this tests the core, not that connection's queue.
  const probeClient = await LocalClient.connect(d)
  let settled = false
  const launch = probeClient.request('agent_create', { engine: 'opencode', cwd, agent: 'fixture' }, 15_000)
    .finally(() => { settled = true })
  try {
    await until('the native version probe to start', () => existsSync(entered), 5_000, 10)
    expect((await c.request('agents_list', { includeStopped: true }, 1_500)).agents.some((row: any) => row.id === id)).toBe(true)
    expect((await c.request('agent_delete', { agentId: id }, 3_000)).error).toBeUndefined()
    expect(settled).toBe(false)
    expect(d.coresStarted()).toBe(1)
  } finally {
    writeFileSync(release, '')
    await launch.catch(() => {})
    probeClient.close()
  }
  expect((await launch).error).toBe('AGENT_UNSUPPORTED')
}, 90_000)

it('retains and cancels native-held requests across a core crash, then recovers one launch with its saved prompt', async () => {
  const d = daemon = await IsolatedDaemon.create({ scriptPath: bundle, env: { HARNESS_CONNECTIONS_PORT: '0' } })
  onTestFailed(() => console.log(d.log()))
  const executable = join(d.root, 'late-codex')
  d.env.CODEX_PATH = executable
  await d.start()
  let c = client = await LocalClient.connect(d)
  const cwd = join(d.projectsDir, 'native-held'); mkdirSync(cwd)
  const request = { engine: 'codex', cwd, bypassPermission: true, prompt: 'saved native launch prompt', creationId: 'native-held-recovery' }
  const cancelled = { ...request, creationId: 'native-held-cancelled' }
  for (const payload of [request, cancelled]) {
    expect(await c.request('agent_create', payload, 15_000)).toMatchObject({ state: 'pending', held: { service: 'native' } })
  }
  expect((await c.request('agents_list', { includeStopped: true })).agents).toHaveLength(0)
  const before = d.log().length
  process.kill(d.corePid()!, 'SIGKILL'); c.close()
  await until('core readiness while the native executable is unavailable', () => d.log().slice(before).includes('[cli] ready'), 15_000)
  c = client = await LocalClient.connect(d)
  expect(await c.request('agent_create_status', { creationId: request.creationId })).toMatchObject({ state: 'pending', held: { service: 'native' } })
  expect(await c.request('agent_create_cancel', { creationId: cancelled.creationId })).toMatchObject({ state: 'cancelled' })
  const terminal = await c.request('agent_create', { engine: 'terminal', cwd }, 15_000)
  expect(terminal.error, JSON.stringify(terminal)).toBeUndefined()
  const settings = join(d.engineConfig.codexHome, 'hooks.json'), original = readFileSync(settings)
  writeFileSync(settings, '{incomplete native configuration')
  const calls = join(d.root, 'native-dispatches'), wrapper = readFileSync(join(d.root, 'bin', 'codex'), 'utf8')
  const line = wrapper.indexOf('\n') + 1
  writeFileSync(executable, wrapper.slice(0, line) + `import { appendFileSync as recordNativeLaunch } from 'node:fs';\nif (!process.argv.includes('--version') && !process.argv.includes('--help')) recordNativeLaunch(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` + wrapper.slice(line), { mode: 0o755 })
  await until('the saved request to name its hook hold', async () => {
    const status = await c.request('agent_create_status', { creationId: request.creationId })
    return status.state === 'pending' && /hook/i.test(status.held?.detail ?? '')
  }, 15_000)
  expect(readFileSync(settings, 'utf8')).toBe('{incomplete native configuration')
  expect((await c.request('agents_list', { includeStopped: true })).agents).toHaveLength(1)
  writeFileSync(settings, original)
  const recovered = await until('the native request to recover after configuration repair', async () => {
    const status = await c.request('agent_create_status', { creationId: request.creationId })
    return status.state === 'created' ? status.agent : null
  }, 30_000)
  await until('the recovered Codex to bind', async () => {
    const agents = (await c.request('agents_list', { includeStopped: true })).agents
    return agents.find((agent: any) => agent.id === recovered.id && agent.sessionId && agent.status === 'active')
  }, 30_000)
  expect(await c.request('agent_create', request)).toMatchObject({ state: 'created', agent: { id: recovered.id } })
  expect(await c.request('agent_create', cancelled)).toMatchObject({ state: 'cancelled' })
  expect((await c.request('agents_list', { includeStopped: true })).agents).toHaveLength(2)
  const launched = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(launched).toHaveLength(1)
  expect(launched[0].at(-1)).toBe(request.prompt)
}, 120_000)

it.each(['create', 'fork'] as const)('keeps a post-rc held %s with its original request through repair and core restart', async operation => {
  const d = daemon = await IsolatedDaemon.create({ scriptPath: bundle, env: { HARNESS_CONNECTIONS_PORT: '0', SHELL: '/bin/bash' } })
  onTestFailed(() => console.log(d.log()))
  const executable = join(d.root, 'bin', 'codex'), calls = join(d.root, 'dispatches')
  const originalWrapper = readFileSync(executable, 'utf8'), line = originalWrapper.indexOf('\n') + 1
  writeFileSync(executable, originalWrapper.slice(0, line)
    + `import { appendFileSync as recordNativeLaunch } from 'node:fs';\nif (!process.argv.includes('--version') && !process.argv.includes('--help')) recordNativeLaunch(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`
    + originalWrapper.slice(line), { mode: 0o755 })
  await d.start()
  let c = client = await LocalClient.connect(d)
  const cwd = join(d.projectsDir, 'post-rc-held'); mkdirSync(cwd)
  let source: string | undefined
  if (operation === 'fork') {
    const parent = await c.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 30_000)
    expect(parent.error, JSON.stringify(parent)).toBeUndefined()
    source = parent.agent.id
    await until('the source conversation to bind', async () => {
      const rows = (await c.request('agents_list')).agents
      return rows.find((row: any) => row.id === source && row.sessionId)
    }, 30_000)
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === source, 30_000)
    c.send('message', { agentId: source, content: 'private fork source' }); await ended
  }
  // Only the new pane's rc file changes this private config, after preparation.
  // Native probes have no TMUX_PANE. This forces the real final guard to hold.
  const config = join(d.engineConfig.codexHome, 'config.toml'), trigger = join(d.root, 'change-once')
  const original = await until('startup hook preparation to create the private Codex config', () => {
    try { return readFileSync(config) } catch { return null }
  }, 10_000)
  writeFileSync(trigger, '')
  writeFileSync(join(d.env.HOME!, '.bashrc'), `if [ -n "$TMUX_PANE" ] && [ -f ${shellSingleQuote(trigger)} ]; then printf '\\n# changed by private pane fixture\\n' >> ${shellSingleQuote(config)}; /bin/rm ${shellSingleQuote(trigger)}; fi\n`)
  const response = await c.request(operation === 'create' ? 'agent_create' : 'agent_fork', operation === 'create'
    ? { engine: 'codex', cwd, bypassPermission: true, prompt: 'original held prompt' }
    : { agentId: source, prompt: 'original fork prompt' }, 30_000)
  expect(response.error, JSON.stringify(response)).toBeUndefined()
  const id = response.agent.id
  const held = async () => (await c.request('agents_list', { includeStopped: true })).agents.find((row: any) => row.id === id)
  await until('the post-rc native hold', async () => (await held())?.launch?.state === 'held', 30_000)
  expect((await held()).sessionId).toBeFalsy()
  writeFileSync(config, original)
  const before = d.log().length
  process.kill(d.corePid()!, 'SIGKILL'); c.close()
  await until('the core to recover while retaining the original request', () => d.log().slice(before).includes('[cli] ready'), 15_000)
  c = client = await LocalClient.connect(d)
  expect(await c.request('agent_restart', { agentId: id }, 15_000)).toMatchObject({ error: 'NATIVE_LAUNCH_HELD' })
  expect(await held()).toMatchObject({ launch: { state: 'held', service: 'native' } })
  expect((await held()).sessionId).toBeFalsy()
  const dispatched = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
  expect(dispatched).toHaveLength(operation === 'fork' ? 1 : 0)
}, 120_000)

it.each([['missing', 'claude'], ['stalled', 'codex']] as const)(
  '%s shared hooks: ready, native files installed, OpenCode launch and %s Stop/resume work', async (mode, engine) => {
    const lean = readLeanBundle(readFileSync(bundle))!
    const files = Object.fromEntries([...lean.files].map(([name, value]) => [name, value.toString('utf8')]))
    const chunks = Object.keys(files).filter(name => /^core-hooks-/.test(name))
    expect(chunks).toHaveLength(1)
    if (mode === 'missing') delete files[chunks[0]!]
    else files[chunks[0]!] = "console.error('[fixture] legacy hooks stalled'); await new Promise(() => {});\n"
    const script = join(scratch, mode, 'cli.js'); mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, withLean(readFileSync(bundle, 'utf8'), files), { mode: 0o755 })
    const d = daemon = await IsolatedDaemon.create({ scriptPath: script, env: { HARNESS_CONNECTIONS_PORT: '0' } })
    onTestFailed(() => console.log(d.log()))
    const root = join(d.root, 'native')
    const homes: Record<string, string> = {
      CURSOR_CONFIG_DIR: join(root, 'cursor'), CURSOR_DATA_DIR: join(root, 'cursor-data'),
      OPENCODE_PLUGIN_DIR: join(root, 'opencode', 'plugin'), OPENCODE_DATA_DIR: join(root, 'opencode-data'),
      KILO_PLUGIN_DIR: join(root, 'kilo', 'plugin'), PI_HOME: join(root, 'pi'),
      AMP_PLUGIN_DIR: join(root, 'amp', 'plugins'), AMP_SESSIONS_DIR: join(root, 'amp-sessions'),
      HERMES_HOME: join(root, 'hermes'), DEVIN_CONFIG_PATH: join(root, 'devin', 'config.json'),
      COMMANDCODE_HOME: join(root, 'commandcode'), GROK_HOME: join(root, 'grok'),
      AGY_CONFIG_DIR: join(root, 'agy'), COPILOT_HOME: join(root, 'copilot'),
    }
    Object.assign(d.env, homes, { HOOK_INSTALL_ENGINES: 'claude,codex,cursor,opencode,kilo,pi,amp,hermes,devin,commandcode,grok,agy,copilot' })
    mkdirSync(homes.HERMES_HOME!, { recursive: true })
    writeFileSync(join(homes.HERMES_HOME!, 'config.yaml'), 'model: fixture\n')
    const binary = join(d.root, 'bin', 'opencode'); d.env.OPENCODE_PATH = binary
    writeFileSync(binary, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('opencode v2.0.18'); process.exit(0) }
if (process.argv.includes('--help')) { console.log('--auto --session'); process.exit(0) }
process.title = ('opencode --session ses_' + process.pid).padEnd(160);
console.log('┃'); setInterval(() => {}, 1000);
`, { mode: 0o755 })
    await d.start()
    expect(d.log()).not.toContain('[fixture] legacy hooks stalled')
    const c = client = await LocalClient.connect(d)
    const row = async (id: string) => ((await c.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>).find(one => one.id === id)
    const active = (id: string) => until('a native process to bind without optional hooks', async () => {
      const agent = await row(id); return agent?.status === 'active' && agent.sessionId ? agent : null
    }, 30_000, 100)
    const create = async (kind: string) => {
      const cwd = join(d.projectsDir, kind); mkdirSync(cwd)
      const result = await c.request('agent_create', { engine: kind, cwd, bypassPermission: true }, 30_000)
      expect(result.error, JSON.stringify(result)).toBeUndefined()
      return active(result.agent.id)
    }
    // Readiness must permit a cold launch while startup maintenance is still finishing.
    const native = await create('opencode')
    const hookFiles = ['cursor/hooks.json', 'opencode/plugins/launcher-register/tui.js', 'kilo/plugin/launcher-register.js',
      'pi/agent/extensions/launcher-register.ts', 'amp/plugins/launcher-register.ts', 'hermes/config.yaml',
      'devin/config.json', 'commandcode/settings.json', 'grok/hooks/harness.json', 'agy/hooks.json', 'copilot/hooks/harness.json']
    await until('all selected native hooks to finish after readiness', () => hookFiles.every(file => {
      try { return readFileSync(join(root, file), 'utf8').includes(String(d.port)) } catch { return false }
    }), 10_000)
    for (const file of hookFiles) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain(String(d.port))
    }
    const sibling = await create(engine)
    const started = c.next(frame => frame.type === 'turn_started' && frame.agentId === sibling.id, 30_000)
    c.send('message', { agentId: sibling.id, content: '!slow 8000' }); await started
    expect((await c.request('agent_delete', { agentId: sibling.id }, 45_000)).error).toBeUndefined()
    await until('Stop preserves the conversation', async () => (await row(sibling.id))?.status === 'stopped', 20_000)
    expect((await c.request('agent_resume', { agentId: sibling.id }, 45_000)).error).toBeUndefined()
    expect((await active(sibling.id)).sessionId).toBe(sibling.sessionId)
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === sibling.id, 30_000)
    c.send('message', { agentId: sibling.id, content: 'after isolated hooks' }); await ended
    expect((await active(native.id)).sessionId).toBe(native.sessionId)
    expect(d.coresStarted()).toBe(1)
    expect((await fetch(`http://127.0.0.1:${d.port}/api/health`)).ok).toBe(true)
  }, 150_000)
