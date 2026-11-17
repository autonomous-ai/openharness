import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deleteOpenclawSession, openclawKey, runOpenclaw, type RunOpenclaw } from './forget.js'

const KEY = 'agent:main:harness-a1'
const answer = (body: Record<string, unknown>, code: number | null = 0): RunOpenclaw => async () => ({ code, stdout: JSON.stringify(body, null, 2), stderr: '' })

describe('openclawKey', () => {
  it('is the bound key, else the one Harness launched it with', () => {
    expect(openclawKey('a1', 'agent:work:harness-a1')).toBe('agent:work:harness-a1')
    expect(openclawKey('a1', '')).toBe(KEY)
    expect(openclawKey('a1', null)).toBe(KEY)
  })
})

describe('deleteOpenclawSession', () => {
  it('asks the Gateway to delete the session and its transcript, and says the archive OpenClaw keeps', async () => {
    const run = vi.fn<RunOpenclaw>(answer({ ok: true, key: KEY, deleted: true, archived: ['/s/x.jsonl.deleted'] }))
    expect(await deleteOpenclawSession(KEY, run)).toEqual({ state: 'deleted', detail: 'OpenClaw keeps its transcript in its own archive of deleted sessions' })
    expect(run).toHaveBeenCalledWith(['gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key: KEY, deleteTranscript: true }), '--json', '--timeout', '10000'])
    expect(await deleteOpenclawSession(KEY, answer({ ok: true, deleted: true }))).toEqual({ state: 'deleted' })
    expect(await deleteOpenclawSession(KEY, answer({ ok: true, deleted: true, archived: [] }))).toEqual({ state: 'deleted' })
  })

  it('says none when the Gateway had no such session', async () => {
    expect(await deleteOpenclawSession(KEY, answer({ ok: true, deleted: false, archived: [] }))).toEqual({ state: 'none', detail: 'OpenClaw\'s Gateway had no such session' })
  })

  it('never names a key that is not a harness session, nor the agent\'s main one', async () => {
    const run = vi.fn<RunOpenclaw>()
    expect(await deleteOpenclawSession('agent:main:main', run)).toMatchObject({ state: 'kept' })
    expect(await deleteOpenclawSession('s-a1', run)).toMatchObject({ state: 'kept', detail: 's-a1 is not a session Harness started, so it was not deleted' })
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps it, saying why, when the Gateway refused or did not answer', async () => {
    const said = async (ran: Awaited<ReturnType<RunOpenclaw>>) => (await deleteOpenclawSession(KEY, async () => ran)).detail
    expect(await said({ code: 1, stdout: '', stderr: '\x1b[31mGateway call failed: Error: gateway closed (1006)\x1b[0m\n' }))
      .toBe('OpenClaw\'s Gateway did not delete it (Gateway call failed: Error: gateway closed (1006))')
    expect(await said({ code: 1, stdout: 'not json', stderr: '' })).toBe('OpenClaw\'s Gateway did not delete it (not json)')
    expect(await said({ code: 2, stdout: '', stderr: '' })).toBe('OpenClaw\'s Gateway did not delete it (openclaw exited with status 2)')
    expect(await said({ code: null, stdout: '', stderr: '' })).toBe('OpenClaw\'s Gateway did not delete it (openclaw could not be run)')
    expect(await said({ code: 0, stdout: '{ broken }', stderr: '' })).toMatch(/did not delete it \(\{ broken \}\)/)
    expect(await said({ code: 0, stdout: '}{', stderr: '' })).toMatch(/did not delete it/)
    expect(await said({ code: 0, stdout: '{"ok":false}', stderr: '' })).toMatch(/did not delete it/)
    expect(await said({ code: 0, stdout: 'null {} x', stderr: '' })).toMatch(/did not delete it/)
  })
})

describe('runOpenclaw', () => {
  let bin: string
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'openclaw-bin-'))
    const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
    script('ok', 'echo "{\\"ok\\":true,\\"args\\":\\"$*\\"}"')
    script('fails', 'echo "Gateway call failed: no token" >&2; exit 3')
    script('silent', 'exit 4')
    script('slow', 'sleep 5')
  })
  afterAll(() => { rmSync(bin, { recursive: true, force: true }) })

  it.skipIf(process.platform === 'win32')('runs the command with its arguments, never through a shell, and says how it went', async () => {
    expect(await runOpenclaw(['gateway', 'call'], join(bin, 'ok'))).toEqual({ code: 0, stdout: '{"ok":true,"args":"gateway call"}\n', stderr: '' })
    expect(await runOpenclaw([], join(bin, 'fails'))).toEqual({ code: 3, stdout: '', stderr: 'Gateway call failed: no token\n' })
    expect((await runOpenclaw([], join(bin, 'silent'))).stderr).toMatch(/Command failed/)
    expect(await runOpenclaw([], join(bin, 'missing'))).toEqual({ code: null, stdout: '', stderr: 'openclaw is not on the PATH here' })
    expect(await runOpenclaw([], join(bin, 'slow'), 200)).toMatchObject({ code: null, stderr: 'openclaw did not answer within 0.2 s' })
  })

  it('runs openclaw from the PATH by default', async () => {
    const path = process.env.PATH
    process.env.PATH = bin
    try { expect(await runOpenclaw([])).toMatchObject({ code: null, stderr: 'openclaw is not on the PATH here' }) } finally { process.env.PATH = path }
  })
})
