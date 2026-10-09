/** Real core and process discovery with optional native modules absent or unable to finish loading. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, onTestFailed } from 'vitest'
import { readLeanBundle } from '../src/harnessd/leanBundle.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { withLean } from './harness/release.js'

let scratch = '', bundle = ''
let daemon: IsolatedDaemon | undefined
let client: LocalClient | undefined
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'eager-identity-'))
  bundle = join(scratch, 'build', 'cli.js')
  execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT,
    env: { ...process.env, BUNDLE_OUT_DIR: dirname(bundle) }, stdio: 'pipe' })
}, 120_000)
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

it.each(['missing', 'stalled'] as const)('binds, follows Copilot resume and locates a Cursor transcript with %s optional modules', async mode => {
  const lean = readLeanBundle(readFileSync(bundle))!
  const files = Object.fromEntries([...lean.files].map(([name, value]) => [name, value.toString('utf8')]))
  for (const marker of ['CopilotNormalizer', 'CursorNormalizer']) {
    const chunks = Object.keys(files).filter(name => name.startsWith('core-inProcess-') && files[name]!.includes(marker))
    expect(chunks, marker).toHaveLength(1)
    if (mode === 'missing') delete files[chunks[0]!]
    else files[chunks[0]!] = `console.error('[fixture] ${marker} stalled'); await new Promise(() => {});\n`
  }
  const script = join(scratch, mode, 'cli.js')
  mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, withLean(readFileSync(bundle, 'utf8'), files), { mode: 0o755 })
  const d = daemon = await IsolatedDaemon.create({ scriptPath: script, env: { HARNESS_CONNECTIONS_PORT: '0' } })
  onTestFailed(() => console.log(d.log()))
  const first = 'aaaaaaaa-1111-4222-8333-444444444444', next = 'bbbbbbbb-1111-4222-8333-444444444444'
  d.env.COPILOT_HOME = join(d.root, 'copilot')
  d.env.CURSOR_HOME = join(d.root, 'cursor')
  const cwd = join(d.projectsDir, 'native'); mkdirSync(cwd)
  for (const engine of ['copilot', 'cursor'] as const) {
    const path = join(d.root, 'bin', engine)
    d.env[`${engine.toUpperCase()}_PATH`] = path
    writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('1.0.0 --force'); process.exit(0) }
process.title = ${JSON.stringify(engine)}.padEnd(120);
fs.writeFileSync(${JSON.stringify(join(d.root, `${engine}.pid`))}, String(process.pid));
${engine === 'copilot' ? `const folder = path.join(process.env.COPILOT_HOME, 'session-state', '${first}');
fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'inuse.' + process.pid + '.lock'), '');
fs.writeFileSync(path.join(folder, 'events.jsonl'), JSON.stringify({type:'session.start', data:{context:{cwd:process.cwd()}}}) + '\\n');` : ''}
console.log('fixture-${engine}-ready'); setInterval(() => {}, 1000);
`, { mode: 0o755 })
  }
  await d.start()
  const c = client = await LocalClient.connect(d)
  const rows = async () => (await c.request('agents_list', {})).agents as Array<Record<string, any>>
  const create = async (engine: string) => {
    const response = await c.request('agent_create', { engine, cwd, bypassPermission: true }, 60_000)
    expect(response.error, JSON.stringify(response)).toBeUndefined()
    return response.agent as Record<string, any>
  }
  const copilot = await create('copilot')
  await until('Copilot binding from its lock with no optional reader', async () => (await rows()).find(row => row.id === copilot.id)?.sessionId === first || null, 30_000, 100)
  const pid = Number(readFileSync(join(d.root, 'copilot.pid'), 'utf8'))
  const unknown = join(d.env.COPILOT_HOME, 'session-state', '99999999-1111-4222-8333-444444444444', `inuse.${pid}.lock`)
  mkdirSync(unknown, { recursive: true })
  const folder = join(d.env.COPILOT_HOME, 'session-state', next); mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { context: { cwd } } }) + '\n')
  const lock = join(folder, `inuse.${pid}.lock`); writeFileSync(lock, '')
  const newer = new Date(Date.now() + 2000); utimesSync(lock, newer, newer)
  // A competing native location that cannot be read must retain the old binding,
  // without stopping discovery of the Cursor siblings below.
  await until('Copilot binding held for its incomplete lock pool', () => d.log().includes('binding held · Conversation identity is held: a native identity location is not a regular file'), 30_000, 100)
  expect((await rows()).find(row => row.id === copilot.id)?.sessionId).toBe(first)
  // The two Copilot bindings already occupy reader slots. Three more pending Cursor sessions
  // saturate the four-slot pool before the final Cursor is asked to locate its transcript.
  const cursorId = 'cccccccc-1111-4222-8333-444444444444'
  for (const id of ['dddddddd', 'eeeeeeee', 'ffffffff', 'cccccccc']) {
    const cursor = await create('cursor')
    const pane = String(cursor.terminal?.runtimes?.[0]?.paneId ?? cursor.tmuxPane)
    await until('the private Cursor process', async () => (await d.capture(pane)).includes('fixture-cursor-ready') || null, 15_000, 100)
    const callerPid = Number(readFileSync(join(d.root, 'cursor.pid'), 'utf8'))
    const sessionId = `${id}-1111-4222-8333-444444444444`
    const hook = await fetch(`http://127.0.0.1:${d.port}/api/hook/session-start`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-hook-token': d.hookCredential() },
      body: JSON.stringify({ engine: 'cursor', sessionId, cwd, tmuxPane: pane, callerPid, hookEvent: 'SessionStart' }),
    })
    expect(hook.status).toBe(200)
    await until('the binding is visible before optional attachment completes', async () =>
      (await rows()).find(row => row.id === cursor.id)?.sessionId === sessionId || null, 5000, 100)
  }
  const heldCursorId = 'dddddddd-1111-4222-8333-444444444444'
  const transcript = join(d.env.CURSOR_HOME, 'projects', 'p', 'agent-transcripts', heldCursorId, `${heldCursorId}.jsonl`)
  // The first candidate's native read fails while a sibling's transcript is ready.
  // Neither optional readers nor this failed location may own the polling loop.
  mkdirSync(transcript, { recursive: true })
  const siblingId = cursorId
  const siblingTranscript = join(d.env.CURSOR_HOME, 'projects', 'p', 'agent-transcripts', siblingId, `${siblingId}.jsonl`)
  mkdirSync(dirname(siblingTranscript), { recursive: true }); writeFileSync(siblingTranscript, '{}\n')
  await until('the pending Cursor native read to hold', () => d.log().includes(`transcript ${heldCursorId} held`), 15_000, 100)
  await until('the sibling transcript to publish while another lookup is held', () =>
    readFileSync(join(d.dataDir, 'registry.json'), 'utf8').includes(siblingTranscript), 15_000, 100)
  rmdirSync(transcript); writeFileSync(transcript, '{}\n')
  await until('Cursor location committed while its optional reader is unavailable', () => {
    const registry = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8'))
    return JSON.stringify(registry).includes(transcript) || null
  }, 15_000, 100)
  rmdirSync(unknown)
  await until('Copilot in-process resume after its native pool recovers', async () => (await rows()).find(row => row.id === copilot.id)?.sessionId === next || null, 30_000, 100)
  expect((await fetch(`http://127.0.0.1:${d.port}/api/health`)).ok).toBe(true)
  expect(d.coresStarted()).toBe(1)
}, 120_000)
