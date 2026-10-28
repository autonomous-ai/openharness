/**
 * `harness team` against fake deps: no administrator prompt, account, launchd, daemon or backend is touched.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '../lib/authSession.js'
import { SIGN_OUT_BUTTON_FLAG, signOutAsked } from '../lib/signOut.js'
import type { AdminScript, RunAdmin } from './admin.js'
import { REPAIR_PROMPT, SETUP_PROMPT, teamCommand, type TeamCommandDeps } from './command.js'
import type { TeamConfig } from './config.js'
import type { PrivacyResult, TeamStatus } from './privacy.js'
import type { TeamEngines } from './engines.js'
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
  const vias: Array<string | undefined> = []
  const status = new Map<string, TeamStatus>()
  const admin = vi.fn<RunAdmin>(async (build, prompt, via) => {
    built.push(build('/private/var/folders/aa/T/harness-team-stage'))
    prompts.push(prompt)
    vias.push(via)
    return over.adminResult ?? { ok: true, stdout: 'harness: handed a sign-in to the team account\n' }
  })
  const startedAt = now
  const post = vi.fn(async (path: string, _body: unknown, _headers?: Record<string, string>): Promise<unknown> => {
    if (path === '/api/auth/handoff') return { code: CODE, expiresIn: 90 }
    if (path === '/api/auth/handoff/redeem') return { token: 'hna_team', refreshToken: 'hnr_team', expiresIn: 3600, kind: 'team' }
    if (path === '/api/machines/resolve-computer') return { machine: { machineId: 'm-team' }, created: true }
    return {}
  })
  const deps: TeamCommandDeps = {
    platform: 'darwin',
    out: (line) => out.push(line), err: (line) => err.push(line),
    user: () => 'owner-placeholder', home: () => OWNER_HOME, uid: () => 501, hostname: () => 'Mac-placeholder',
    env: {}, interactive: false, ask: vi.fn(async () => 'y'), now: () => now, sleep: vi.fn(async (ms: number) => { now += ms }),
    session: () => session, writeSession: vi.fn((s: AuthSession) => { session = s }),
    updateSession: vi.fn(async (change: (latest: AuthSession) => AuthSession | null) => {
      const next = session ? change(session) : null
      if (next) session = next
      return next ?? session
    }), signOutAsked: (flags) => signOutAsked({ interactive: over.interactive ?? false, flags, ancestors: () => [], isApp: () => false }),
    removeSignIn: vi.fn(() => { session = null }),
    auth: vi.fn(async () => ({ session: session!, headers: { authorization: 'Bearer x' } })), post: post as never,
    get: vi.fn(async (path: string) => path === '/api/machines' ? { machines: MACHINES } : { user: { id: 'user-placeholder-1' } }) as never,
    delete: vi.fn(async () => ({ deleted: true })) as never, machineKey: () => ({ priv: new Uint8Array(32).fill(9) }),
    computerId: () => 't'.repeat(32), autonomousEnv: 'prod',
    installed: () => ({ cliDir: `${OWNER_HOME}/.harness/cli`, cliJs: `${OWNER_HOME}/.harness/cli/cli.js`,
      node: `${OWNER_HOME}/.harness/runtime/node-v1/bin/node`, nodeRuntimeDir: `${OWNER_HOME}/.harness/runtime/node-v1`, tmuxRuntimeDir: null }),
    exists: () => true, mode: () => 0o700, admin,
    readConfig: () => null,
    readStatus: (path) => over.statusAfter ? over.statusAfter(startedAt) : status.get(path) ?? null,
    writeStatus: vi.fn((path: string, update: Partial<TeamStatus>) => { status.set(path, { ...(status.get(path) ?? { version: 1 }), ...update, version: 1 }) }),
    accountExists: vi.fn(async () => false), jobState: vi.fn(async () => ({ loaded: true, pid: 4242, state: 'running' })),
    takeHandoff: vi.fn(() => CODE), privacy: vi.fn((): PrivacyResult => ({ passed: true, checkedAt: now })),
    engines: vi.fn(async (): Promise<TeamEngines> => ({ checkedAt: now, claude: { installed: true, signedIn: false }, codex: { installed: true, signedIn: true } })),
    stopDaemon: vi.fn(async () => true), startDaemon: vi.fn(async () => {}),
    ...over,
  }
  return { deps, out, err, built, prompts, vias, post, admin, status, session: () => session, setSession: (s: AuthSession | null) => { session = s } }
}

/** The owner's machines as the backend lists them, computer ids lower case without dashes: this computer, the team
 *  account's, and a dedicated Mac mini's. */
const TEAM_COMPUTER = 'ebe7fc88-cd44-491f-aa61-9963fa0dfd82'
const MACHINES = [
  { machineId: 'm1', computerId: 'c'.repeat(32), sessionKind: 'computer' },
  { machineId: 'm-team', computerId: TEAM_COMPUTER.replace(/-/g, ''), sessionKind: 'team' },
  { machineId: 'm-mini', computerId: 'a'.repeat(32), sessionKind: 'team' },
]

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
    // The engines setup installed in the team account, and how to sign them in (none were reported in this run).
    expect(text).toContain('engines     ? not reported yet')
  })

  it('asks to create the account on a Mac without one, and to repair it on a Mac that has it', async () => {
    const first = fake({ statusAfter: reported })
    await teamCommand(['setup'], first.deps)
    expect(first.prompts[0]).toBe(SETUP_PROMPT)
    expect(first.out[0]).toContain('Harness will set up a separate account')
    for (const over of [{ readConfig: () => config }, { accountExists: vi.fn(async () => true) }]) {
      const again = fake({ statusAfter: reported, ...over })
      await teamCommand(['setup'], again.deps)
      expect(again.prompts[0]).toBe(REPAIR_PROMPT)
      expect(again.prompts[0]).toContain('repair the Harness Team account')
      expect(again.out[0]).toContain('Harness will repair the Harness Team account')
    }
    // What setup says it made is what it makes now: a password nobody knows, and listed.
    expect(first.out.join('\n')).toContain('a standard user with a random password nobody knows, listed in Users & Groups')
  })

  it('shows the team account\'s engines as its daemon reported them in this run, and how to sign them in', async () => {
    const f = fake({ statusAfter: (t) => ({ ...reported(t), engines: { checkedAt: t + 3_000, claude: { installed: true, signedIn: false }, codex: { installed: true, signedIn: false } } }) })
    expect(await teamCommand(['setup'], f.deps)).toBe(0)
    const text = f.out.join('\n')
    expect(text).toContain('Claude Code ✓ installed · ✗ not signed in')
    expect(text).toContain('    codex login --device-auth   Codex')
    const json = fake({ statusAfter: (t) => ({ ...reported(t), engines: { checkedAt: t - 1, claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } } }) })
    await teamCommand(['setup', '--json'], json.deps)
    expect(JSON.parse(json.out.at(-1)!)).toMatchObject({ ok: true, engines: null })
  })

  it('forgets a prompt Desktop saw cancelled once it makes the account, and a removal is remembered as declined', async () => {
    const decision = { clear: vi.fn(), decline: vi.fn() }
    const made = fake({ statusAfter: reported, setupDecision: decision })
    expect(await teamCommand(['setup'], made.deps)).toBe(0)
    expect(decision.clear).toHaveBeenCalledTimes(1)
    const cancelled = fake({ adminResult: { ok: false, code: 'CANCELLED', message: 'x' }, setupDecision: decision })
    await teamCommand(['setup'], cancelled.deps)
    expect(decision.clear).toHaveBeenCalledTimes(1)
    const removed = fake({ readConfig: () => config, setupDecision: decision })
    expect(await teamCommand(['remove'], removed.deps)).toBe(0)
    expect(decision.decline).toHaveBeenCalledTimes(1)
    expect(removed.out.join('\n')).toContain('will not make it again on its own')
    const failing = fake({ statusAfter: reported, setupDecision: { clear: () => { throw new Error('read-only') }, decline: vi.fn() } })
    expect(await teamCommand(['setup'], failing.deps)).toBe(0)
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
    // The script's reason has no full stop of its own; the sentence after it must not run on.
    const unsigned = fake({ adminResult: { ok: false, code: 'FAILED', message: 'could not get a sign-in code from your Harness sign-in; the team daemon runs without a new sign-in' } })
    expect(await teamCommand(['setup'], unsigned.deps)).toBe(1)
    expect(unsigned.err[0]).toBe('✗ The Harness Team account was not finished: could not get a sign-in code from your Harness sign-in; '
      + 'the team daemon runs without a new sign-in. Run `harness team setup` again; it repairs what is there.')
    const failedRemove = fake({ readConfig: () => config, adminResult: { ok: false, code: 'FAILED', message: 'The script stopped (exit 2).' } })
    expect(await teamCommand(['remove'], failedRemove.deps)).toBe(1)
    expect(failedRemove.err[0]).toBe('✗ The Harness Team account was not fully removed: The script stopped (exit 2). Run `harness team remove` again.')
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

  it('says whether the team account\'s engines are installed and signed in, and exactly how to sign them in', async () => {
    const f = fake({ readConfig: () => config, accountExists: vi.fn(async () => true) })
    f.status.set(STATUS, { version: 1, engines: { checkedAt: 1_000_000 - 60_000, claude: { installed: true, signedIn: false }, codex: { installed: false, signedIn: null } } })
    await teamCommand(['status'], f.deps)
    const text = f.out.join('\n')
    expect(text).toContain('engines     Claude Code ✓ installed · ✗ not signed in')
    expect(text).toContain('Codex       ✗ not installed · harness team setup installs it')
    expect(text).toContain('(checked 60s ago)')
    expect(text).toContain('in Harness, open a terminal on this Mac\'s Harness Team machine')
    expect(text).toContain('    claude                      Claude Code')
    const json = fake({ readConfig: () => config, accountExists: vi.fn(async () => true) })
    json.status.set(STATUS, { version: 1, engines: { checkedAt: 5, claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } } })
    await teamCommand(['status', '--json'], json.deps)
    expect(JSON.parse(json.out[0]!).engines).toEqual({ checkedAt: 5, claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } })
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
  // The team daemon's computer id as its file holds it, with dashes; the backend lists it without (MACHINES).
  const removed = { ok: true as const, stdout: `harness: deleted the account harnessteam\nharness: team computer ${TEAM_COMPUTER}\nharness: removed the Harness Team account, its home folder and its daemon\n` }
  const refused = { ok: false as const, code: 'FAILED' as const, status: 9,
    message: 'could not delete the account harnessteam: macOS did not allow it (eDSPermissionError). Nothing was removed: the Harness Team account and its daemon run as before' }

  it('runs one privileged removal with what the config names, behind the prompt when not in a terminal', async () => {
    const f = fake({ readConfig: () => ({ ...config, env: { AUTONOMOUS_ENV: 'stag' } }), adminResult: removed })
    expect(await teamCommand(['remove'], f.deps)).toBe(0)
    expect(f.prompts[0]).toContain('remove the Harness Team account')
    expect(f.vias[0]).toBe('prompt')
    expect(f.built[0]!.script).toContain("TEAM_HOME='/Users/harnessteam'")
    expect(f.built[0]!.script).toContain(`SENTINEL='${OWNER_HOME}/.harness-team-privacy'`)
    expect(f.out.join('\n')).toContain('Your home folder stays private')
  })

  it('in a terminal, runs it with sudo there, so macOS can ask to let the terminal administer the Mac', async () => {
    const f = fake({ readConfig: () => config, interactive: true, adminResult: removed })
    expect(await teamCommand(['remove'], f.deps)).toBe(0)
    expect(f.vias[0]).toBe('sudo')
    expect(f.out[0]).toContain('sudo asks for your password here; macOS may then ask to let this terminal administer your computer')
    const cancelled = fake({ readConfig: () => config, interactive: true, adminResult: { ok: false, code: 'CANCELLED', message: '' } })
    expect(await teamCommand(['remove'], cancelled.deps)).toBe(1)
    expect(cancelled.err[0]).toBe('✗ Nothing was removed: sudo did not get an administrator password.')
  })

  it('takes the team account\'s computer off the owner\'s account once the account is gone, which signs it out', async () => {
    const f = fake({ readConfig: () => config, adminResult: removed })
    expect(await teamCommand(['remove'], f.deps)).toBe(0)
    // Only the team machine with that computer id: not this computer's, not another team machine.
    expect(f.deps.delete).toHaveBeenCalledTimes(1)
    expect(f.deps.delete).toHaveBeenCalledWith('/api/machines/m-team', { authorization: 'Bearer x' })
    expect(f.out.join('\n')).toContain('✓ Took its computer off your Harness account, which signs it out.')
    expect(f.post).not.toHaveBeenCalled()
    const json = fake({ readConfig: () => config, adminResult: removed })
    await teamCommand(['remove', '--json'], json.deps)
    expect(JSON.parse(json.out.at(-1)!)).toEqual({ ok: true, removed: true, computer: { removed: 1 } })
  })

  it('never takes off this computer\'s own machine, or anything when no computer was named', async () => {
    const own = fake({ readConfig: () => config, adminResult: { ok: true, stdout: `harness: team computer ${'c'.repeat(32)}\n` } })
    expect(await teamCommand(['remove'], own.deps)).toBe(0)
    expect(own.deps.delete).not.toHaveBeenCalled()
    const unnamed = fake({ readConfig: () => config, adminResult: { ok: true, stdout: 'harness: removed the Harness Team account, its home folder and its daemon\n' } })
    expect(await teamCommand(['remove'], unnamed.deps)).toBe(0)
    expect(unnamed.deps.get).not.toHaveBeenCalled()
    expect(unnamed.deps.delete).not.toHaveBeenCalled()
    expect(unnamed.out.join('\n')).toContain('If its computer, "Mac-placeholder · Team", is still on your Harness account, remove it there: harness machines')
  })

  it('says how to finish when the computer cannot be taken off: signed out here, or the backend failing', async () => {
    const signedOut = fake({ readConfig: () => config, adminResult: removed, session: () => null })
    expect(await teamCommand(['remove'], signedOut.deps)).toBe(0)
    expect(signedOut.out.join('\n')).toContain('! Its computer is still on your Harness account (this computer is not signed in to Harness). '
      + 'Remove "Mac-placeholder · Team": harness machines')
    const failing = fake({ readConfig: () => config, adminResult: removed, delete: vi.fn(async () => { throw new Error('backend unavailable') }) as never })
    expect(await teamCommand(['remove'], failing.deps)).toBe(0)
    expect(failing.out.join('\n')).toContain('(backend unavailable)')
  })

  it('when macOS keeps the account, says that nothing was removed and exactly what to do', async () => {
    const f = fake({ readConfig: () => config, adminResult: refused })
    expect(await teamCommand(['remove'], f.deps)).toBe(1)
    const text = f.err.join('\n')
    expect(f.err[0]).toBe('✗ macOS kept the Harness Team account: could not delete the account harnessteam: macOS did not allow it (eDSPermissionError). '
      + 'Nothing was removed: the Harness Team account and its daemon run as before.')
    expect(text).toContain('run harness team remove in Terminal')
    expect(text).toContain('macOS asks to let Terminal')
    expect(text).toContain('delete "Harness Team" in System Settings > Users & Groups (ⓘ, Delete User…, Delete the home folder)')
    // Nothing on the backend: the account still runs, signed in.
    expect(f.deps.get).not.toHaveBeenCalled()
    expect(f.deps.delete).not.toHaveBeenCalled()
    expect(f.post).not.toHaveBeenCalled()
    const terminal = fake({ readConfig: () => config, interactive: true, adminResult: refused, env: { __CFBundleIdentifier: 'com.apple.Terminal' } })
    expect(await teamCommand(['remove'], terminal.deps)).toBe(1)
    expect(terminal.err.join('\n')).toContain('it asks again after: tccutil reset SystemPolicySysAdminFiles com.apple.Terminal')
    const odd = fake({ readConfig: () => config, interactive: true, adminResult: refused, env: { __CFBundleIdentifier: 'x; rm -rf ~' } })
    await teamCommand(['remove'], odd.deps)
    expect(odd.err.join('\n')).toContain('it asks again after: tccutil reset SystemPolicySysAdminFiles\n')
    const json = fake({ readConfig: () => config, adminResult: refused })
    await teamCommand(['remove', '--json'], json.deps)
    expect(JSON.parse(json.out[0]!)).toMatchObject({ ok: false, code: 'DELETE_REFUSED', next: expect.arrayContaining([expect.stringContaining('Users & Groups')]) })
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
    expect(cancelled.err[0]).toBe('✗ Nothing was removed: the administrator prompt was cancelled.')
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

  // 10-27: a sign-out nobody asked for (a desktop test's `harness logout`) signed a whole Mac out. `team off`
  // takes the sign-in away too, so it asks the same: a terminal, or the flag a person's button passes.
  it('off with no terminal and no flag refuses, and keeps the team sign-in and its refresh token', async () => {
    const f = fake()
    const team = { ...computer, kind: 'team' as const, refreshToken: 'htr_team' }
    f.setSession(team)

    expect(await teamCommand(['off'], f.deps)).toBe(1)

    expect(f.session()).toEqual(team)
    expect(f.post).not.toHaveBeenCalledWith('/api/auth/revoke', expect.anything())
    expect(f.deps.stopDaemon).not.toHaveBeenCalled()
    expect(f.err.join('\n')).toContain('--from-sign-out-button')
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
    expect(await teamCommand(['off', SIGN_OUT_BUTTON_FLAG], quiet.deps)).toBe(0)
    expect(quiet.out.join('\n')).toContain('harness login')
    expect(quiet.deps.startDaemon).toHaveBeenCalled()
    const json = fake()
    json.setSession({ ...computer, kind: 'team' })
    expect(await teamCommand(['off', '--json', SIGN_OUT_BUTTON_FLAG], json.deps)).toBe(0)
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
    // Its machine, before its daemon starts: launchd runs the master directly, and `harness start` would have resolved it.
    expect(f.post.mock.calls.map(([path]) => path)).toEqual(['/api/auth/handoff/redeem', '/api/machines/resolve-computer'])
    expect(f.post).toHaveBeenLastCalledWith('/api/machines/resolve-computer', { computerId: 't'.repeat(32), label: 'Mac-placeholder · Team' },
      { authorization: 'Bearer x' })
    expect(f.session()).toMatchObject({ kind: 'team', machineId: 'm-team', refreshToken: 'hnr_team' })
    expect(f.out.join('\n')).toContain('[team] runs as machine m-team')
    expect(f.status.get(STATUS)).toMatchObject({ signIn: { state: 'signed-in' }, privacy: { passed: true },
      engines: { claude: { installed: true, signedIn: false }, codex: { installed: true, signedIn: true } } })
    expect(f.deps.engines).toHaveBeenCalledWith(config)
    expect(f.out.join('\n')).toContain('[team] signed in for team work')
    expect(f.out.join('\n')).toContain('[team] engines: claude installed, codex signed in')
    const broken = inTeam({ engines: vi.fn(async () => { throw new Error('no home') }) })
    expect(await teamCommand(['__start'], broken.deps)).toBe(0)
    expect(broken.out.join('\n')).toContain('could not check the engines: no home')
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

  it('__start records the machine of a team sign-in that has none, once, and starts the daemon when it cannot', async () => {
    // A team account set up before this: signed in, but its daemon ran as its computer id (third VM run).
    const older = inTeam({ takeHandoff: () => null })
    older.setSession({ ...computer, kind: 'team', refreshToken: 'htr_old', machineId: undefined })
    expect(await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], older.deps)).toBe(0)
    expect(older.post).toHaveBeenCalledWith('/api/machines/resolve-computer', { computerId: 'c'.repeat(32), label: 'Mac-placeholder · Team' },
      { authorization: 'Bearer x' })
    expect(older.session()).toMatchObject({ kind: 'team', machineId: 'm-team', refreshToken: 'htr_old' })
    older.post.mockClear()
    await teamCommand(['__start'], older.deps)
    expect(older.post).not.toHaveBeenCalled()
    const offline = inTeam({ takeHandoff: () => null, post: (async () => { throw new Error('connect ECONNREFUSED') }) as never })
    offline.setSession({ ...computer, kind: 'team', machineId: undefined })
    expect(await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], offline.deps)).toBe(0)
    expect(offline.session()?.machineId).toBeUndefined()
    expect(offline.out.join('\n')).toContain('could not look up this account\'s machine yet (connect ECONNREFUSED)')
    expect(offline.status.get(STATUS)).toMatchObject({ privacy: { passed: true } })
    // Only a team sign-in: the owner's own computer resolves its machine with `harness start`.
    const owner = fake({ readConfig: () => config, takeHandoff: () => null })
    owner.setSession({ ...computer, machineId: undefined })
    await teamCommand(['__start'], owner.deps)
    expect(owner.post).not.toHaveBeenCalled()
  })

  it('__start replaces a sign-in with a handed-over code (setup --sign-in-again), and keeps it when the code is refused', async () => {
    const signed = inTeam()
    signed.setSession({ ...computer, kind: 'team', refreshToken: 'htr_old' })
    await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], signed.deps)
    expect(signed.post).toHaveBeenCalledWith('/api/auth/handoff/redeem', { code: CODE, label: 'Mac-placeholder · Team', computerId: 't'.repeat(32) })
    expect(signed.session()).toMatchObject({ kind: 'team', refreshToken: 'hnr_team' })
    expect(signed.post).toHaveBeenCalledWith('/api/auth/revoke', { refreshToken: 'htr_old' })
    expect(signed.out.join('\n')).toContain('signed in for team work again; the previous sign-in was ended')
    expect(signed.status.get(STATUS)?.signIn).toMatchObject({ state: 'signed-in' })
    const refused = inTeam({ post: (async (path: string) => {
      if (path === '/api/auth/handoff/redeem') throw Object.assign(new Error('expired'), { status: 401 })
      return {}
    }) as never })
    refused.setSession({ ...computer, kind: 'team', refreshToken: 'htr_old' })
    await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], refused.deps)
    expect(refused.session()).toMatchObject({ kind: 'team', refreshToken: 'htr_old', machineId: 'm1' })
    expect(refused.out.join('\n')).toContain('the previous sign-in is kept')
    expect(refused.status.get(STATUS)?.signIn).toMatchObject({ state: 'failed' })
  })

  it('__start runs the check with no code, and writes nothing outside the team account', async () => {
    const failing = inTeam({ takeHandoff: () => null, privacy: () => ({ passed: false, item: 'ssh', detail: 'could read ~/.ssh', checkedAt: 1 }) })
    await teamCommand(['__start', '/Users/harnessteam/.harness/team-handoff'], failing.deps)
    expect(failing.out.join('\n')).toContain('privacy check FAILED (ssh)')
    const owner = fake({ readConfig: () => config })
    await teamCommand(['__start'], owner.deps)
    expect(owner.deps.writeStatus).not.toHaveBeenCalled()
    expect(owner.deps.privacy).not.toHaveBeenCalled()
  })
})

describe('parseLaunchctlPrint', () => {
  it('reads the pid and state, and a job launchd does not know as not loaded', () => {
    expect(parseLaunchctlPrint(0, 'system/ai.autonomous.harness.team = {\n\tstate = running\n\tpid = 812\n}')).toEqual({ loaded: true, pid: 812, state: 'running' })
    expect(parseLaunchctlPrint(0, '\tstate = not running\n')).toEqual({ loaded: true, pid: null, state: 'not running' })
    expect(parseLaunchctlPrint(113, 'Could not find service')).toEqual({ loaded: false, pid: null, state: null })
  })
})
