/** Private daemon, hook credential, process, tmux and Hermes home throughout. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, onTestFailed } from 'vitest'
import { readLeanBundle } from '../src/harnessd/leanBundle.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { withLean } from './harness/release.js'

let daemon: IsolatedDaemon | undefined
let client: LocalClient | undefined
let scratch: string, bundle: string
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hermes-admission-bundle-'))
  bundle = join(scratch, 'build', 'cli.js')
  execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT,
    env: { ...process.env, BUNDLE_OUT_DIR: dirname(bundle) }, stdio: 'pipe' })
}, 120_000)
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

it.each(['missing', 'stalled'] as const)('keeps Hermes admission pending and core ready with %s optional code, then recovers the complete store pool', async mode => {
  const text = readFileSync(bundle, 'utf8')
  const lean = readLeanBundle(Buffer.from(text))!
  const files = Object.fromEntries([...lean.files].map(([name, value]) => [name, value.toString('utf8')]))
  const chunks = Object.keys(files).filter(name => name.startsWith('core-inProcess-') && files[name]!.includes('HermesReader'))
  expect(chunks).toHaveLength(1)
  if (mode === 'missing') delete files[chunks[0]!]
  else files[chunks[0]!] = "console.error('[fixture] Hermes reader stalled'); await new Promise(() => {});\n"
  const scriptPath = join(scratch, mode, 'cli.js')
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, withLean(text, files), { mode: 0o755 })
  const d = daemon = await IsolatedDaemon.create({ scriptPath })
  onTestFailed(() => console.log(d.log()))
  d.env.HERMES_HOME = join(d.root, 'hermes')
  d.env.HERMES_PATH = join(d.root, 'bin', 'hermes')
  mkdirSync(d.env.HERMES_HOME)
  const database = join(d.env.HERMES_HOME, 'state.db')
  writeFileSync(database, 'unreadable SQLite fixture')
  writeFileSync(d.env.HERMES_PATH, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0) }
process.title = 'hermes'.padEnd(16)
require('node:fs').writeFileSync(${JSON.stringify(join(d.root, 'hermes.pid'))}, String(process.pid))
console.log('fake-hermes-ready\\n>')
setInterval(() => {}, 1000)
`, { mode: 0o755 })
  const cwd = join(d.projectsDir, 'hermes'); mkdirSync(cwd, { recursive: true })
  await d.start()
  const c = client = await LocalClient.connect(d)
  const created = await c.request('agent_create', { engine: 'hermes', cwd, bypassPermission: true }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId: string = created.agent.id
  const pane = String(created.agent.terminal?.runtimes?.[0]?.paneId ?? created.agent.tmuxPane)
  await until('the fixture process', async () => (await d.capture(pane)).includes('fake-hermes-ready') || null, 15_000, 100)
  const callerPid = Number(readFileSync(join(d.root, 'hermes.pid'), 'utf8'))
  const hook = async (sessionId: string) => {
    const response = await fetch(`http://127.0.0.1:${d.port}/api/hook/session-start`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-hook-token': d.hookCredential() },
      body: JSON.stringify({ engine: 'hermes', sessionId, tmuxPane: pane, cwd, callerPid, hookEvent: 'SessionStart' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pending: true })
  }
  const row = async () => (await c.request('agents_list', {})).agents.find((agent: { id: string }) => agent.id === agentId)
  const child = '20261009_120000_aaaaaa', own = '20261009_120001_bbbbbb'
  await hook(own)
  await until('an explicit source hold', () => d.log().includes('held · Hermes session source is unavailable') || null, 10_000, 100)
  // A delegated hook on the same pane must not erase its parent's held intent.
  await hook(child)
  expect((await row()).sessionId).toBeFalsy()
  expect(readFileSync(database, 'utf8')).toBe('unreadable SQLite fixture')
  expect((await fetch(`http://127.0.0.1:${d.port}/api/health`)).ok).toBe(true)
  // Replace only this test's corrupt fixture. An old started_at prevents directory repair from
  // guessing either conversation; these admissions must go through the authenticated hook path.
  rmSync(database)
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: string[]): void }; close(): void }
  }
  const db = new DatabaseSync(database)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, started_at REAL);'
    + 'CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, finish_reason TEXT, reasoning TEXT);')
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, 0)')
  insert.run(child, 'tool', cwd); insert.run(own, 'cli', cwd); db.close()
  const profile = join(d.env.HERMES_HOME, 'profiles', 'later')
  mkdirSync(profile, { recursive: true })
  const otherStore = join(profile, 'state.db')
  writeFileSync(otherStore, 'unreadable competing profile')
  // A healthy default row cannot bypass a later unavailable home, even with optional readers gone.
  await new Promise(resolve => setTimeout(resolve, 1_200))
  expect((await row()).sessionId).toBeFalsy()
  expect((await fetch(`http://127.0.0.1:${d.port}/api/health`)).ok).toBe(true)
  rmSync(otherStore)
  const competing = new DatabaseSync(otherStore)
  competing.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, started_at REAL)')
  competing.prepare('INSERT INTO sessions VALUES (?, ?, ?, 0)').run(own, 'cli', cwd)
  competing.close()
  await until('automatic source recheck to reject the child', () => d.log().includes('ignored · hermes_subagent') || null, 10_000, 100)
  await until('complete but ambiguous parent pool', () => d.log().includes('ambiguous across homes') || null, 10_000, 100)
  expect((await row()).sessionId).toBeFalsy()
  const resolved = new DatabaseSync(otherStore)
  resolved.exec('DELETE FROM sessions'); resolved.close()
  await until('automatic parent binding after rejecting the child', async () => (await row()).sessionId === own || null, 10_000, 100)
  expect(d.coresStarted()).toBe(1)
}, 90_000)
