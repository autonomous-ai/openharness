/**
 * `harness team` against fake deps: no administrator prompt, account, launchd, daemon or backend is touched.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '../lib/authSession.js'
import type { AdminScript, RunAdmin } from './admin.js'
import { teamCommand, type TeamCommandDeps } from './command.js'
import type { TeamConfig } from './config.js'
import type { PrivacyResult, TeamStatus } from './privacy.js'
import { parseLaunchctlPrint } from './deps.js'

const OWNER_HOME = '/Users/owner-placeholder'
const CODE = `hnh_${'b'.repeat(43)}`
const STATUS = '/Library/Application Support/Harness/Team/status.json'
const computer: AuthSession = { version: 1, accessToken: 'access-placeholder', refreshToken: 'hnr_old', autonomousEnv: 'prod', computerId: 'c'.repeat(32), machineId: 'm1', updatedAt: 1 }
const config: TeamConfig = {
  version: 1, user: 'harnessteam', realName: 'Harness Team', home: '/Users/harnessteam', owner: 'owner-placeholder', ownerHome: OWNER_HOME,
  sentinel: `${OWNER_HOME}/.harness-team-privacy`, port: 18493, label: 'ai.autonomous.harness.team',
  plist: '/Library/LaunchDaemons/ai.autonomous.harness.team.plist', statusFile: STATUS,
  node: '/Users/harnessteam/.harness/runtime/node-v1/bin/node', cli: '/Users/harnessteam/.harness/cli/cli.js', env: {}, createdAt: 'x',
}

function fake(over: Partial<TeamCommandDeps> & { adminResult?: Awaited<ReturnType<RunAdmin>>; statusAfter?: (startedAt: number) => TeamStatus | null } = {}) {
  let now = 1_000_000
  let session: AuthSession | null = computer
  const out: string[] = [], err: string[] = []
  const built: AdminScript[] = []
  const prompts: string[] = []
  const status = new Map<string, TeamStatus>()
  const admin = vi.fn<RunAdmin>(async (build, prompt) => {
    built.push(build('/private/var/folders/aa/T/harness-team-stage'))
    prompts.push(prompt)
    return over.adminResult ?? { ok: true, stdout: 'harness: handed a sign-in to the team account\n' }
  })
  const startedAt = now
  const post = vi.fn(async (path: string, _body: unknown, _headers?: Record<string, string>): Promise<unknown> => {
    if (path === '/api/auth/handoff') return { code: CODE, expiresIn: 90 }
    if (path === '/api/auth/handoff/redeem') return { token: 'hna_team', refreshToken: 'hnr_team', expiresIn: 3600, kind: 'team' }
    return {}
  })
  const deps: TeamCommandDeps = {
    platform: 'darwin',
    out: (line) => out.push(line), err: (line) => err.push(line),
    user: () => 'owner-placeholder', home: () => OWNER_HOME, uid: () => 501, hostname: () => 'Mac-placeholder',
    env: {}, interactive: false, ask: vi.fn(async () => 'y'), now: () => now, sleep: vi.fn(async (ms: number) => { now += ms }),
    session: () => session, writeSession: vi.fn((s: AuthSession) => { session = s }), clearSession: vi.fn(() => { session = null }),
    auth: vi.fn(async () => ({ session: session!, headers: { authorization: 'Bearer x' } })), post: post as never,
    get: vi.fn(async () => ({ user: { id: 'user-placeholder-1' } })) as never, machineKey: () => ({ priv: new Uint8Array(32).fill(9) }),
    computerId: () => 't'.repeat(32), autonomousEnv: 'prod',
    installed: () => ({ cliDir: `${OWNER_HOME}/.harness/cli`, cliJs: `${OWNER_HOME}/.harness/cli/cli.js`,
      node: `${OWNER_HOME}/.harness/runtime/node-v1/bin/node`, nodeRuntimeDir: `${OWNER_HOME}/.harness/runtime/node-v1`, tmuxRuntimeDir: null }),
    exists: () => true, mode: () => 0o700, admin,
    readConfig: () => null,
    readStatus: (path) => over.statusAfter ? over.statusAfter(startedAt) : status.get(path) ?? null,
    writeStatus: vi.fn((path: string, update: Partial<TeamStatus>) => { status.set(path, { ...(status.get(path) ?? { version: 1 }), ...update, version: 1 }) }),
    accountExists: vi.fn(async () => false), jobState: vi.fn(async () => ({ loaded: true, pid: 4242, state: 'running' })),
    takeHandoff: vi.fn(() => CODE), privacy: vi.fn((): PrivacyResult => ({ passed: true, checkedAt: now })),
    stopDaemon: vi.fn(async () => true), startDaemon: vi.fn(async () => {}),
    ...over,
  }
  return { deps, out, err, built, prompts, post, admin, status, session: () => session, setSession: (s: AuthSession | null) => { session = s } }
}

const reported = (startedAt: number): TeamStatus => ({ version: 1, signIn: { state: 'signed-in', at: startedAt + 3_000 }, privacy: { passed: true, checkedAt: startedAt + 3_000 } })

describe('harness team', () => {
  it('prints its help, and refuses an unknown verb', async () => {
    const f = fake()
    expect(await teamCommand([], f.deps)).toBe(0)
    expect(f.out[0]).toContain('Usage: harness team <setup | status | remove | on | off>')
    expect(await teamCommand(['frobnicate'], f.deps)).toBe(2)
  })
})

describe('harness team setup', () => {
  it('says what it will make, runs one privileged script, and waits for the team daemon to sign in and pass its check', async () => {
    const f = fake({ statusAfter: reported, env: { BACKEND_WS_URL: 'wss://backend.example.test', HARNESS_AUTH_DIR: '/tmp/auth' } })
    expect(await teamCommand(['setup'], f.deps)).toBe(0)
    expect(f.admin).toHaveBeenCalledTimes(1)
    expect(f.prompts[0]).toContain('Harness Team')
    const { script, files } = f.built[0]!
    expect(script).toContain("OWNER='owner-placeholder'")
    expect(script).toContain("STAGE='/private/var/folders/aa/T/harness-team-stage'")
    expect(script).toContain("'HARNESS_AUTH_DIR=/tmp/auth'")
    const written = JSON.parse(files!['team.json']!) as TeamConfig
    expect(written).toMatchObject({ user: 'harnessteam', ownerHome: OWNER_HOME, port: 18493, node: '/Users/harnessteam/.harness/runtime/node-v1/bin/node',
      env: { BACKEND_WS_URL: 'wss://backend.example.test' } })
    expect(files!['team.plist']).toContain('<string>wss://backend.example.test</string>')
    expect(files!['team.plist']).not.toContain('HARNESS_AUTH_DIR')
    const text = f.out.join('\n')
    expect(text).toContain('Harness Team (harnessteam)')
    expect(text).toContain('/Library/LaunchDaemons/ai.autonomous.harness.team.plist')
    expect(text).toContain('✓ The Harness Team account is signed in.')
    expect(text).toContain('✓ Private')
  })

  it('reports a failed privacy check or sign-in, and returns failure', async () => {
    const f = fake({ statusAfter: (t) => ({ version: 1, signIn: { state: 'failed', at: t + 1, detail: 'code refused' },
      privacy: { passed: false, item: 'gitconfig', detail: 'The team account could read ~/.gitconfig.', checkedAt: t + 1 } }) })
    expect(await teamCommand(['setup'], f.deps)).toBe(1)
    expect(f.err.join('\n')).toContain('did not sign in: code refused')
    expect(f.err.join('\n')).toContain('Not private (gitconfig)')
  })

  it('says when the daemon has not reported in time, ignoring an older report', async () => {
    const f = fake({ statusAfter: (t) => ({ version: 1, privacy: { passed: true, checkedAt: t - 10 } }) })
    expect(await teamCommand(['setup'], f.deps)).toBe(0)
    expect(f.out.join('\n')).toContain('has not reported its privacy check yet')
    expect(f.out.join('\n')).toContain('has not signed in yet')
  })

  it('does not wait for a sign-in the script did not hand over, and asks again with --sign-in-again', async () => {
    const f = fake({ adminResult: { ok: true, stdout: '' }, statusAfter: (t) => ({ version: 1, privacy: { passed: true, checkedAt: t + 1 } }) })
    expect(await teamCommand(['setup', '--json'], f.deps)).toBe(0)
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ ok: true, user: 'harnessteam', label: 'ai.autonomous.harness.team', privacy: { passed: true } })
    expect(f.built[0]!.script).toContain("SIGN_IN='missing'")
    const again = fake({ statusAfter: reported })
    await teamCommand(['setup', '--sign-in-again'], again.deps)
    expect(again.built[0]!.script).toContain("SIGN_IN='always'")
  })

  it('changes nothing when the prompt is cancelled, and says how to finish a script that stopped', async () => {
    const cancelled = fake({ adminResult: { ok: false, code: 'CANCELLED', message: 'x' } })
    expect(await teamCommand(['setup'], cancelled.deps)).toBe(1)
    expect(cancelled.err[0]).toContain('Nothing was changed')
    const stopped = fake({ adminResult: { ok: false, code: 'FAILED', message: 'launchd would not start the team daemon' } })
    expect(await teamCommand(['setup', '--json'], stopped.deps)).toBe(1)
    expect(JSON.parse(stopped.out.at(-1)!)).toMatchObject({ ok: false, code: 'SETUP_FAILED' })
  })

  it('refuses where it cannot help, before any prompt', async () => {
    const cases: Array<[Partial<TeamCommandDeps>, string]> = [
      [{ platform: 'linux' }, 'harness team on'],
      [{ uid: () => 0 }, 'not with sudo'],
      [{ session: () => null }, 'Sign this computer in first'],
      [{ session: () => ({ ...computer, kind: 'team' }) }, 'already runs team work only'],
      [{ user: () => 'harnessteam' }, 'not the Harness Team account'],
      [{ exists: () => false }, 'not installed'],
      [{ env: { BACKEND_WS_URL: 'wss://x/$(id)' } }, 'BACKEND_WS_URL'],
      [{ home: () => "/Users/o'brien" }, 'plain absolute path'],
    ]
    for (const [over, says] of cases) {
      const f = fake(over)
      expect(await teamCommand(['setup'], f.deps), says).toBe(1)
      expect(f.err.join('\n'), says).toContain(says)
      expect(f.admin).not.toHaveBeenCalled()
    }
  })
})

describe('harness team status', () => {
  it('lists the account, the daemon, the sign-in, the privacy check and everything setup made', async () => {
    const f = fake({ readConfig: () => config, accountExists: vi.fn(async () => true) })
    f.status.set(STATUS, { version: 1, signIn: { state: 'signed-in', at: 1_000_000 - 30_000 }, privacy: { passed: true, checkedAt: 1_000_000 - 120_000 } })
    expect(await teamCommand(['status'], f.deps)).toBe(0)
    const text = f.out.join('\n')
    for (const needle of ['Harness Team (harnessteam)', '● exists', '● running (pid 4242)', '✓ signed in (30s ago)', 'Private ✓ (checked 2m ago)',
      `${OWNER_HOME} · mode 700 ✓`, '/Users/harnessteam', 'ai.autonomous.harness.team, a LaunchDaemon at /Library/LaunchDaemons/ai.autonomous.harness.team.plist',
      '/Library/Application Support/Harness/team.json', 'sudo dscl . -delete /Users/harnessteam', 'harness team remove']) {
      expect(text, needle).toContain(needle)
    }
  })

  it('shows what is wrong: a failed check, an open home, a stopped daemon', async () => {
    const f = fake({ readConfig: () => config, accountExists: vi.fn(async () => true), mode: () => 0o750,
      jobState: vi.fn(async () => ({ loaded: false, pid: null, state: null })), exists: (p) => p !== config.plist })
    f.status.set(STATUS, { version: 1, privacy: { passed: false, item: 'sentinel', detail: 'The team account could read it.', checkedAt: 1_000_000 - 7_200_000 } })
    await teamCommand(['status'], f.deps)
    const text = f.out.join('\n')
    expect(text).toContain('○ not installed')
    expect(text).toContain('? not reported yet')
    expect(text).toContain('✗ sentinel: The team account could read it. (checked 2h ago)')
    expect(text).toContain('mode 750 ✗ should be 700')
  })

  it('answers in JSON, and says plainly when there is no team account or the computer is dedicated', async () => {
    const f = fake({ readConfig: () => config, accountExists: vi.fn(async () => true) })
    await teamCommand(['status', '--json'], f.deps)
    expect(JSON.parse(f.out[0]!)).toMatchObject({ account: true, user: 'harnessteam', label: 'ai.autonomous.harness.team', job: { pid: 4242 }, ownerHomeMode: '700', privacy: null })
    const none = fake()
    await teamCommand(['status'], none.deps)
    expect(none.out[0]).toContain('No Harness Team account on this computer. harness team setup makes one.')
    const linux = fake({ platform: 'linux', session: () => ({ ...computer, kind: 'team' }) })
    await teamCommand(['status'], linux.deps)
    expect(linux.out[0]).toContain('runs team work only')
    const linuxJson = fake({ platform: 'linux' })
    await teamCommand(['status', '--json'], linuxJson.deps)
    expect(JSON.parse(linuxJson.out[0]!)).toEqual({ account: false, dedicated: false })
  })
})

describe('harness team remove', () => {
  it('runs one privileged removal with what the config names', async () => {
    const f = fake({ readConfig: () => ({ ...config, env: { AUTONOMOUS_ENV: 'stag' } }) })
    expect(await teamCommand(['remove'], f.deps)).toBe(0)
    expect(f.prompts[0]).toContain('remove the Harness Team account')
    expect(f.built[0]!.script).toContain(`TEAM_CLI='${config.cli}'`)
    expect(f.built[0]!.script).toContain("'AUTONOMOUS_ENV=stag'")
    expect(f.out.join('\n')).toContain('Your home folder stays private')
  })

  it('has nothing to do without an account, and refuses off a Mac or as root', async () => {
    const none = fake({ exists: () => false })
    expect(await teamCommand(['remove', '--json'], none.deps)).toBe(0)
    expect(JSON.parse(none.out[0]!)).toEqual({ ok: true, removed: false })
    expect(none.admin).not.toHaveBeenCalled()
    expect(await teamCommand(['remove'], fake({ platform: 'win32' }).deps)).toBe(1)
    expect(await teamCommand(['remove'], fake({ uid: () => 0 }).deps)).toBe(1)
    const cancelled = fake({ adminResult: { ok: false, code: 'CANCELLED', message: '' } })
    expect(await teamCommand(['remove'], cancelled.deps)).toBe(1)
    const failed = fake({ adminResult: { ok: false, code: 'FAILED', message: 'dscl refused' } })
    expect(await teamCommand(['remove'], failed.deps)).toBe(1)
    expect(failed.err[0]).toContain('dscl refused')
  })
})

describe('harness team on and off', () => {
  it('on: mints a code that converts this very computer, with its machine key\'s proof, redeems it here, and swaps the daemon onto it', async () => {
    const f = fake({ platform: 'linux', now: () => 1761300000000 })
    const order: string[] = []
    f.post.mockImplementation(async (path: string) => {
      order.push(path)
      if (path === '/api/auth/handoff') return { code: CODE, expiresIn: 90, kind: 'team' }
      if (path === '/api/auth/handoff/redeem') return { token: 'hta_team', refreshToken: 'htr_team', expiresIn: 3600, kind: 'team' }
      return {}
    })
    ;(f.deps.stopDaemon as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('stop'); return true })
    expect(await teamCommand(['on', '--yes'], f.deps)).toBe(0)
    expect(f.post).toHaveBeenCalledWith('/api/auth/handoff', { kind: 'team', computerId: 'c'.repeat(32),
      proof: { machineId: 'm1', at: 1761300000000, sig: expect.any(String) } }, { authorization: 'Bearer x' })
    expect(f.post).toHaveBeenCalledWith('/api/auth/handoff/redeem', { code: CODE, label: 'Mac-placeholder · Team', computerId: computer.computerId })
    // The daemon stops before the redeem: a daemon still on the old sign-in would make this an ordinary machine again.
    expect(order.slice(0, 3)).toEqual(['/api/auth/handoff', 'stop', '/api/auth/handoff/redeem'])
    // The team sign-in replaces the previous one in the session file; that one is signed out where it can be.
    expect(f.session()).toEqual(expect.objectContaining({ kind: 'team', accessToken: 'hta_team', refreshToken: 'htr_team', computerId: computer.computerId, machineId: 'm1' }))
    expect(f.post).toHaveBeenCalledWith('/api/auth/revoke', { refreshToken: 'hnr_old' })
    expect(f.out.join('\n')).toContain('previous sign-in was discarded')
    expect(f.deps.startDaemon).toHaveBeenCalled()
  })

  it('on: an Autonomous sign-in is discarded too, and one this computer cannot prove changes nothing', async () => {
    const sso: AuthSession = { ...computer, accessToken: 'eyJ.sso-placeholder', refreshToken: 'sso-refresh-placeholder' }
    const f = fake({ platform: 'linux' })
    f.setSession(sso)
    expect(await teamCommand(['on', '--yes'], f.deps)).toBe(0)
    expect(f.session()).toMatchObject({ kind: 'team', accessToken: 'hna_team' })
    expect(JSON.stringify(f.session())).not.toContain('sso')
    expect(f.post).not.toHaveBeenCalledWith('/api/auth/revoke', expect.anything())
    const nokey = fake({ platform: 'linux', machineKey: () => null })
    nokey.setSession(sso)
    expect(await teamCommand(['on', '--yes'], nokey.deps)).toBe(1)
    expect(nokey.err[0]).toContain('no device key yet')
    expect(nokey.err[0]).toContain('Nothing was changed on this computer.')
    expect(nokey.post).not.toHaveBeenCalled()
    expect(nokey.deps.stopDaemon).not.toHaveBeenCalled()
    expect(nokey.session()).toBe(sso)
  })

  it('on: a refused redeem starts the daemon again on the sign-in it had, and changes nothing', async () => {
    const f = fake({ platform: 'linux' })
    f.post.mockImplementation(async (path: string) => {
      if (path === '/api/auth/handoff') return { code: CODE, expiresIn: 90, kind: 'team' }
      throw Object.assign(new Error('That code has expired.'), { status: 401 })
    })
    expect(await teamCommand(['on', '--yes', '--json'], f.deps)).toBe(1)
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ ok: false, code: 'EXPIRED', message: expect.stringContaining('Nothing was changed on this computer.') })
    expect(f.session()).toBe(computer)
    expect(f.deps.stopDaemon).toHaveBeenCalled()
    expect(f.deps.startDaemon).toHaveBeenCalled()
    expect(f.deps.writeSession).not.toHaveBeenCalled()
  })

  it('on: asks first at a terminal, needs --yes otherwise, and leaves a Mac with a team account alone', async () => {
    const ask = fake({ interactive: true, ask: vi.fn(async () => 'n') })
    expect(await teamCommand(['on'], ask.deps)).toBe(1)
    expect(ask.post).not.toHaveBeenCalled()
    const yes = fake({ interactive: true })
    expect(await teamCommand(['on'], yes.deps)).toBe(0)
    expect(await teamCommand(['on'], fake().deps)).toBe(1)
    const mac = fake({ readConfig: () => config })
    expect(await teamCommand(['on', '--yes'], mac.deps)).toBe(1)
    expect(mac.err[0]).toContain('has a Harness Team account')
    expect(await teamCommand(['on', '--yes'], fake({ session: () => null }).deps)).toBe(1)
    const already = fake({ session: () => ({ ...computer, kind: 'team' }) })
    expect(await teamCommand(['on', '--json'], already.deps)).toBe(0)
    expect(JSON.parse(already.out[0]!)).toEqual({ ok: true, changed: false })
  })

  it('on: changes nothing when the backend will not hand out a team sign-in, or makes something else', async () => {
    const f = fake({ post: (async () => { throw Object.assign(new Error('Add a phone from a computer'), { status: 403 }) }) as never })
    expect(await teamCommand(['on', '--yes'], f.deps)).toBe(1)
    expect(f.session()).toBe(computer)
    expect(f.deps.stopDaemon).not.toHaveBeenCalled()
    expect(f.err[0]).toContain('Nothing was changed on this computer.')
    // A backend from before team sessions: the redeem makes a phone's session, which is signed out again.
    const old = fake()
    old.post.mockImplementation(async (path: string) => path === '/api/auth/handoff' ? { code: CODE, expiresIn: 90 }
      : path === '/api/auth/handoff/redeem' ? { token: 'hna_phone', refreshToken: 'hnr_phone', expiresIn: 3600 } : {})
    expect(await teamCommand(['on', '--yes', '--json'], old.deps)).toBe(1)
    expect(JSON.parse(old.out.at(-1)!)).toMatchObject({ ok: false, code: 'NOT_TEAM' })
    expect(old.post).toHaveBeenCalledWith('/api/auth/revoke', { refreshToken: 'hnr_phone' })
    expect(old.session()).toBe(computer)
    // Stopped for the redeem, and started again on the sign-in it had.
    expect(old.deps.startDaemon).toHaveBeenCalled()
  })

  it('off: signs the team session out, then the ordinary sign-in at a terminal, or says how', async () => {
    const signIn = vi.fn(async () => {})
    const f = fake({ interactive: true, signIn })
    f.setSession({ ...computer, kind: 'team', refreshToken: 'htr_team' })
    expect(await teamCommand(['off'], f.deps)).toBe(0)
    expect(f.post).toHaveBeenCalledWith('/api/auth/revoke', { refreshToken: 'htr_team' })
    expect(f.session()).toBeNull()
    expect(signIn).toHaveBeenCalledWith(true)
    const quiet = fake()
    quiet.setSession({ ...computer, kind: 'team' })
    expect(await teamCommand(['off'], quiet.deps)).toBe(0)
    expect(quiet.out.join('\n')).toContain('harness login')
    expect(quiet.deps.startDaemon).toHaveBeenCalled()
    const json = fake()
    json.setSession({ ...computer, kind: 'team' })
    expect(await teamCommand(['off', '--json'], json.deps)).toBe(0)
    expect(JSON.parse(json.out[0]!)).toMatchObject({ ok: true, changed: true, next: 'harness login' })
    const notTeam = fake()
    expect(await teamCommand(['off'], notTeam.deps)).toBe(0)
    expect(notTeam.out[0]).toContain('nothing to change')
  })
})

describe('internal verbs', () => {
  it('__handoff prints the code and nothing else', async () => {
    const f = fake()
    expect(await teamCommand(['__handoff'], f.deps)).toBe(0)
    expect(f.out).toEqual([CODE])
    const team = fake()
    team.setSession({ ...computer, kind: 'team' })
    expect(await teamCommand(['__handoff'], team.deps)).toBe(1)
    expect(team.out).toEqual([])
  })

  const inTeam = (over: Partial<TeamCommandDeps> = {}) => {
    const f = fake({ user: () => 'harnessteam', readConfig: () => config, ...over })
    f.setSession(null)
    return f
  }

  it('__start redeems the handed-over code for this computer, stores a team session and reports it with the check', async () => {
    const f = inTeam()
    expect(await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], f.deps)).toBe(0)
    expect(f.deps.takeHandoff).toHaveBeenCalledWith('/Users/harnessteam/.harness/team-handoff')
    expect(f.post).toHaveBeenCalledWith('/api/auth/handoff/redeem', { code: CODE, label: 'Mac-placeholder · Team', computerId: 't'.repeat(32) })
    expect(f.session()).toMatchObject({ kind: 'team', computerId: 't'.repeat(32), refreshToken: 'hnr_team' })
    expect(f.status.get(STATUS)).toMatchObject({ signIn: { state: 'signed-in' }, privacy: { passed: true } })
    expect(f.out.join('\n')).toContain('[team] signed in for team work')
  })

  it('__start stores nothing when the backend makes a session that is not a team one', async () => {
    const f = inTeam()
    f.post.mockImplementation(async (path: string) => path === '/api/auth/handoff/redeem' ? { token: 'hna_phone', refreshToken: 'hnr_phone' } : {})
    expect(await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], f.deps)).toBe(0)
    expect(f.session()).toBeNull()
    expect(f.status.get(STATUS)?.signIn).toMatchObject({ state: 'failed', detail: expect.stringContaining('does not make team sign-ins yet') })
  })

  it('__start reports a refused code and an unsafe file, and still exits 0 so the daemon starts', async () => {
    const refused = inTeam({ post: (async () => { throw Object.assign(new Error('expired'), { status: 401 }) }) as never })
    expect(await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], refused.deps)).toBe(0)
    expect(refused.session()).toBeNull()
    expect(refused.status.get(STATUS)?.signIn).toMatchObject({ state: 'failed' })
    const unsafe = inTeam({ takeHandoff: () => { throw new Error('not this account\'s private file') } })
    expect(await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], unsafe.deps)).toBe(0)
    expect(unsafe.status.get(STATUS)?.signIn).toMatchObject({ state: 'failed', detail: 'not this account\'s private file' })
  })

  it('__start leaves an existing sign-in alone, runs the check with no code, and writes nothing outside the team account', async () => {
    const signed = inTeam()
    signed.setSession({ ...computer, kind: 'team' })
    await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], signed.deps)
    expect(signed.post).not.toHaveBeenCalled()
    expect(signed.out.join('\n')).toContain('was not used')
    const failing = inTeam({ takeHandoff: () => null, privacy: () => ({ passed: false, item: 'ssh', detail: 'could read ~/.ssh', checkedAt: 1 }) })
    await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], failing.deps)
    expect(failing.out.join('\n')).toContain('privacy check FAILED (ssh)')
    const owner = fake({ readConfig: () => config })
    await teamCommand(['__start'], owner.deps)
    expect(owner.deps.writeStatus).not.toHaveBeenCalled()
    expect(owner.deps.privacy).not.toHaveBeenCalled()
  })

  it('__signout revokes and clears the team account\'s session', async () => {
    const f = inTeam()
    f.setSession({ ...computer, kind: 'team', refreshToken: 'hnr_team' })
    expect(await teamCommand(['__signout'], f.deps)).toBe(0)
    expect(f.post).toHaveBeenCalledWith('/api/auth/revoke', { refreshToken: 'hnr_team' })
    expect(f.session()).toBeNull()
    expect(f.status.get(STATUS)?.signIn).toMatchObject({ state: 'signed-out' })
  })
})

describe('parseLaunchctlPrint', () => {
  it('reads the pid and state, and a job launchd does not know as not loaded', () => {
    expect(parseLaunchctlPrint(0, 'system/ai.autonomous.harness.team = {\n\tstate = running\n\tpid = 812\n}')).toEqual({ loaded: true, pid: 812, state: 'running' })
    expect(parseLaunchctlPrint(0, '\tstate = not running\n')).toEqual({ loaded: true, pid: null, state: 'not running' })
    expect(parseLaunchctlPrint(113, 'Could not find service')).toEqual({ loaded: false, pid: null, state: null })
  })
})
