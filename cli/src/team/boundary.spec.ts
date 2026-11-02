/**
 * The boundary a Harness Team account stands on: an agent in that account is refused every read and write in the home of
 * the Mac's or Linux computer's owner (audit of 2026-11-02, docs/security/2026-11-02-team-account-boundary.md).
 *
 * The other specs here check the setup script as text and the privacy check with made-up answers. Neither would notice a
 * home folder that the kernel lets another account into. These ask the kernel, about the mode the real setup script gives,
 * in a fixture folder: no real account, home or permission changes, and nothing here uses sudo beyond becoming `nobody`.
 *
 * Two ways to be the other account:
 * - As `nobody`, through `sudo -n`, where that needs no password: CI's Linux, where it may not be missing.
 * - Everywhere else (a shared Mac has no passwordless sudo, and its accounts are not ours to change): as this user, with the
 *   fixture's owner bits set to what the group and other bits say. The kernel then answers this user as it answers an account
 *   that is neither the owner nor, for that matter, kept out by anything but those bits. A Team account on a Mac is in the
 *   owner's group (staff), so both count.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SENTINEL_NAME } from './layout.js'
import { realPrivacyDeps, runPrivacyCheck } from './privacy.js'
import { buildLinuxSetupScript, buildSetupScript, type SetupScriptInput } from './script.js'

const SETUP: SetupScriptInput = {
  user: 'harnessteam', realName: 'Harness Team', home: '/Users/harnessteam', owner: 'owner-placeholder', ownerHome: '/Users/owner-placeholder',
  stageDir: '/private/var/folders/aa/T/harness-team-x1', nodeRuntimeDir: '/Users/owner-placeholder/.harness/runtime/node-v24',
  tmuxRuntimeDir: null, cliDir: '/Users/owner-placeholder/.harness/cli', ownerNode: '/Users/owner-placeholder/.harness/runtime/node-v24/bin/node',
  ownerCli: '/Users/owner-placeholder/.harness/cli/cli.js', mintEnv: {}, signIn: 'missing',
}

/** What the script's own step 3 does to the owner's home, as a mode; it throws on a step it does not know, or none. */
function ownerHomeMode(script: string): number {
  const lines = script.split('\n')
  const start = lines.findIndex(line => line.startsWith('# 3. '))
  const end = lines.findIndex(line => line.startsWith('# 4. '))
  expect(start, 'step 3, the owner\'s home').toBeGreaterThan(-1)
  const step = lines.slice(start, end).filter(line => /^(chmod|setfacl)\b.*"\$OWNER_HOME"$/.test(line))
  expect(step, 'the line of step 3 that closes the owner\'s home').toHaveLength(1)
  const line = step[0]!
  const chmod = /^chmod (\d{3}) /.exec(line)
  if (chmod) return Number.parseInt(chmod[1]!, 8)
  const acl = /^setfacl -n -m u::([rwx-]{3}),g::([rwx-]{3}),o::([rwx-]{3}) /.exec(line)
  if (!acl) throw new Error(`step 3 closes the owner's home in a way this spec cannot read: ${line}`)
  const bits = (word: string) => (word[0] === 'r' ? 4 : 0) + (word[1] === 'w' ? 2 : 0) + (word[2] === 'x' ? 1 : 0)
  return bits(acl[1]!) * 0o100 + bits(acl[2]!) * 0o10 + bits(acl[3]!)
}

/** Whether this process can be `nobody` with no password. */
const sudoNobody = process.platform !== 'win32' && process.getuid?.() !== 0
  && spawnSync('sudo', ['-n', '-u', 'nobody', '/usr/bin/id', '-u'], { stdio: 'ignore', timeout: 5_000 }).status === 0

/** Each fixture's path and the mode it would have for its owner, so a test can put it back and remove it. */
interface Fixture {
  root: string
  home: string
  /** A folder of the other account's own. */
  own: string
  modes: Map<string, number>
}

const fixtures: Fixture[] = []

/**
 * An owner's home, as a default install leaves it: open to the group and everyone (macOS's staff, older Debian's 755), with a
 * project folder anyone may write to, so nothing below the home's own mode would keep the other account out.
 */
function ownerHome(parent: string): Fixture {
  const root = realpathSync(mkdtempSync(join(parent, 'hb-')))
  chmodSync(root, 0o755)
  const home = join(root, 'owner'), own = join(root, 'other')
  mkdirSync(home)
  mkdirSync(own)
  chmodSync(own, 0o777)
  const entries: Array<[string, number, string | null]> = [
    [SENTINEL_NAME, 0o644, 'sentinel\n'],
    ['.gitconfig', 0o644, '[user]\n\tname = owner\n'],
    ['.ssh', 0o700, null],
    ['.ssh/id_ed25519', 0o600, 'not a real key\n'],
    ['code', 0o777, null],
    ['code/project.txt', 0o666, 'project\n'],
  ]
  const modes = new Map<string, number>([[home, 0o755]])
  for (const [name, mode, text] of entries) {
    const path = join(home, name)
    if (text === null) mkdirSync(path)
    else writeFileSync(path, text)
    modes.set(path, mode)
  }
  for (const [path, mode] of modes) chmodSync(path, mode)
  const fixture = { root, home, own, modes }
  fixtures.push(fixture)
  return fixture
}

/** Every path in the home with its contents and mode: what no refused write may change. */
function snapshot(fixture: Fixture): Record<string, string> {
  const seen: Record<string, string> = {}
  const walk = (path: string): void => {
    const info = lstatSync(path)
    seen[relative(fixture.home, path) || '.'] = info.isDirectory() ? 'folder' : readFileSync(path, 'utf8')
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
  }
  walk(fixture.home)
  return seen
}

/** Sets the fixture's owner bits to what its group and other bits allow: this user now gets what the other account gets. */
function seenFromOutside(fixture: Fixture, homeMode: number): void {
  // Files before the folders above them: a closed folder lets nothing below it change.
  for (const [path, mode] of [...fixture.modes].reverse()) {
    const actual = path === fixture.home ? homeMode : mode
    chmodSync(path, (((actual >> 3) | actual) & 0o7) * 0o111)
  }
}

/** The fixture's real modes again, so this user can read and remove it. */
function restored(fixture: Fixture, homeMode: number): void {
  for (const [path, mode] of fixture.modes) chmodSync(path, path === fixture.home ? homeMode : mode)
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    for (const path of fixture.modes.keys()) { try { chmodSync(path, 0o700) } catch { /* Removed by a write that should have been refused: its test said so. */ } }
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

type Run = (command: string) => { status: number | null; output: string }
const asThisUser: Run = (command) => {
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 10_000 })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}
const asNobody: Run = (command) => {
  const result = spawnSync('sudo', ['-n', '-u', 'nobody', '/bin/sh', '-c', `cd /; ${command}`], { encoding: 'utf8', timeout: 10_000 })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** Everything an agent in the other account might try, by name. A refusal must come from the kernel, not from a missing path. */
const attempts = ({ home, own }: Fixture): Record<string, string> => ({
  'read the sentinel': `cat '${home}/${SENTINEL_NAME}'`,
  'read a world-readable dotfile': `cat '${home}/.gitconfig'`,
  'read a private key': `cat '${home}/.ssh/id_ed25519'`,
  'read a world-readable project file': `cat '${home}/code/project.txt'`,
  'read through its own symbolic link': `ln -sf '${home}/.gitconfig' '${own}/link' && cat '${own}/link'`,
  'list the home': `ls -A '${home}'`,
  'list .ssh': `ls -A '${home}/.ssh'`,
  'list a project folder': `ls -A '${home}/code'`,
  'stat a file by name': `ls -l '${home}/.gitconfig'`,
  'create a file in the home': `: > '${home}/planted'`,
  'make a folder in the home': `mkdir '${home}/planted-folder'`,
  'leave a link in the home': `ln -s /tmp '${home}/planted-link'`,
  'overwrite a dotfile': `: > '${home}/.gitconfig'`,
  'append to a world-writable project file': `echo planted >> '${home}/code/project.txt'`,
  'create a file in a world-writable folder': `: > '${home}/code/planted'`,
  'delete a file': `rm -f '${home}/code/project.txt'`,
  'rename a file': `mv '${home}/.gitconfig' '${home}/moved'`,
  'hard-link a file out': `ln '${home}/.gitconfig' '${own}/hard'`,
})

/** Every attempt ends with the kernel's refusal, and the home is as it was. */
function expectRefused(run: Run, fixture: Fixture): void {
  for (const [what, command] of Object.entries(attempts(fixture))) {
    const { status, output } = run(command)
    expect(status, `${what} was not refused: ${output}`).not.toBe(0)
    expect(output, what).toMatch(/permission denied|not permitted/i)
  }
}

const SCRIPTS: Array<[string, (input: SetupScriptInput) => string]> = [['macOS', buildSetupScript], ['Linux', buildLinuxSetupScript]]

describe('an agent in the Team account, in the owner\'s home', () => {
  it.each(SCRIPTS)('%s: the mode setup gives it keeps group and everyone out, before the daemon starts', (name, build) => {
    const script = build(SETUP)
    // Not a loosening of 700: any group or other bit would let the other account back in.
    expect(ownerHomeMode(script) & 0o077).toBe(0)
    const closes = script.split('\n').findIndex(line => /^(chmod|setfacl)\b.*"\$OWNER_HOME"$/.test(line))
    const starts = script.split('\n').findIndex(line => /launchctl bootstrap system|systemctl enable --now/.test(line))
    expect(closes, name).toBeGreaterThan(-1)
    expect(closes, name).toBeLessThan(starts)
  })

  it('is let in before setup closes it: the attempts below are not refused for some other reason', () => {
    const fixture = ownerHome(tmpdir())
    seenFromOutside(fixture, 0o755)
    const run = asThisUser
    expect(run(`cat '${fixture.home}/.gitconfig'`).output).toContain('name = owner')
    expect(run(`ls -A '${fixture.home}'`).output).toContain('.gitconfig')
    expect(run(`cat '${fixture.home}/code/project.txt'`).status).toBe(0)
    // The refusals that hold with the home open are the files' own, and none of the home's mode.
    expect(run(`cat '${fixture.home}/.ssh/id_ed25519'`).status).not.toBe(0)
    restored(fixture, 0o755)
  })

  it.each(SCRIPTS)('%s: is refused every read and write once setup closed it', (_name, build) => {
    const fixture = ownerHome(tmpdir())
    const mode = ownerHomeMode(build(SETUP))
    const before = snapshot(fixture)
    seenFromOutside(fixture, mode)
    expectRefused(asThisUser, fixture)
    restored(fixture, mode)
    expect(snapshot(fixture)).toEqual(before)
  })

  // As a real other account, where one can be had for free. CI's Linux must have it: a required check is never skipped there.
  it('CI\'s Linux can be another account', () => {
    if (process.env.CI && process.platform === 'linux') expect(sudoNobody).toBe(true)
  })

  describe.runIf(sudoNobody)('as nobody, a real other account', () => {
    /** Under /tmp: Vitest's own temporary folder may not be searchable by another account. */
    const parent = '/tmp'

    it('reads and lists the home before setup closes it', () => {
      const fixture = ownerHome(parent)
      expect(asNobody(`cat '${fixture.home}/.gitconfig'`).output).toContain('name = owner')
      expect(asNobody(`ls -A '${fixture.home}'`).output).toContain('.gitconfig')
      expect(asNobody(`echo planted >> '${fixture.home}/code/project.txt'`).status).toBe(0)
    })

    it.each(SCRIPTS)('%s: is refused every read and write once setup closed it', (_name, build) => {
      const fixture = ownerHome(parent)
      const before = snapshot(fixture)
      chmodSync(fixture.home, ownerHomeMode(build(SETUP)))
      expectRefused(asNobody, fixture)
      expect(snapshot(fixture)).toEqual(before)
    })
  })
})

describe('the privacy check, on the real file system', () => {
  const check = (fixture: Fixture) => runPrivacyCheck(
    { ownerHome: fixture.home, sentinel: join(fixture.home, SENTINEL_NAME) },
    // This process may be an administrator on a developer's Mac; the account it stands in for may not. The rest is real.
    { ...realPrivacyDeps, platform: 'darwin', groups: () => [] },
  )

  it('passes a home closed as setup closes it', () => {
    const fixture = ownerHome(tmpdir())
    const mode = ownerHomeMode(buildSetupScript(SETUP))
    seenFromOutside(fixture, mode)
    expect(check(fixture).passed).toBe(true)
    restored(fixture, mode)
  })

  it.each([
    ['open to everyone (755)', 0o755],
    ['open to the group, as a Mac makes a home (750)', 0o750],
    // No listing, yet anyone who knows a name may open it: what a web server's home is often set to.
    ['searchable only (711)', 0o711],
    ['open to the group alone, to write too (770)', 0o770],
  ])('fails a home %s', (_name, mode) => {
    const fixture = ownerHome(tmpdir())
    seenFromOutside(fixture, mode)
    const result = check(fixture)
    restored(fixture, mode)
    expect(result.passed).toBe(false)
  })

  it('fails closed on a sentinel that is not there: a missing file means the folder above it let the search through', () => {
    const fixture = ownerHome(tmpdir())
    rmSync(join(fixture.home, SENTINEL_NAME))
    fixture.modes.delete(join(fixture.home, SENTINEL_NAME))
    seenFromOutside(fixture, 0o711)
    const result = check(fixture)
    restored(fixture, 0o711)
    expect(result).toMatchObject({ passed: false, item: 'sentinel' })
  })

  it('names the home by ~ or by what it is, never by its path, which carries the owner\'s account name', () => {
    const fixture = ownerHome(tmpdir())
    seenFromOutside(fixture, 0o755)
    const result = check(fixture)
    restored(fixture, 0o755)
    expect(JSON.stringify(result)).not.toContain(fixture.home)
  })
})

/** A hole the audit found (finding H1), pinned as it is today: this turns red the day it is closed, and then says the opposite. */
describe('the owner\'s credential and whoever holds the daemon\'s port', () => {
  const NOTIFY = fileURLToPath(new URL('../../hook/notify.mjs', import.meta.url))
  /** Made up for this test: never a real credential. */
  const CREDENTIAL = 'A'.repeat(43)

  it('H1, still open: an engine hook hands its credential to any listener on the daemon\'s port', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hc-')))
    const data = join(root, 'data')
    mkdirSync(data, { mode: 0o700 })
    writeFileSync(join(data, 'hook-credential'), CREDENTIAL, { mode: 0o600 })
    // Any account may bind a free port above 1023: an agent in the Team account, while the owner's daemon restarts.
    const heard: string[] = []
    const impostor = createServer((req, res) => {
      heard.push(String(req.headers['x-harness-hook-token'] ?? ''))
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    })
    await new Promise<void>(resolve => { impostor.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (impostor.address() as AddressInfo).port
      const hook = spawn(process.execPath, [NOTIFY, '--port', String(port), '--data-dir', data], {
        stdio: ['pipe', 'ignore', 'ignore'],
        // Its own empty tmux folder, so the pane's routing reads no real tmux server.
        env: { PATH: process.env.PATH, HOME: root, TMUX_PANE: '%999', TMUX_TMPDIR: root },
      })
      hook.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: '11111111-1111-4111-8111-111111111111', cwd: root, source: 'startup' }))
      await new Promise<void>(resolve => { hook.on('exit', () => resolve()) })
      expect(heard).toContain(CREDENTIAL)
    } finally {
      await new Promise<void>(resolve => { impostor.close(() => resolve()) })
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
