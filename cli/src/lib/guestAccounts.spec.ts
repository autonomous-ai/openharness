import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createGuestAccounts, GUEST_ENV_KEYS, GUEST_HELPER_PATH, guestEnvAllowed, GuestHelperError, guestHelperFailure, guestHomeRoot,
  guestRunCommand, guestUserFor, guestWorkspaceFor, runGuestCommand, type GuestRunner,
} from './guestAccounts.js'
import { guestSudoersTemplate } from './guestHelperAssets.js'

const HELPER = fileURLToPath(new URL('../../assets/guest-helper/guest-helper.sh', import.meta.url))
const USER = guestUserFor('ann@example.com')

describe('a guest\'s user and the command that runs as it', () => {
  it('names a guest by the hash of its lower-cased email', () => {
    expect(USER).toMatch(/^hg_[0-9a-f]{12}$/)
    expect(guestUserFor('  Ann@Example.COM ')).toBe(USER)
    expect(guestUserFor('bob@example.com')).not.toBe(USER)
  })

  it('passes a guest\'s variables in the environment, never on the command line, and only the allowed ones', () => {
    const run = guestRunCommand(USER, '/Users/Shared/HarnessGuests/x/work', { ANTHROPIC_AUTH_TOKEN: 'relay-token', TERM: 'xterm' }, ['claude', '--resume', 'a b'])
    expect(run.argv).toEqual(['sudo', '-n', GUEST_HELPER_PATH, 'run', USER, '--cwd', '/Users/Shared/HarnessGuests/x/work',
      '--pass', 'ANTHROPIC_AUTH_TOKEN', '--pass', 'TERM', '--', 'claude', '--resume', 'a b'])
    expect(run.argv.join(' ')).not.toContain('relay-token')
    expect(run.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'relay-token', TERM: 'xterm' })
    expect(() => guestRunCommand(USER, '/w', { PATH: '/evil' }, ['x'])).toThrow(expect.objectContaining({ code: 'GUEST_ENV_NOT_ALLOWED' }))
    expect(() => guestRunCommand(USER, '/w', { GRID_API_KEY: 'k' }, ['x'])).toThrow(expect.objectContaining({ code: 'GUEST_ENV_NOT_ALLOWED' }))
    expect(() => guestRunCommand('hg_nothex', '/w', {}, ['x'])).toThrow(expect.objectContaining({ code: 'GUEST_INVALID' }))
    expect(() => guestRunCommand('owner', '/w', {}, ['x'])).toThrow(expect.objectContaining({ code: 'GUEST_INVALID' }))
    expect(() => guestRunCommand(USER, 'work', {}, ['x'])).toThrow(expect.objectContaining({ code: 'GUEST_INVALID' }))
    expect(() => guestRunCommand(USER, '/w', {}, [])).toThrow(expect.objectContaining({ code: 'GUEST_INVALID' }))
    expect(guestEnvAllowed('LC_ALL')).toBe(true)
    expect(guestEnvAllowed('LC_')).toBe(false)
    expect(guestEnvAllowed('HOME')).toBe(false)
  })

  it('keeps one list of a guest\'s variables in the helper, the sudoers drop-in and here', async () => {
    const { readFileSync } = await import('node:fs')
    const helperKeys = /^GUEST_ENV_KEYS='([^']+)'$/m.exec(readFileSync(HELPER, 'utf8'))?.[1].split(' ')
    expect(helperKeys).toEqual([...GUEST_ENV_KEYS])
    const kept = /env_keep \+= "([^"]+)"/.exec(guestSudoersTemplate())?.[1].split(' ')
    expect(kept).toEqual(['TERM', 'COLORTERM', 'LANG', 'LC_*', ...GUEST_ENV_KEYS.slice(3)])
  })
})

describe('the helper\'s answers, read', () => {
  it('tells a missing helper, a missing authorization and a refused argument apart', () => {
    expect(guestHelperFailure({ code: 1, stdout: '', stderr: 'sudo: a password is required\n' }).code).toBe('GUEST_HELPER_NOT_AUTHORIZED')
    expect(guestHelperFailure({ code: 1, stdout: '', stderr: 'sudo: a terminal is required to read the password' }).code).toBe('GUEST_HELPER_NOT_AUTHORIZED')
    expect(guestHelperFailure({ code: 1, stdout: '', stderr: 'Sorry, user ann is not allowed to execute \'/x\' as root' }).code).toBe('GUEST_HELPER_NOT_AUTHORIZED')
    expect(guestHelperFailure({ code: null, stdout: '', stderr: 'spawn sudo ENOENT' }).code).toBe('GUEST_HELPER_MISSING')
    expect(guestHelperFailure({ code: 1, stdout: '', stderr: 'sudo: /usr/local/libexec/harness/guest-helper: command not found' }).code).toBe('GUEST_HELPER_MISSING')
    const refused = guestHelperFailure({ code: 2, stdout: '', stderr: 'guest-helper: outside the guest\'s home: /tmp\n' })
    expect(refused).toMatchObject({ code: 'GUEST_INVALID', message: 'outside the guest\'s home: /tmp' })
    expect(guestHelperFailure({ code: 3, stdout: '', stderr: 'guest-helper: no such guest: hg_000000000000' }).code).toBe('GUEST_INVALID')
    expect(guestHelperFailure({ code: 4, stdout: '', stderr: '' })).toMatchObject({ code: 'GUEST_HELPER_FAILED', message: 'The guest helper failed (4).' })
  })
})

describe('a guest\'s account, through the helper', () => {
  const account = { user: USER, home: `/Users/Shared/HarnessGuests/${USER}`, workspace: `/Users/Shared/HarnessGuests/${USER}/work` }
  const answering = (stdout: string, code = 0): GuestRunner & ReturnType<typeof vi.fn> =>
    vi.fn(async () => ({ code, stdout, stderr: '' })) as never

  it('creates it once, by sudo -n, and remembers it', async () => {
    const runner = answering(`${JSON.stringify(account)}\n`)
    const guests = createGuestAccounts({ runner, installed: () => true })
    const [a, b] = await Promise.all([guests.ensureGuest('Ann@Example.com'), guests.ensureGuest('ann@example.com')])
    expect(a).toEqual(account)
    expect(b).toEqual(account)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith('sudo', ['-n', GUEST_HELPER_PATH, 'ensure', 'ann@example.com'], { timeoutMs: 60_000 })
  })

  it('refuses an answer that is not the account it asked for, and does not remember a failure', async () => {
    const wrong = createGuestAccounts({ runner: answering(JSON.stringify({ ...account, user: 'hg_000000000000' })), installed: () => true })
    await expect(wrong.ensureGuest('ann@example.com')).rejects.toMatchObject({ code: 'GUEST_HELPER_FAILED' })
    const outside = createGuestAccounts({ runner: answering(JSON.stringify({ ...account, workspace: '/tmp/work' })), installed: () => true })
    await expect(outside.ensureGuest('ann@example.com')).rejects.toMatchObject({ code: 'GUEST_HELPER_FAILED' })
    const garbled = createGuestAccounts({ runner: answering('not json'), installed: () => true })
    await expect(garbled.ensureGuest('ann@example.com')).rejects.toMatchObject({ code: 'GUEST_HELPER_FAILED' })

    let answer = { code: 1, stdout: '', stderr: 'sudo: a password is required' }
    const runner = vi.fn(async () => answer)
    const guests = createGuestAccounts({ runner, installed: () => true })
    await expect(guests.ensureGuest('ann@example.com')).rejects.toMatchObject({ code: 'GUEST_HELPER_NOT_AUTHORIZED' })
    answer = { code: 0, stdout: JSON.stringify(account), stderr: '' }
    await expect(guests.ensureGuest('ann@example.com')).resolves.toEqual(account)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('does not run sudo at all when the helper is not installed', async () => {
    const runner = answering('')
    const guests = createGuestAccounts({ runner, installed: () => false })
    await expect(guests.ensureGuest('ann@example.com')).rejects.toMatchObject({ code: 'GUEST_HELPER_MISSING' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('installs an engine as the guest with its progress, and removes a guest it forgets', async () => {
    const runner = answering(JSON.stringify(account))
    const guests = createGuestAccounts({ runner, installed: () => true, helperPath: '/opt/helper' })
    const onLine = vi.fn()
    await guests.installGuestEngine(USER, 'codex', onLine)
    expect(runner).toHaveBeenLastCalledWith('sudo', ['-n', '/opt/helper', 'install', USER, 'codex'], { timeoutMs: 600_000, onLine })
    await guests.installGuestEngine(USER, 'claude')
    expect(runner).toHaveBeenLastCalledWith('sudo', ['-n', '/opt/helper', 'install', USER, 'claude'], { timeoutMs: 600_000 })
    await expect(guests.installGuestEngine(USER, 'cursor' as never)).rejects.toMatchObject({ code: 'GUEST_INVALID' })
    await expect(guests.installGuestEngine('root', 'claude')).rejects.toMatchObject({ code: 'GUEST_INVALID' })

    await guests.ensureGuest('ann@example.com')
    await guests.removeGuest(USER)
    expect(runner).toHaveBeenLastCalledWith('sudo', ['-n', '/opt/helper', 'remove', USER], { timeoutMs: 60_000 })
    const calls = runner.mock.calls.length
    await guests.ensureGuest('ann@example.com')
    expect(runner.mock.calls.length).toBe(calls + 1)
    await expect(guests.removeGuest('hg_bad')).rejects.toMatchObject({ code: 'GUEST_INVALID' })
    expect(guests.runCommand(USER, '/w', {}, ['x']).argv[2]).toBe('/opt/helper')
  })

  it('shares the owner\'s folders with a guest through the helper, and lists the guests that have an account', async () => {
    const runner = answering('')
    const guests = createGuestAccounts({ runner, installed: () => true, helperPath: '/opt/helper', homes: () => [USER, 'notes.txt', 'hg_bad', 'hg_000000000001'] })
    await guests.shareFolders(USER, [{ path: '/Users/dee/code', write: true }, { path: '/Users/dee/docs', write: false }])
    // A first share of a large folder sets an entry on everything in it: it may take minutes.
    expect(runner).toHaveBeenLastCalledWith('sudo', ['-n', '/opt/helper', 'share', USER, '--write', '/Users/dee/code', '--read', '/Users/dee/docs'], { timeoutMs: 600_000 })
    await guests.shareFolders(USER, [])
    expect(runner).toHaveBeenLastCalledWith('sudo', ['-n', '/opt/helper', 'share', USER], { timeoutMs: 600_000 })
    await expect(guests.shareFolders('root', [])).rejects.toMatchObject({ code: 'GUEST_INVALID' })
    expect(guests.guests()).toEqual(['hg_000000000001', USER].sort())
    // The machine's own home root, which a test never has: no guests.
    expect(createGuestAccounts().guests()).toEqual(expect.any(Array))
  })

  it('keeps guests\' homes under one root per platform, a workspace in each', () => {
    expect(guestHomeRoot('darwin')).toBe('/Users/Shared/HarnessGuests')
    expect(guestHomeRoot('linux')).toBe('/home/harness-guests')
    expect(guestHomeRoot()).toBe(guestHomeRoot(process.platform))
    expect(guestWorkspaceFor('Ann@Example.com', 'darwin')).toBe(`/Users/Shared/HarnessGuests/${USER}/work`)
    expect(guestWorkspaceFor('ann@example.com')).toBe(`${guestHomeRoot()}/${USER}/work`)
  })

  it('runs a command and hears its lines; a command that is not there is code null', async () => {
    const lines: string[] = []
    const result = await runGuestCommand(process.execPath, ['-e', 'process.stdout.write("one\\ntwo\\nthree")'], { onLine: (line) => lines.push(line), timeoutMs: 10_000 })
    expect(result).toMatchObject({ code: 0, stdout: 'one\ntwo\nthree' })
    expect(lines).toEqual(['one', 'two', 'three'])
    expect((await runGuestCommand(process.execPath, ['-e', 'process.stderr.write("no");process.exit(3)'])).code).toBe(3)
    expect((await runGuestCommand('harness-no-such-command-anywhere', [])).code).toBeNull()
  })
})

// The helper itself, in its dry run: validation is real, the commands are printed instead of run.
// Never as root (the helper refuses a dry run there) and never with sudo: nothing here touches the machine.
describe.skipIf(process.getuid?.() === 0)('the guest helper, dry run', () => {
  let root: string
  // The owner's side: a home with a closed folder in it, and the helper's record of what it shared.
  let owner: string
  let state: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'guest-helper-')))
    owner = realpathSync(mkdtempSync(join(tmpdir(), 'guest-owner-')))
    state = realpathSync(mkdtempSync(join(tmpdir(), 'guest-state-')))
    mkdirSync(join(owner, 'docs'))
    mkdirSync(join(owner, 'code', 'app', 'src'), { recursive: true })
    chmodSync(owner, 0o755)
    chmodSync(join(owner, 'code'), 0o750)
  })
  afterAll(() => { for (const dir of [root, owner, state]) rmSync(dir, { recursive: true, force: true }) })

  const helper = (args: string[], platform = 'Darwin', extra: Record<string, string> = {}) => {
    const result = spawnSync('sh', [HELPER, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HARNESS_GUEST_HELPER_DRY_RUN: '1', HARNESS_GUEST_HELPER_DRY_HOME_ROOT: root,
        HARNESS_GUEST_HELPER_DRY_STATE_DIR: state, HARNESS_GUEST_HELPER_DRY_OWNER_HOME: owner, HARNESS_GUEST_HELPER_PLATFORM: platform, ...extra },
    })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('parses, in sh and in dash', () => {
    expect(spawnSync('sh', ['-n', HELPER]).status).toBe(0)
    const dash = spawnSync('dash', ['-n', HELPER])
    if (!dash.error) expect(dash.status).toBe(0)
  })

  it('names the version this CLI ships', () => {
    expect(helper(['version']).stdout.trim()).toMatch(/^\d+$/)
  })

  it('creates a hidden macOS user in a group of its own, with a 0700 home the owner may read', () => {
    const made = helper(['ensure', 'Ann@Example.COM'])
    expect(made.code).toBe(0)
    const answer = JSON.parse(made.stdout)
    expect(answer).toEqual({ user: USER, home: `${root}/${USER}`, workspace: `${root}/${USER}/work` })
    const said = made.stderr
    for (const line of [
      `+ 'dscl' '.' '-create' '/Groups/harnessguest' 'PrimaryGroupID' '600'`,
      `+ 'dscl' '.' '-create' '/Users/${USER}' 'PrimaryGroupID' '600'`,
      `+ 'dscl' '.' '-create' '/Users/${USER}' 'UserShell' '/bin/zsh'`,
      `+ 'dscl' '.' '-create' '/Users/${USER}' 'RealName' 'Harness guest ann@example.com'`,
      `+ 'dscl' '.' '-create' '/Users/${USER}' 'NFSHomeDirectory' '${root}/${USER}'`,
      `+ 'dscl' '.' '-create' '/Users/${USER}' 'IsHidden' '1'`,
      `+ 'dscl' '.' '-create' '/Users/${USER}' 'Password' '*'`,
      `+ 'chmod' '700' '${root}/${USER}'`,
      `+ 'chown' '${USER}:harnessguest' '${root}/${USER}/work'`,
    ]) expect(said).toContain(line)
    // Never the staff group every standard account shares, which can enter the owner's home.
    expect(said).not.toContain("'PrimaryGroupID' '20'")
    expect(said).toMatch(/'chmod' '\+a' '[^']+ allow list,search,readattr,readextattr,readsecurity,read,file_inherit,directory_inherit'/)
  })

  it('creates a Linux system user with useradd, and a default ACL for the owner', () => {
    const made = helper(['ensure', 'bob@example.com'], 'Linux')
    expect(made.code).toBe(0)
    const bob = guestUserFor('bob@example.com')
    expect(made.stderr).toContain(`+ 'groupadd' '-r' '-f' 'harnessguest'`)
    expect(made.stderr).toContain(`+ 'useradd' '-r' '-m' '-d' '${root}/${bob}' '-g' 'harnessguest' '-s' '/bin/bash' '-c' 'Harness guest bob@example.com' '${bob}'`)
    expect(made.stderr).toMatch(/\+ 'setfacl' '-d' '-m' 'u:[^']+:rX'/)
  })

  it('refuses what is not an email address', () => {
    for (const bad of ['nope', 'a@b', 'x@-bad.com', 'x@bad-.com', 'a b@x.com', '"a"@x.com', 'a@x.c0']) {
      expect(helper(['ensure', bad]).code, bad).toBe(2)
    }
    expect(helper(['ensure']).code).toBe(2)
    expect(helper(['ensure', 'a@x.com', 'b@x.com']).code).toBe(2)
  })

  describe('run', () => {
    let work: string
    beforeAll(() => {
      work = join(root, USER, 'work')
      mkdirSync(join(work, 'project'), { recursive: true })
      symlinkSync('/', join(work, 'escape'))
    })

    it('runs the command as the guest, with only the allowed variables, in its folder', () => {
      const ran = helper(['run', USER, '--cwd', join(work, 'project'), '--pass', 'ANTHROPIC_AUTH_TOKEN', '--pass', 'HARNESS_HOOK_TOKEN',
        '--env', 'TERM=xterm-256color', '--', 'claude', '--resume', 'a b'], 'Darwin', { ANTHROPIC_AUTH_TOKEN: "relay token 'quoted'" })
      expect(ran).toMatchObject({ code: 0, stderr: '' })
      expect(ran.stdout.trim()).toBe(['+', ...[
        'sudo', '-u', USER, '-H', 'env', '-i', `HOME=${root}/${USER}`, `USER=${USER}`, `LOGNAME=${USER}`, 'SHELL=/bin/zsh',
        `PATH=${root}/${USER}/.local/bin:${root}/${USER}/.opencode/bin:/usr/local/lib/harness/node/bin:/usr/local/bin:/usr/bin:/bin`,
        // (An unset --pass is left out.)
        "ANTHROPIC_AUTH_TOKEN=relay token 'quoted'", 'TERM=xterm-256color',
        '/bin/sh', '-c', 'cd "$1" || exit 1; shift; exec "$@"', 'harness-guest', join(work, 'project'),
        'claude', '--resume', 'a b',
      ].map((word) => `'${word.replaceAll("'", `'\\''`)}'`)].join(' '))
    })

    it('refuses a variable the guest may not have, a folder outside its home, and an unknown or malformed user', () => {
      const refused = (args: string[], code = 2) => {
        const ran = helper(args)
        expect(ran.code, args.join(' ')).toBe(code)
        expect(ran.stdout).toBe('')
        return ran.stderr
      }
      expect(refused(['run', USER, '--cwd', work, '--env', 'PATH=/evil', '--', 'x'])).toContain('not allowed for a guest: PATH')
      expect(refused(['run', USER, '--cwd', work, '--pass', 'GRID_API_KEY', '--', 'x'])).toContain('not allowed for a guest: GRID_API_KEY')
      expect(refused(['run', USER, '--cwd', work, '--env', 'TERM', '--', 'x'])).toContain('not KEY=VALUE')
      expect(refused(['run', USER, '--cwd', '/tmp', '--', 'x'])).toContain('outside the guest\'s home and shared folders')
      // A folder of the owner's is the guest's only once it is shared with it.
      expect(refused(['run', USER, '--cwd', join(owner, 'docs'), '--', 'x'])).toContain('outside the guest\'s home and shared folders')
      expect(refused(['run', USER, '--cwd', join(work, 'escape'), '--', 'x'])).toContain('outside the guest\'s home')
      expect(refused(['run', USER, '--cwd', `${work}/../..`, '--', 'x'])).toContain('outside the guest\'s home')
      expect(refused(['run', USER, '--cwd', 'work', '--', 'x'])).toContain('not an absolute path')
      expect(refused(['run', USER, '--cwd', join(work, 'missing'), '--', 'x'])).toContain('no such folder')
      expect(refused(['run', USER, '--cwd', work, '--'])).toContain('nothing to run')
      expect(refused(['run', USER, '--', 'x'])).toContain('a --cwd is required')
      expect(refused(['run', USER, '--cwd', work, 'x'])).toContain('unexpected argument')
      expect(refused(['run', USER, '--cwd'])).toContain('usage')
      expect(refused(['run', 'hg_xyz', '--cwd', work, '--', 'x'])).toContain('not a guest user')
      expect(refused(['run', 'root', '--cwd', work, '--', 'x'])).toContain('not a guest user')
      expect(refused(['run', 'hg_000000000000', '--cwd', work, '--', 'x'], 3)).toContain('no such guest')
    })
  })

  describe('share', () => {
    const READ = 'list,search,readattr,readextattr,readsecurity,read,execute'
    const WRITE = `${READ},write,append,add_file,add_subdirectory,delete_child,delete,writeattr,writeextattr`
    const lines = (out: string) => out.trim().split('\n').filter(Boolean)
    const acl = (verb: '+a' | '-a', perms: string, dir: string) => `+ 'chmod' '-R' '${verb}' '${USER} allow ${perms},file_inherit,directory_inherit' '${dir}'`
    const search = (verb: '+a' | '-a', dir: string) => `+ 'chmod' '${verb}' '${USER} allow search' '${dir}'`
    // The folders above the owner's own that its tests' temporary folder sits in, closed or not, say nothing here.
    const ours = (out: string) => lines(out).filter((line) => !/allow search' '/.test(line) || line.includes(owner))

    it('gives the guest exactly the owner\'s folders it is given, and changes only what changed', () => {
      rmSync(join(state, USER), { force: true })
      const docs = join(owner, 'docs'), app = join(owner, 'code', 'app')
      const first = helper(['share', USER, '--read', docs, '--write', `${owner}/code/./app`])
      expect(first).toMatchObject({ code: 0, stderr: '' })
      // The folders and what is in them, and the one closed folder above them: the guest passes through it, never lists it.
      expect(ours(first.stdout)).toEqual([acl('+a', READ, docs), acl('+a', WRITE, app), search('+a', join(owner, 'code'))])
      expect(readFileSync(join(state, USER), 'utf8')).toBe(`read\t${docs}\nwrite\t${app}\n`)
      expect(helper(['shared', USER]).stdout).toBe(`read\t${docs}\nwrite\t${app}\n`)
      // The same again changes nothing: the daemon asks on every read of the sharing.
      expect(helper(['share', USER, '--read', docs, '--write', app]).stdout).toBe('')
      // A run may start in a shared folder.
      expect(helper(['run', USER, '--cwd', join(app, 'src'), '--', 'claude'])).toMatchObject({ code: 0, stderr: '' })

      // Read only now, and the documents no longer: each taken back as it was given.
      expect(ours(helper(['share', USER, '--read', app]).stdout)).toEqual([acl('-a', READ, docs), acl('-a', WRITE, app), acl('+a', READ, app)])
      // Nothing: the folder above goes with the last folder under it.
      expect(ours(helper(['share', USER]).stdout)).toEqual([acl('-a', READ, app), search('-a', join(owner, 'code'))])
      expect(helper(['shared', USER]).stdout).toBe('')
      expect(helper(['run', USER, '--cwd', app, '--', 'claude']).stderr).toContain('outside the guest\'s home and shared folders')
    })

    it('uses access lists on Linux: the folders, their defaults for what is made later, and passage above them', () => {
      rmSync(join(state, USER), { force: true })
      const app = join(owner, 'code', 'app')
      const out = lines(helper(['share', USER, '--write', app], 'Linux').stdout).filter((line) => !/'u:[^']+:x'/.test(line) || line.includes(owner))
      expect(out).toEqual([
        `+ 'setfacl' '-R' '-m' 'u:${USER}:rwX' '${app}'`,
        `+ 'find' '${app}' '-type' 'd' '-exec' 'setfacl' '-d' '-m' 'u:${USER}:rwX' '{}' '+'`,
        `+ 'setfacl' '-m' 'u:${USER}:x' '${join(owner, 'code')}'`,
      ])
      expect(lines(helper(['share', USER], 'Linux').stdout).filter((line) => !/'-x' 'u:[^']+' '\//.test(line) || line.includes(owner))).toEqual([
        `+ 'setfacl' '-R' '-x' 'u:${USER}' '${app}'`,
        `+ 'find' '${app}' '-type' 'd' '-exec' 'setfacl' '-d' '-x' 'u:${USER}' '{}' '+'`,
        `+ 'setfacl' '-x' 'u:${USER}' '${join(owner, 'code')}'`,
      ])
    })

    it('shares only the owner\'s own folders: never /, its whole home, a guest\'s home, or another account\'s', () => {
      const refused = (args: string[]) => {
        const ran = helper(['share', USER, ...args])
        expect(ran.code, args.join(' ')).toBe(2)
        expect(ran.stdout).toBe('')
        return ran.stderr
      }
      expect(refused(['--read', 'docs'])).toContain('not an absolute path')
      expect(refused(['--read', join(owner, 'missing')])).toContain('no such folder')
      expect(refused(['--read', '/'])).toContain('not a folder that can be shared: /')
      expect(refused(['--write', owner])).toContain('whole home cannot be shared')
      expect(refused(['--read', join(root, USER, 'work')])).toContain('a guest\'s home cannot be shared')
      expect(refused(['--read', '/usr/bin'])).toContain('not the owner\'s folder')
      expect(refused(['--read', join(owner, 'docs'), '--write', join(owner, 'docs')])).toContain('shared twice')
      expect(refused(['--read'])).toContain('usage')
      expect(refused(['docs'])).toContain('unexpected argument')
      // One folder a line in the helper's record: a tab or a newline in a name could forge another.
      expect(refused(['--read', `${owner}/doc\tx`])).toContain('not a folder that can be shared')
      expect(refused(['--read', `${owner}/doc\nx`])).toContain('not a folder that can be shared')
      expect(helper(['share']).code).toBe(2)
      expect(helper(['share', 'hg_bad']).code).toBe(2)
      expect(helper(['shared']).code).toBe(2)
    })
  })

  it('installs an engine as the guest, and only the engines it knows', () => {
    const claude = helper(['install', USER, 'claude'])
    expect(claude.code).toBe(0)
    expect(claude.stdout).toContain(`'sudo' '-u' '${USER}' '-H' 'env' '-i'`)
    expect(claude.stdout).toContain("'curl -fsSL https://claude.ai/install.sh | bash'")
    const codex = helper(['install', USER, 'codex'])
    expect(codex.stdout).toContain(`'/usr/local/lib/harness/node/bin/npm' 'install' '-g' '@openai/codex' '--prefix' '${root}/${USER}/.local'`)
    expect(helper(['install', USER, 'opencode']).stdout).toContain('https://opencode.ai/install')
    expect(helper(['install', USER, 'cursor']).code).toBe(2)
    expect(helper(['install', 'hg_bad', 'claude']).code).toBe(2)
  })

  it('removes a guest: its shares, its processes, its user and its home', () => {
    rmSync(join(state, USER), { force: true })
    helper(['share', USER, '--read', join(owner, 'docs')])
    const removed = helper(['remove', USER])
    expect(removed.code).toBe(0)
    expect(removed.stdout).toContain(`+ 'chmod' '-R' '-a' '${USER} allow`)
    expect(removed.stdout.indexOf("'chmod' '-R' '-a'")).toBeLessThan(removed.stdout.indexOf("'dscl' '.' '-delete'"))
    expect(removed.stdout).toContain(`+ 'pkill' '-KILL' '-u' '${USER}'`)
    expect(removed.stdout).toContain(`+ 'dscl' '.' '-delete' '/Users/${USER}'`)
    expect(removed.stdout).toContain(`+ 'rm' '-rf' '${root}/${USER}'`)
    expect(helper(['remove', USER], 'Linux').stdout).toContain(`+ 'userdel' '-r' '${USER}'`)
  })

  it('refuses an unknown command, and a platform it does not know', () => {
    expect(helper(['format-disk']).code).toBe(2)
    expect(helper([]).code).toBe(2)
    expect(helper(['version'], 'Windows').code).toBe(2)
  })
})

it('a GuestHelperError carries its code', () => {
  const error = new GuestHelperError('GUEST_INVALID', 'x')
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ name: 'GuestHelperError', code: 'GUEST_INVALID', message: 'x' })
})
