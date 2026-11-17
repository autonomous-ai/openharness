import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deleteHermesSession, deleteOpenclawSession, hermesHolds, openclawKeys, runCommand, type RunCommand } from './forget.js'

const KEY = 'agent:main:harness-a1'
const answer = (body: Record<string, unknown>, code: number | null = 0): RunCommand => async () => ({ code, stdout: JSON.stringify(body, null, 2), stderr: '' })

describe('openclawKeys', () => {
  it('is the key Harness launched it with, and the one it is bound to after a /new', () => {
    expect(openclawKeys('a1', 'agent:main:tui-9f')).toEqual([KEY, 'agent:main:tui-9f'])
    expect(openclawKeys('a1', KEY)).toEqual([KEY])
    expect(openclawKeys('a1', '')).toEqual([KEY])
    expect(openclawKeys('a1', null)).toEqual([KEY])
  })
})

describe('deleteOpenclawSession', () => {
  it('asks the Gateway to delete the session and its transcript, and says the archive OpenClaw keeps', async () => {
    const run = vi.fn<RunCommand>(answer({ ok: true, key: KEY, deleted: true, archived: ['/s/x.jsonl.deleted'] }))
    expect(await deleteOpenclawSession(KEY, run)).toEqual({ key: KEY, state: 'deleted', detail: 'OpenClaw keeps its transcript in its own archive of deleted sessions' })
    expect(run).toHaveBeenCalledWith('openclaw', ['gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key: KEY, deleteTranscript: true }), '--json', '--timeout', '10000'])
    expect(await deleteOpenclawSession(KEY, answer({ ok: true, deleted: true }))).toEqual({ key: KEY, state: 'deleted' })
    expect(await deleteOpenclawSession(KEY, answer({ ok: true, deleted: true, archived: [] }))).toEqual({ key: KEY, state: 'deleted' })
  })

  it('says none when the Gateway had no such session', async () => {
    expect(await deleteOpenclawSession(KEY, answer({ ok: true, deleted: false, archived: [] }))).toEqual({ key: KEY, state: 'none', detail: 'OpenClaw\'s Gateway had no such session' })
  })

  it('never names a key that is not a harness session, nor the agent\'s main one', async () => {
    const run = vi.fn<RunCommand>()
    expect(await deleteOpenclawSession('agent:main:main', run)).toMatchObject({ state: 'kept' })
    expect(await deleteOpenclawSession('s-a1', run)).toMatchObject({ state: 'kept', detail: 's-a1 is not a session Harness started, so it was not deleted' })
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps it, saying why, when the Gateway refused or did not answer', async () => {
    const said = async (ran: Awaited<ReturnType<RunCommand>>) => (await deleteOpenclawSession(KEY, async () => ran)).detail
    expect(await said({ code: 1, stdout: '', stderr: '\x1b[31mGateway call failed: Error: gateway closed (1006).\x1b[0m\n' }))
      .toBe('OpenClaw\'s Gateway did not delete it (Gateway call failed: Error: gateway closed (1006))')
    expect(await said({ code: 1, stdout: 'not json', stderr: '' })).toBe('OpenClaw\'s Gateway did not delete it (not json)')
    expect(await said({ code: 2, stdout: '', stderr: '' })).toBe('OpenClaw\'s Gateway did not delete it (openclaw exited with status 2)')
    expect(await said({ code: null, stdout: '', stderr: '' })).toBe('OpenClaw\'s Gateway did not delete it (openclaw could not be run)')
    expect(await said({ code: 0, stdout: '{ broken }', stderr: '' })).toMatch(/did not delete it \(\{ broken \}\)/)
    expect(await said({ code: 0, stdout: '}{', stderr: '' })).toMatch(/did not delete it/)
    expect(await said({ code: 0, stdout: '{"ok":false}', stderr: '' })).toMatch(/did not delete it/)
  })
})

describe('deleteHermesSession', () => {
  const ID = '20261117_120000_abc123'

  it('deletes it with Hermes\'s own delete once its store holds exactly that id', async () => {
    const run = vi.fn<RunCommand>(async () => ({ code: 0, stdout: `Deleted session '${ID}'.\n`, stderr: '' }))
    expect(await deleteHermesSession(ID, { run, holds: async () => true })).toEqual({ key: ID, state: 'deleted' })
    expect(run).toHaveBeenCalledWith('hermes', ['sessions', 'delete', '--yes', ID])
  })

  it('names nothing to Hermes when its store has no such id, or cannot be read: a prefix would be another session', async () => {
    const run = vi.fn<RunCommand>()
    expect(await deleteHermesSession(ID, { run, holds: async () => false })).toEqual({ key: ID, state: 'none', detail: 'Hermes\'s store has no such session' })
    expect(await deleteHermesSession(ID, { run, holds: async () => null })).toEqual({ key: ID, state: 'kept', detail: 'Hermes\'s store could not be read here, so nothing was deleted' })
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps it, saying why, when Hermes did not say it deleted it', async () => {
    const said = async (ran: Awaited<ReturnType<RunCommand>>) => (await deleteHermesSession(ID, { run: async () => ran, holds: async () => true })).detail
    expect(await said({ code: 1, stdout: `No session '${ID}'. Run: hermes sessions list to find the id.\n`, stderr: '' }))
      .toBe(`Hermes did not delete it (No session '${ID}'. Run: hermes sessions list to find the id)`)
    expect(await said({ code: 1, stdout: '', stderr: 'database is locked' })).toBe('Hermes did not delete it (database is locked)')
    expect(await said({ code: 0, stdout: 'Cancelled.', stderr: '' })).toBe('Hermes did not delete it (Cancelled)')
    expect(await said({ code: 3, stdout: '', stderr: '' })).toBe('Hermes did not delete it (hermes exited with status 3)')
    expect(await said({ code: null, stdout: '', stderr: '' })).toBe('Hermes did not delete it (hermes could not be run)')
  })

  it('reads the store at HERMES_HOME by default, and says when it cannot', async () => {
    const run = vi.fn<RunCommand>()
    expect(await deleteHermesSession(ID, { run })).toMatchObject({ key: ID })
    expect(await hermesHolds(ID, join(tmpdir(), 'no-such-hermes', 'state.db'))).toBeNull()
  })

  it('deletes with no deps at all, and runs hermes from the PATH', async () => {
    // The test's own empty home: a store that cannot be read, so nothing is run.
    expect(await deleteHermesSession('x')).toMatchObject({ key: 'x', state: 'kept' })
    const path = process.env.PATH
    process.env.PATH = tmpdir()
    try {
      expect(await deleteHermesSession(ID, { holds: async () => true })).toEqual({ key: ID, state: 'kept', detail: 'Hermes did not delete it (hermes is not on the PATH here)' })
    } finally { process.env.PATH = path }
  })
})

describe('hermesHolds', () => {
  it.skipIf(process.platform === 'win32')('reads whether the store holds exactly the id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-store-'))
    try {
      const database = join(dir, 'state.db')
      const { builtinSqlite } = await import('../lib/sqliteBuiltin.js')
      const Database = builtinSqlite()
      if (!Database) return
      const db = new Database(database, { readOnly: false })
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('abc123');")
      db.close()
      expect(await hermesHolds('abc123', database)).toBe(true)
      expect(await hermesHolds('abc', database)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('runCommand', () => {
  let bin: string
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'engine-bin-'))
    const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
    script('ok', 'echo "{\\"ok\\":true,\\"args\\":\\"$*\\"}"')
    script('fails', 'echo "Gateway call failed: no token" >&2; exit 3')
    script('silent', 'exit 4')
    script('slow', 'sleep 5')
  })
  afterAll(() => { rmSync(bin, { recursive: true, force: true }) })

  it.skipIf(process.platform === 'win32')('runs the command with its arguments, never through a shell, and says how it went', async () => {
    expect(await runCommand(join(bin, 'ok'), ['gateway', 'call'])).toEqual({ code: 0, stdout: '{"ok":true,"args":"gateway call"}\n', stderr: '' })
    expect(await runCommand(join(bin, 'fails'), [])).toEqual({ code: 3, stdout: '', stderr: 'Gateway call failed: no token\n' })
    expect((await runCommand(join(bin, 'silent'), [])).stderr).toMatch(/Command failed/)
    expect(await runCommand(join(bin, 'missing'), [])).toEqual({ code: null, stdout: '', stderr: 'missing is not on the PATH here' })
    expect(await runCommand(join(bin, 'slow'), [], 200)).toMatchObject({ code: null, stderr: 'slow did not answer within 0.2 s' })
  })

  it('runs a command from the PATH', async () => {
    const path = process.env.PATH
    process.env.PATH = bin
    try { expect(await runCommand('openclaw', [])).toMatchObject({ code: null, stderr: 'openclaw is not on the PATH here' }) } finally { process.env.PATH = path }
  })
})
