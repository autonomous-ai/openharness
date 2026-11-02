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
 *   fixture's owner bits set to what the group and other bits say. A Team account on a Mac is in the owner's group (staff), so
 *   both count. At the mode setup gives, that is mode 000, so these runs show only that 000 refuses. What guards the home on
 *   such a machine is the check that no group or other bit is set, on every line of the script that changes it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { startHookServer, type HookServerHandlers } from '../hookServer.js'
import { bridgeKey } from '../lib/connectors/agents.js'
import { createBridge } from '../lib/connectors/bridge.js'
import { portHolderIsThisAccount } from '../lib/peerAccount.js'
import { Store } from '../lib/connectors/store.js'
import { SENTINEL_NAME } from './layout.js'
import { realPrivacyDeps, runPrivacyCheck } from './privacy.js'
import { buildLinuxSetupScript, buildSetupScript, type SetupScriptInput } from './script.js'

const SETUP: SetupScriptInput = {
  user: 'harnessteam', realName: 'Harness Team', home: '/Users/harnessteam', owner: 'owner-placeholder', ownerHome: '/Users/owner-placeholder',
  stageDir: '/private/var/folders/aa/T/harness-team-x1', nodeRuntimeDir: '/Users/owner-placeholder/.harness/runtime/node-v24',
  tmuxRuntimeDir: null, cliDir: '/Users/owner-placeholder/.harness/cli', ownerNode: '/Users/owner-placeholder/.harness/runtime/node-v24/bin/node',
  ownerCli: '/Users/owner-placeholder/.harness/cli/cli.js', mintEnv: {}, signIn: 'missing',
}

/** A line of a script that changes who may enter the owner's home, indented or wrapped in anything, by variable or by its path. */
const changesOwnerHome = (line: string): boolean => !line.trimStart().startsWith('#')
  && /\b(chmod|chown|chgrp|setfacl)\b/.test(line)
  && (line.includes('OWNER_HOME') || new RegExp(`${SETUP.ownerHome}(?![\\w./-])`).test(line))

/**
 * What the script does to the owner's home, as a mode. Every line of it counts, not only step 3's: a later `chmod 755`, or an ACL
 * for the Team account, would reopen the home after that step closed it. It throws on a line it cannot read, or more than the one.
 */
function ownerHomeMode(script: string): number {
  const step = script.split('\n').filter(changesOwnerHome)
  expect(step, 'the one line that closes the owner\'s home, and no other that changes it').toHaveLength(1)
  const line = step[0]!.trim()
  const chmod = /^chmod (\d{3}) "\$OWNER_HOME"$/.exec(line)
  if (chmod) return Number.parseInt(chmod[1]!, 8)
  const acl = /^setfacl -n -m u::([rwx-]{3}),g::([rwx-]{3}),o::([rwx-]{3}) "\$OWNER_HOME"$/.exec(line)
  if (!acl) throw new Error(`this line changes the owner's home in a way this spec cannot read: ${line}`)
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

/** Every path in the home with its contents: what no refused write may change. */
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
    const closes = script.split('\n').findIndex(changesOwnerHome)
    const starts = script.split('\n').findIndex(line => /launchctl bootstrap system|systemctl enable --now/.test(line))
    expect(closes, name).toBeGreaterThan(-1)
    expect(closes, name).toBeLessThan(starts)
  })

  it.each([
    ['a later chmod', 'chmod 755 "$OWNER_HOME"'],
    ['an indented chmod', '  chmod 755 "$OWNER_HOME"'],
    ['an ACL for the Team account', 'chmod +a "$TEAM allow list,search,read" "$OWNER_HOME"'],
    ['a chmod by its path', `/bin/chmod 755 ${SETUP.ownerHome}`],
    ['a change of group', 'chgrp staff "$OWNER_HOME"'],
    ['a recursive ACL as the owner', 'as_owner setfacl -R -m u:harnessteam:rX "$OWNER_HOME"'],
  ])('a script is refused when %s reopens the home after it closed', (_name, line) => {
    const script = `${buildSetupScript(SETUP)}\n${line}\n`
    expect(() => ownerHomeMode(script)).toThrow()
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

/**
 * Audit H1 against a real other account and the real lookup: `nobody`, with a secret it heard. On a Mac with no passwordless
 * sudo, this does not run; there the refusal is tested with a stand-in (hookServer.spec.ts, connectors.spec.ts).
 */
describe.runIf(sudoNobody)('a secret another account heard opens nothing, as nobody', () => {
  /** One request as `nobody`: its status and body, from the real Node client. */
  const askAsNobody = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> => {
    const script = `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(async r => console.log(JSON.stringify({ status: r.status, text: await r.text() })), e => { console.error(e); process.exit(9) })`
    // Not asNobody: its spawnSync would hold this process, which is the server being asked, until the timeout.
    const child = spawn('sudo', ['-n', '-u', 'nobody', process.execPath, '-e', script], { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    const status = await new Promise<number | null>((resolve) => { child.on('close', resolve) })
    expect(status, output).toBe(0)
    return JSON.parse(output.trim().split('\n').at(-1)!) as { status: number; text: string }
  }

  it('the daemon refuses the credential and the hook token from nobody, and takes them from this account', async () => {
    const started = await startHookServer(0, { onRegistered: () => {}, onSessionEnd: () => {}, onStatus: async () => ({ secretDetail: 'x' }) } as unknown as HookServerHandlers)
    try {
      const credential = readFileSync(join(env.ADAPTER_DATA_DIR, 'hook-credential'), 'utf8').trim()
      const hookToken = readFileSync(join(env.ADAPTER_DATA_DIR, 'hook-token'), 'utf8').trim()
      const base = `http://127.0.0.1:${started.port}`
      expect((await askAsNobody(`${base}/api/machines`, { headers: { 'X-Harness-Local': credential } })).status).toBe(401)
      expect((await askAsNobody(`${base}/api/status`, { headers: { 'X-Harness-Local': credential } })).text).not.toContain('secretDetail')
      expect((await askAsNobody(`${base}/api/hook/session-end`, { method: 'POST', headers: { 'x-harness-hook-token': hookToken }, body: '{}' })).status).toBe(401)
      expect(await (await fetch(`${base}/api/status`, { headers: { 'X-Harness-Local': credential } })).text()).toContain('secretDetail')
      expect((await fetch(`${base}/api/hook/session-end`, { method: 'POST', headers: { 'x-harness-hook-token': hookToken }, body: '{}' })).status).not.toBe(401)
    } finally {
      started.server.closeAllConnections()
      await new Promise<void>((resolve) => { started.server.close(() => resolve()) })
      await started.localSocket?.close()
    }
  }, 60_000)

  it('a listener of nobody on a plain listen(port), on `::`, reads as another account\'s', async () => {
    // It exits by itself: this process may not stop another account's.
    const script = `const s = require('node:net').createServer().listen(0, () => console.log(s.address().port)); setTimeout(() => process.exit(0), 8000)`
    const child = spawn('sudo', ['-n', '-u', 'nobody', process.execPath, '-e', script], { cwd: '/', stdio: ['ignore', 'pipe', 'inherit'] })
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
      child.once('close', () => reject(new Error('the listener ended before it named its port')))
    })
    try {
      expect(await portHolderIsThisAccount(port)).toBe(false)
    } finally {
      await new Promise((resolve) => { child.once('close', resolve) })
    }
  }, 30_000)

  it('the bridge answers nobody with the right key as it answers an unknown key', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hb-')))
    const vault = new Store(root, {})
    const key = bridgeKey(vault)
    const bridge = createBridge(vault, { key: () => key })
    await new Promise<void>((resolve) => { bridge.listen(0, '127.0.0.1', resolve) })
    try {
      const base = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`
      const heard = await askAsNobody(`${base}/${key}/linear/mcp`, { method: 'POST', body: '{}' })
      const unknown = await askAsNobody(`${base}/wrong/linear/mcp`, { method: 'POST', body: '{}' })
      expect(heard).toEqual(unknown)
      const mine = await fetch(`${base}/${key}/linear/mcp`, { method: 'POST', body: '{}' })
      expect(await mine.text()).not.toBe(unknown.text)
    } finally {
      bridge.closeAllConnections()
      await new Promise<void>((resolve) => { bridge.close(() => resolve()) })
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

/** A hole the audit found (finding H1), now closed: the real hook, with a made-up credential, against a plain listener on the port. Its other cases are in localCredential.spec.ts. */
describe('the owner\'s credential and whoever holds the daemon\'s port', () => {
  const NOTIFY = fileURLToPath(new URL('../../hook/notify.mjs', import.meta.url))
  /** Made up for this test: never a real credential. */
  const CREDENTIAL = 'A'.repeat(43)

  it('H1: an engine hook hands its credential to no listener on the daemon\'s port', async () => {
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
      // Nothing at all: the hook goes over the daemon's 0600 socket, and with none there the daemon is down.
      expect(heard).toEqual([])
    } finally {
      await new Promise<void>(resolve => { impostor.close(() => resolve()) })
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
