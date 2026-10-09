/** Startup and pre-spawn hook preparation cannot wait for the obsolete shared optional installer. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, onTestFailed } from 'vitest'
import { readLeanBundle } from '../src/harnessd/leanBundle.js'
import { LocalClient } from './harness/client.js'
import { assertHooksContained, CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { withLean } from './harness/release.js'

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
    for (const file of ['cursor/hooks.json', 'opencode/plugins/launcher-register/tui.js', 'kilo/plugin/launcher-register.js',
      'pi/agent/extensions/launcher-register.ts', 'amp/plugins/launcher-register.ts', 'hermes/config.yaml',
      'devin/config.json', 'commandcode/settings.json', 'grok/hooks/harness.json', 'agy/hooks.json', 'copilot/hooks/harness.json']) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain(String(d.port))
    }
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
    const native = await create('opencode')
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
