import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '../lib/authSession.js'
import type { TeamConfig } from './config.js'
import {
  AUTO_SETUP_RETRY_MS, readTeamSetupDecision, TeamAutoSetup, teamSetupDecisionFile, writeTeamSetupDecision, type AutoSetupDeps, type TeamSetupDecision,
} from './autoSetup.js'

const session: AuthSession = { version: 1, accessToken: 'access-placeholder', autonomousEnv: 'prod', computerId: 'c'.repeat(32), updatedAt: 1 }

function fake(over: Partial<AutoSetupDeps> = {}) {
  let decision: TeamSetupDecision | null = null
  const log: string[] = []
  const deps: AutoSetupDeps = {
    platform: 'darwin', session: () => session, readConfig: () => null, accountExists: vi.fn(async () => false),
    readDecision: () => decision, writeDecision: vi.fn((d: TeamSetupDecision) => { decision = d }),
    setup: vi.fn(async () => ({ code: 0, result: { ok: true } })), now: () => 1_000_000, log: (line) => log.push(line), ...over,
  }
  return { auto: new TeamAutoSetup(deps), deps, log, decision: () => decision, setDecision: (d: TeamSetupDecision | null) => { decision = d } }
}

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the Harness Team account, set up on its own', () => {
  it('starts setup as the person joins or adds this Mac, once at a time, and answers at once', async () => {
    const f = fake()
    let finish: (value: { code: number; result: Record<string, unknown> | null }) => void = () => {}
    ;(f.deps.setup as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    expect(await f.auto.offer('join')).toEqual({ state: 'started' })
    expect(await f.auto.offer('contribute')).toEqual({ state: 'running' })
    finish({ code: 0, result: { ok: true } })
    await f.auto.settled()
    expect(f.deps.setup).toHaveBeenCalledTimes(1)
    expect(f.deps.writeDecision).not.toHaveBeenCalled()
    expect(f.log.join('\n')).toContain('the Harness Team account is set up')
  })

  it('says in its log why it asked nothing, one line per answer, so a Mac that never saw the prompt can tell why', async () => {
    const cases: Array<[Partial<AutoSetupDeps>, string]> = [
      [{ platform: 'freebsd' }, 'unsupported'], [{ session: () => null }, 'signed-out'], [{ session: () => ({ ...session, kind: 'team' }) }, 'dedicated'],
      [{ accountExists: vi.fn(async () => true) }, 'exists'],
    ]
    for (const [over, state] of cases) {
      const f = fake(over)
      await f.auto.offer('startup', async () => true)
      expect(f.log, state).toEqual([`the Harness Team account was not offered (startup): ${state}`])
    }
    const declined = fake()
    declined.setDecision({ state: 'declined', at: 1 })
    await declined.auto.offer('join')
    expect(declined.log).toEqual(['the Harness Team account was not offered (join): declined'])
    const alone = fake()
    await alone.auto.offer('startup', async () => false)
    expect(alone.log).toEqual(['the Harness Team account was not offered (startup): not-shared'])
  })

  it('asks nothing off a Mac, signed out, on a computer that runs team work only, or where the account exists', async () => {
    const cases: Array<[Partial<AutoSetupDeps>, string]> = [
      [{ platform: 'freebsd' }, 'unsupported'], [{ session: () => null }, 'signed-out'],
      [{ session: () => ({ ...session, kind: 'team' }) }, 'dedicated'], [{ readConfig: () => ({ user: 'harnessteam' }) as TeamConfig }, 'exists'],
      [{ accountExists: vi.fn(async () => true) }, 'exists'],
    ]
    for (const [over, state] of cases) {
      const f = fake(over)
      expect(await f.auto.offer('join'), state).toEqual({ state })
      expect(f.deps.setup).not.toHaveBeenCalled()
    }
  })

  it('remembers a cancelled prompt and does not ask again on its own; a failed setup waits a day', async () => {
    const cancelled = fake({ setup: vi.fn(async () => ({ code: 1, result: { ok: false, code: 'CANCELLED', message: 'Nothing was changed' } })) })
    expect(await cancelled.auto.offer('join')).toEqual({ state: 'started' })
    await cancelled.auto.settled()
    expect(cancelled.decision()).toEqual({ state: 'declined', at: 1_000_000 })
    expect(await cancelled.auto.offer('contribute')).toEqual({ state: 'declined' })
    expect(await cancelled.auto.offer('startup', async () => true)).toEqual({ state: 'declined' })
    expect(cancelled.deps.setup).toHaveBeenCalledTimes(1)

    let now = 1_000_000
    const failed = fake({ now: () => now, setup: vi.fn(async () => ({ code: 1, result: { ok: false, code: 'SETUP_FAILED', message: 'launchd would not start it' } })) })
    await failed.auto.offer('join')
    await failed.auto.settled()
    expect(failed.decision()).toEqual({ state: 'failed', at: 1_000_000, detail: 'launchd would not start it' })
    expect(await failed.auto.offer('join')).toEqual({ state: 'waiting' })
    now += AUTO_SETUP_RETRY_MS
    expect(await failed.auto.offer('join')).toEqual({ state: 'started' })
    await failed.auto.settled()
    // A setup that threw is a failure too; one that made the account but whose daemon has not reported is not.
    const threw = fake({ setup: vi.fn(async () => { throw new Error('osascript missing') }) })
    await threw.auto.offer('join'); await threw.auto.settled()
    expect(threw.decision()).toMatchObject({ state: 'failed', detail: 'osascript missing' })
    const slow = fake({ setup: vi.fn(async () => ({ code: 1, result: { ok: false, privacy: null } })) })
    await slow.auto.offer('join'); await slow.auto.settled()
    expect(slow.decision()).toBeNull()
    expect(slow.log.join('\n')).toContain('harness team status')
    const unreadable = fake({ setup: vi.fn(async () => ({ code: 1, result: { ok: false, code: 'CANCELLED' } })),
      writeDecision: vi.fn(() => { throw new Error('read-only') }) })
    await unreadable.auto.offer('join'); await unreadable.auto.settled()
    expect(unreadable.log.join('\n')).toContain('could not remember')
  })

  it('tells its own Desktop why there is no account: cancelled, failed with the reason, still running, or nothing yet', async () => {
    const f = fake()
    expect(await f.auto.status()).toEqual({ state: 'none' })
    f.setDecision({ state: 'declined', at: 5 })
    expect(await f.auto.status()).toEqual({ state: 'declined' })
    f.setDecision({ state: 'failed', at: 5, detail: 'launchd would not start it' })
    expect(await f.auto.status()).toEqual({ state: 'failed', detail: 'launchd would not start it' })
    let finish: (value: { code: number; result: Record<string, unknown> | null }) => void = () => {}
    ;(f.deps.setup as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await f.auto.offer('manual')
    expect(await f.auto.status()).toEqual({ state: 'running' })
    finish({ code: 0, result: { ok: true } })
    await f.auto.settled()
    // Made since: whatever was remembered before no longer explains anything.
    const made = fake({ accountExists: vi.fn(async () => true) })
    made.setDecision({ state: 'declined', at: 5 })
    expect(await made.auto.status()).toEqual({ state: 'exists' })
    expect(made.deps.setup).not.toHaveBeenCalled()
  })

  it('on Linux, offers it as on a Mac: wanted at a join, then started; an account there answers exists', async () => {
    const linux = fake({ platform: 'linux' })
    expect(await linux.auto.offer('join', undefined, true)).toEqual({ state: 'wanted' })
    expect(linux.deps.setup).not.toHaveBeenCalled()
    expect(await linux.auto.offer('manual')).toEqual({ state: 'started' })
    await linux.auto.settled()
    expect(linux.deps.setup).toHaveBeenCalledTimes(1)
    // Its log names the system that asks (the gridtest VM said "macOS" on Linux, 2026-10-28).
    expect(linux.log[0]).toBe('setting up the Harness Team account: the system asks for an administrator password')
    expect(await fake({ platform: 'linux', accountExists: vi.fn(async () => true) }).auto.offer('join')).toEqual({ state: 'exists' })
    // Windows too: User Account Control can always show, while a person is at it (Desktop asks only then).
    expect(await fake({ platform: 'win32', canPrompt: () => false }).auto.offer('join', undefined, true)).toEqual({ state: 'wanted' })
    const windows = fake({ platform: 'win32' })
    expect(await windows.auto.offer('join')).toEqual({ state: 'started' })
    await windows.auto.settled()
    expect(windows.log[0]).toBe('setting up the Harness Team account: Windows asks for permission (User Account Control)')
    expect(await fake({ platform: 'win32', accountExists: vi.fn(async () => true) }).auto.offer('join')).toEqual({ state: 'exists' })
  })

  it('on Linux with no prompt it can show, answers no-prompt up front, runs nothing and remembers nothing', async () => {
    // The owner's daemon under systemd --user has no DISPLAY: setup would only answer NO_PROMPT after "started" was said.
    for (const [reason, check] of [['join', true], ['manual', false], ['manual', true]] as const) {
      const f = fake({ platform: 'linux', canPrompt: () => false })
      expect(await f.auto.offer(reason, undefined, check), `${reason} ${check}`).toEqual({ state: 'no-prompt' })
      expect(f.deps.setup).not.toHaveBeenCalled()
      expect(f.deps.writeDecision).not.toHaveBeenCalled()
      expect(f.log).toEqual([`the Harness Team account was not offered (${reason}): no-prompt`])
    }
    // An account that is there, or a Mac (osascript always asks), is answered as before.
    expect(await fake({ platform: 'linux', canPrompt: () => false, accountExists: vi.fn(async () => true) }).auto.offer('manual')).toEqual({ state: 'exists' })
    expect(await fake({ platform: 'darwin', canPrompt: () => false }).auto.offer('join', undefined, true)).toEqual({ state: 'wanted' })
    expect(await fake({ platform: 'linux', canPrompt: () => true }).auto.offer('join', undefined, true)).toEqual({ state: 'wanted' })
  })

  it('remembers a setup Linux refused before it made anything as failed: no systemd, no tmux, no prompt to show', async () => {
    for (const code of ['NO_SYSTEMD', 'NO_TMUX', 'NO_PROMPT']) {
      const f = fake({ setup: vi.fn(async () => ({ code: 1, result: { ok: false, code, message: `refused: ${code}` } })) })
      await f.auto.offer('join'); await f.auto.settled()
      expect(f.decision(), code).toEqual({ state: 'failed', at: 1_000_000, detail: `refused: ${code}` })
    }
  })

  it('at app start, asks only while this Mac is in a Swarm with other people in it', async () => {
    const alone = fake()
    expect(await alone.auto.offer('startup', async () => false)).toEqual({ state: 'not-shared' })
    expect(await alone.auto.offer('startup')).toEqual({ state: 'not-shared' })
    expect(await alone.auto.offer('startup', async () => { throw new Error('offline') })).toEqual({ state: 'not-shared' })
    expect(alone.deps.setup).not.toHaveBeenCalled()
    const shared = fake()
    expect(await shared.auto.offer('startup', async () => true)).toEqual({ state: 'started' })
    await shared.auto.settled()
    expect(shared.deps.setup).toHaveBeenCalledTimes(1)
  })

  it('says it is wanted without asking macOS, so Desktop can explain it first; "Not now" is remembered', async () => {
    const f = fake()
    expect(await f.auto.offer('startup', async () => true, true)).toEqual({ state: 'wanted' })
    expect(await f.auto.offer('startup', async () => false, true)).toEqual({ state: 'not-shared' })
    expect(f.deps.setup).not.toHaveBeenCalled()
    f.auto.decline()
    expect(f.decision()).toEqual({ state: 'declined', at: 1_000_000 })
    expect(await f.auto.offer('join', undefined, true)).toEqual({ state: 'declined' })
    const there = fake({ accountExists: vi.fn(async () => true) })
    expect(await there.auto.offer('manual', undefined, true)).toEqual({ state: 'exists' })
  })

  it('runs when the person asks, past a cancel or a failure remembered from before, and alone in a Swarm', async () => {
    const f = fake()
    f.setDecision({ state: 'declined', at: 1 })
    expect(await f.auto.offer('manual', undefined, true)).toEqual({ state: 'wanted' })
    expect(await f.auto.offer('manual')).toEqual({ state: 'started' })
    await f.auto.settled()
    f.setDecision({ state: 'failed', at: 1_000_000 })
    expect(await f.auto.offer('manual')).toEqual({ state: 'started' })
    await f.auto.settled()
    expect(f.deps.setup).toHaveBeenCalledTimes(2)
  })

  it('keeps its memory in the daemon\'s own folder, private, and reads nothing it did not write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-setup-'))
    cleanup.push(dir)
    const file = teamSetupDecisionFile(dir)
    expect(readTeamSetupDecision(file)).toBeNull()
    writeTeamSetupDecision(file, { state: 'failed', at: 5, detail: 'x'.repeat(400) })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readTeamSetupDecision(file)).toEqual({ state: 'failed', at: 5, detail: 'x'.repeat(300) })
    writeTeamSetupDecision(file, { state: 'declined', at: 6 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ state: 'declined', at: 6 })
    writeTeamSetupDecision(file, null)
    expect(readTeamSetupDecision(file)).toBeNull()
    writeTeamSetupDecision(file, null)
    for (const text of ['{', '{"state":"maybe","at":1}', '{"state":"declined","at":"now"}']) {
      writeFileSync(file, text)
      expect(readTeamSetupDecision(file), text).toBeNull()
    }
  })
})
