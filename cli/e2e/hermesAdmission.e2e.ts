/** Private daemon, hook credential, process, tmux and Hermes home throughout. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined
let client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

it('holds unverified Hermes hooks while core remains ready, then rejects a child and admits a verified conversation', async () => {
  const d = daemon = await IsolatedDaemon.create()
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
  await until('automatic source recheck to reject the child', () => d.log().includes('ignored · hermes_subagent') || null, 10_000, 100)
  await until('automatic parent binding after rejecting the child', async () => (await row()).sessionId === own || null, 10_000, 100)
  expect(d.coresStarted()).toBe(1)
}, 90_000)
