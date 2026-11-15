/** Other-engine profiles, permissions, and terminal/Stop isolation through the published daemon boundary. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LEAN_CORE_ENTRY, readLeanBundle } from '../src/harnessd/leanBundle.js'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'
import { buildWithLean } from './harness/release.js'

const SESSION = 'dddddddd-2222-4333-8444-555555555555'
const profile = (agent: string, effort = 'high') => `runtime-v1:${encodeURIComponent(agent)}:cursor:model-7@${effort}`
const permission = ['────────────────────────────', ' $ printf fixture in .', '', ' Run this command?',
  ' Not in allowlist: printf', ' → Run (once) (y)', ' Skip & tell the agent what to do instead (esc or n)'].join('\n')
type Row = { id: string; sessionId: string; status: string; tmuxPane: string; selectedModel?: string | null }

// The same checked bundle is used for the normal, damaged-core, older-master and explicit-inline paths.
describe.runIf(!!process.env.E2E_BUNDLE_PATH)('other-engine runtime and question isolation', () => {
  let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined, scratch: string | undefined
  afterEach(async () => {
    client?.close(); await daemon?.close(); client = undefined; daemon = undefined
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })
  const worker = (d: IsolatedDaemon) => harnessdProcesses(d).get('engine-others')
  const rows = async (c: LocalClient) => (await c.request('agents_list', { includeStopped: true })).agents as Row[]
  const row = async (c: LocalClient, id: string) => (await rows(c)).find(value => value.id === id)
  function modified(change: (files: Record<string, string>) => void): string {
    const bundle = process.env.E2E_BUNDLE_PATH!
    const files = Object.fromEntries([...readLeanBundle(readFileSync(bundle))!.files].map(([name, bytes]) => [name, bytes.toString('utf8')]))
    change(files)
    scratch = mkdtempSync(join(tmpdir(), 'other-runtime-controls-'))
    return buildWithLean(scratch, bundle, files)
  }
  async function fresh(env: Record<string, string> = {}, scriptPath = process.env.E2E_BUNDLE_PATH!) {
    const d = daemon = await IsolatedDaemon.create({ scriptPath, env: {
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env,
    } })
    onTestFailed(() => console.log(d.log()))
    d.env.CURSOR_HOME = join(d.root, 'cursor')
    d.env.CURSOR_CONFIG_DIR = d.env.CURSOR_HOME; d.env.CURSOR_DATA_DIR = d.env.CURSOR_HOME
    d.env.HOOK_INSTALL_ENGINES = 'claude,codex,cursor'
    const bin = join(d.root, 'bin', 'cursor-agent'); d.env.CURSOR_PATH = bin
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('2026.08.11'); process.exit(0) }
const id = ${JSON.stringify(SESSION)}, cwd = process.cwd();
process.title = ('cursor-agent --session-id ' + id).padEnd(160);
const file = path.join(process.env.CURSOR_HOME, 'projects', 'fixture', 'agent-transcripts', id + '.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ type: 'assistant', model: 'model-7', sessionId: id, cwd, uuid: 'ready',
 message: { role: 'assistant', content: [{ type: 'text', text: 'fixture ready' }] } }) + '\\n');
fs.writeFileSync(${JSON.stringify(join(d.root, 'cursor.json'))}, JSON.stringify({ pid: process.pid, file }));
fs.writeFileSync(${JSON.stringify(join(d.root, 'keys.txt'))}, '');
fs.writeFileSync(${JSON.stringify(join(d.root, 'choices.txt'))}, '');
let asking = false;
const idle = text => { process.stdout.write('\\x1b[2J\\x1b[H' + text + '\\nModel 7 High · 1%\\n'); };
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
process.stdin.on('data', data => { for (const key of data) {
 fs.appendFileSync(${JSON.stringify(join(d.root, 'keys.txt'))}, key);
 if (key === '\\x03') process.exit(0);
 if (key === 'q') { asking = true; process.stdout.write('\\x1b[2J\\x1b[H' + ${JSON.stringify(permission)} + '\\n'); }
 else if (asking && (key === 'y' || key === 'n')) { asking = false; fs.appendFileSync(${JSON.stringify(join(d.root, 'choices.txt'))}, key); idle('fixture choice ' + key); }
 else if (key === 't') process.stdout.write('\\nfixture terminal input\\n');
} });
idle('fixture-cursor-ready');
`, { mode: 0o755 })
    await d.start()
    const c = client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'cursor'); mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine: 'cursor', cwd, permissionMode: 'ask', bypassPermission: false }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const id = created.agent.id as string
    const pane = await until('Cursor pane created', async () => (await row(c, id))?.tmuxPane
      ?? created.agent.terminal?.runtimes?.[0]?.paneId ?? null, 15_000, 100)
    await until('the private Cursor ready', async () => (await d.capture(pane)).includes('fixture-cursor-ready') || null, 20_000, 100)
    const fake = JSON.parse(readFileSync(join(d.root, 'cursor.json'), 'utf8')) as { pid: number; file: string }
    const hook = await fetch(`http://127.0.0.1:${d.port}/api/hook/session-start`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-hook-token': d.hookCredential() },
      body: JSON.stringify({ engine: 'cursor', sessionId: SESSION, transcriptPath: fake.file, cwd, tmuxPane: pane,
        callerPid: fake.pid, runtimeHints: [{ backend: 'tmux', paneId: pane }] }) })
    expect(hook.status).toBe(200)
    await until('Cursor profile from its pane', async () => (await row(c, id))?.selectedModel === profile(id) || null, 30_000, 100)
    return { d, c, id, pane }
  }
  async function question(d: IsolatedDaemon, c: LocalClient, id: string, pane: string): Promise<Frame> {
    const asked = c.next(frame => frame.type === 'commander_question' && frame.agentId === id, 30_000, 'Cursor permission')
    await d.tmux.run('send-keys', '-t', pane, '-l', 'q')
    return asked
  }
  async function answer(c: LocalClient, id: string, asked: Frame): Promise<Record<string, any>> {
    const payload = asked.payload!, item = payload.questions[0]
    const reply = c.next(frame => frame.type === 'question_response_result' && frame.payload?.requestId === payload.requestId, 15_000, 'permission answer')
    c.send('question_response', { requestId: payload.requestId, agentId: id, answers: { [item.q]: item.options.find((option: string) => option.startsWith('Skip')) } })
    return (await reply).payload!
  }
  async function terminal(c: LocalClient, id: string) {
    const requestId = 'runtime-controls-terminal', since = c.binaries.length
    const pending = c.next(frame => ['terminal_ready', 'terminal_error'].includes(frame.type) && frame.payload?.requestId === requestId, 20_000, 'terminal open')
    c.send('terminal_open', { requestId, protocolVersion: 3, agentId: id, cols: 100, rows: 30 })
    const ready = await pending
    expect(ready.type, JSON.stringify(ready.payload)).toBe('terminal_ready')
    const streamId = String(ready.payload!.streamId)
    await c.waitForBinary(frame => frame.streamId === streamId && frame.kind === TerminalBinaryKind.keyframe, 20_000, 'terminal screen', since)
    return () => c.sendBinary({ kind: TerminalBinaryKind.input, streamId, seq: 0, compressed: false, bytes: Buffer.from('t') })
  }
  async function viewOnly(c: LocalClient, id: string) {
    expect((await c.request('models_list', { agentId: id }, 5000)).models).toEqual([])
    expect(await c.request('agent_update', { agentId: id, selectedModel: profile(id, 'low') }, 5000)).toMatchObject({ error: 'UNSUPPORTED_CLI_VERSION' })
  }
  async function stop(d: IsolatedDaemon, c: LocalClient, id: string) {
    const result = await c.request('agent_delete', { agentId: id }, 5000)
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    await until('Stop completed with core alive', async () => (await row(c, id))?.status === 'stopped' || null, 10_000, 100)
    expect(d.coresStarted()).toBe(1)
  }

  it.each(['missing', 'stalled'] as const)('reads profiles and answers permissions with %s core-side optional readers', async mode => {
    const script = modified(files => {
      const chunks = Object.keys(files).filter(name => name.startsWith('core-legacyScreen-')
        || (name.startsWith('core-inProcess-') && files[name].includes('CursorNormalizer')))
      expect(chunks).toHaveLength(2)
      for (const name of chunks) {
        if (mode === 'missing') delete files[name]
        else files[name] = "console.error('[fixture] core optional reader loaded'); await new Promise(() => {});\n"
      }
    })
    const { d, c, id, pane } = await fresh({}, script)
    const asked = await question(d, c, id, pane)
    expect(asked.payload!.questions[0].q).toBe('Approve printf fixture')
    expect((await answer(c, id, asked)).error).toBeUndefined()
    await until('only the approved hint reached Cursor', () => readFileSync(join(d.root, 'choices.txt'), 'utf8') === 'n' || null, 10_000, 100)
    await viewOnly(c, id)
    expect(d.log()).not.toContain('[fixture] core optional reader loaded')
    await stop(d, c, id)
  }, 120_000)

  it.each(['SIGKILL', 'SIGSTOP'] as const)('keeps terminal input, view-only models and Stop usable with the worker %s', async signal => {
    const { d, c, id, pane } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '30000', HARNESSD_SERVICE_STOP_GRACE_MS: '100',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '10000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '10000' })
    const asked = await question(d, c, id, pane)
    const type = await terminal(c, id)
    const before = worker(d)!
    expect(before).toBeGreaterThan(0)
    process.kill(before, signal)
    const pending = answer(c, id, asked)
    type()
    await until('terminal input reached the still-running engine', () => readFileSync(join(d.root, 'keys.txt'), 'utf8').includes('t') || null, 3000, 50)
    await viewOnly(c, id)
    expect((await pending).error).toBeTruthy()
    expect(readFileSync(join(d.root, 'choices.txt'), 'utf8')).toBe('')
    expect((await row(c, id))?.selectedModel).toBe(profile(id))
    if (signal === 'SIGSTOP') expect(worker(d)).toBe(before)
    await stop(d, c, id)
    if (signal === 'SIGSTOP') {
      expect(worker(d)).toBe(before) // Stop completed while the same worker was still frozen.
      process.kill(before, 'SIGKILL')
    }
    await until('the supervised worker replaced', () => { const pid = worker(d); return pid && pid !== before ? pid : null }, 30_000, 100)
  }, 120_000)

  it.each(['inline', 'protocol-1', 'protocol-2'] as const)('preserves %s compatibility', async mode => {
    const script = mode === 'inline' ? process.env.E2E_BUNDLE_PATH! : modified(files => {
      const version = mode === 'protocol-1' ? 1 : 2
      files[LEAN_CORE_ENTRY] = `process.env.HARNESSD_ENGINE_OTHERS = process.env.HARNESSD_ENGINE_OTHERS?.replace(/:[0-9]+$/, ':${version}');\n` + files[LEAN_CORE_ENTRY]
    })
    const { d, c, id, pane } = await fresh(mode === 'inline' ? { HARNESSD_SERVICES: 'none' } : {}, script)
    expect((await answer(c, id, await question(d, c, id, pane))).error).toBeUndefined()
    await viewOnly(c, id)
    if (mode === 'inline') expect(worker(d)).toBeUndefined()
    await stop(d, c, id)
  }, 120_000)
})
