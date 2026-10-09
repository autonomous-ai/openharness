/** Real launch dispatch keeps working without OpenCode's optional interpretation chunk. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, onTestFailed } from 'vitest'
import { readLeanBundle } from '../src/harnessd/leanBundle.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { withLean } from './harness/release.js'

let scratch = '', bundle = ''
let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'eager-opencode-'))
  bundle = join(scratch, 'build', 'cli.js')
  execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT,
    env: { ...process.env, BUNDLE_OUT_DIR: dirname(bundle) }, stdio: 'pipe' })
}, 120_000)
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

it.each([['missing', 1], ['stalled', 1], ['missing', 2], ['stalled', 2]] as const)(
  'OpenCode with %s optional code, v%s: create, fork, restart, retarget and Stop/resume', async (mode, major) => {
    const lean = readLeanBundle(readFileSync(bundle))!
    const files = Object.fromEntries([...lean.files].map(([name, value]) => [name, value.toString('utf8')]))
    const chunks = Object.keys(files).filter(name => name.startsWith('core-inProcess-') && files[name]!.includes('OpencodeReader'))
    expect(chunks).toHaveLength(1)
    if (mode === 'missing') delete files[chunks[0]!]
    else files[chunks[0]!] = "console.error('[fixture] OpenCode reader stalled'); await new Promise(() => {});\n"
    const script = join(scratch, `${mode}-${major}`, 'cli.js'); mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, withLean(readFileSync(bundle, 'utf8'), files), { mode: 0o755 })
    const d = daemon = await IsolatedDaemon.create({ scriptPath: script, env: { HARNESS_CONNECTIONS_PORT: '0' } })
    onTestFailed(() => console.log(d.log()))
    const binary = join(d.root, 'bin', 'opencode'), launches = join(d.root, 'launches.jsonl')
    d.env.OPENCODE_PATH = binary
    d.env.OPENCODE_DATA_DIR = join(d.root, 'opencode', 'data')
    d.env.OPENCODE_PLUGIN_DIR = join(d.root, 'opencode', 'plugin')
    writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('opencode v${major}.0.18'); process.exit(0) }
if (args.includes('--help')) { console.log('--auto --session --prompt --agent'); process.exit(0) }
if (args[0] === 'models') { console.log('fixture/model'); process.exit(0) }
const id = args.includes('--session') ? args[args.indexOf('--session') + 1] : 'ses_' + process.pid;
process.title = ('opencode --session ' + id).padEnd(160);
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({id,args,pid:process.pid}) + '\\n');
console.log('fixture-opencode-ready'); console.log('┃');
setInterval(() => {}, 1000);
`, { mode: 0o755 })
    await d.start()
    const c = client = await LocalClient.connect(d)
    const rows = async () => (await c.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>
    const active = (id: string) => until('OpenCode binds without its reader', async () => {
      const row = (await rows()).find(row => row.id === id)
      return row?.status === 'active' && row.sessionId ? row : null
    }, 30_000, 100)
    const records = () => readFileSync(launches, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<{id: string; args: string[]; pid: number}>
    const cwd = join(d.projectsDir, 'native'); mkdirSync(cwd)
    if (major === 2) {
      const named = await c.request('agent_create', { engine: 'opencode', cwd, agent: 'reviewer' }, 30_000)
      expect(named.error).toBe('AGENT_UNSUPPORTED')
    }
    const created = await c.request('agent_create', { engine: 'opencode', cwd, ...(major === 1 ? { agent: 'reviewer' } : {}) }, 30_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const source = await active(created.agent.id)
    expect(records()[0]!.args.includes('--agent')).toBe(major === 1)
    const forked = await c.request('agent_fork', { agentId: source.id, name: 'copy', prompt: 'fixture follow-up' }, 30_000)
    expect(forked.error, JSON.stringify(forked)).toBeUndefined()
    const child = await active(forked.agent?.id ?? forked.agentId ?? forked.session?.agentId)
    expect(child.sessionId).not.toBe(source.sessionId)
    const childLaunch = records().find(one => one.id === child.sessionId)!
    expect(childLaunch.args.includes('--agent')).toBe(major === 1)
    expect(childLaunch.args).toContain('--prompt')
    // A live upgrade must change relaunch flags even though no reader ever loaded. The saved
    // named agent is a v1 fact; the new v2 executable must not receive its rejected --agent flag.
    if (major === 1) writeFileSync(binary, readFileSync(binary, 'utf8').replace('opencode v1.0.18', 'opencode v2.0.18') + '\n// upgraded fixture\n', { mode: 0o755 })
    for (const request of ['agent_restart', 'agent_retarget']) {
      const before = records().filter(one => one.id === source.sessionId).length
      const result = await c.request(request, { agentId: source.id, ...(request === 'agent_retarget' ? { clearGrid: true } : {}) }, 45_000)
      expect(result.error, JSON.stringify(result)).toBeUndefined()
      await until('the replacement received the same conversation', () => records().filter(one => one.id === source.sessionId).length > before || null, 20_000, 100)
      const resumed = records().filter(one => one.id === source.sessionId).at(-1)!
      expect(resumed.args).toContain('--session')
      expect(resumed.args.includes('--agent')).toBe(false)
      expect((await active(source.id)).sessionId).toBe(source.sessionId)
    }
    const closed = await c.request('agent_close', { agentId: source.id, sessionId: source.sessionId, createdAt: source.createdAt, mode: 'now' }, 45_000)
    // This native-process fixture has an ID but no conversation rows. Close must hold before
    // its checkpoint; Stop can still preserve that ID and resume the same native process contract.
    expect(closed, JSON.stringify(closed)).toMatchObject({ error: 'HISTORY_NOT_SAVED' })
    expect((await active(source.id)).sessionId).toBe(source.sessionId)
    expect((await c.request('agent_delete', { agentId: source.id }, 45_000)).error).toBeUndefined()
    await until('Stop preserves the conversation', async () => {
      const row = (await rows()).find(row => row.id === source.id)
      return row?.status === 'stopped' && row.sessionId === source.sessionId ? row : null
    }, 20_000, 100)
    expect((await c.request('agent_resume', { agentId: source.id }, 45_000)).error).toBeUndefined()
    expect((await active(source.id)).sessionId).toBe(source.sessionId)
    expect((await active(child.id)).sessionId).toBe(child.sessionId)
    expect((await fetch(`http://127.0.0.1:${d.port}/api/health`)).ok).toBe(true)
    expect(d.coresStarted()).toBe(1)
  }, 180_000)
