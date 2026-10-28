/**
 * The privileged scripts are tested as text, and their pieces that run as an ordinary account are run here against
 * temporary folders. Nothing in this file creates a user, changes a permission outside a temporary folder, or calls
 * osascript, launchctl, dscl or sudo: the whole scripts are only parsed (`sh -n`), never run.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REMOVE_REFUSED, SENTINEL_TEXT, TEAM_COMPUTER_LINE, TEAM_COPY, TEAM_ENGINES_INSTALL, TEAM_JOB_WRAPPER, TEAM_PASSWORD, WRITE_PRIVATE, WRITE_PUBLIC,
  buildRemoveScript, buildSetupScript, sh, teamLaunchdPlist, type SetupScriptInput,
} from './script.js'

const OWNER_HOME = '/Users/owner-placeholder'
const NODE_DIR = `${OWNER_HOME}/.harness/runtime/node-v22.23.2-darwin-arm64`
const input = (over: Partial<SetupScriptInput> = {}): SetupScriptInput => ({
  user: 'harnessteam', realName: 'Harness Team', home: '/Users/harnessteam', owner: 'owner-placeholder', ownerHome: OWNER_HOME,
  stageDir: '/private/var/folders/aa/T/harness-team-x1', nodeRuntimeDir: NODE_DIR, tmuxRuntimeDir: null,
  cliDir: `${OWNER_HOME}/.harness/cli`, ownerNode: `${NODE_DIR}/bin/node`, ownerCli: `${OWNER_HOME}/.harness/cli/cli.js`,
  mintEnv: {}, signIn: 'missing', ...over,
})

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    try { execFileSync('chmod', ['-R', 'u+rwx', dir]) } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-script-'))
  cleanup.push(dir)
  return dir
}
/** Parses a script without running a line of it. */
function parses(script: string): void {
  const file = join(temp(), 'script.sh')
  writeFileSync(file, script)
  const result = spawnSync('/bin/sh', ['-n', file], { encoding: 'utf8' })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
}
const at = (script: string, needle: string): number => {
  const index = script.indexOf(needle)
  expect(index, needle).toBeGreaterThanOrEqual(0)
  return index
}

describe('sh', () => {
  it('single-quotes every word, a quote inside included', () => {
    expect(sh('a b')).toBe("'a b'")
    expect(sh("it's")).toBe("'it'\\''s'")
    expect(execFileSync('/bin/sh', ['-c', `printf '%s' ${sh("x'; touch /nope; '$(id)`")}`], { encoding: 'utf8' })).toBe("x'; touch /nope; '$(id)`")
  })
})

describe('setup script', () => {
  it('parses, and names every value once, single-quoted', () => {
    const script = buildSetupScript(input({ mintEnv: { BACKEND_WS_URL: 'wss://backend.example.test', HARNESS_AUTH_DIR: '/tmp/auth dir' } }))
    parses(script)
    expect(script).toContain("TEAM='harnessteam'")
    expect(script).toContain("TEAM_NAME='Harness Team'")
    expect(script).toContain(`OWNER_HOME='${OWNER_HOME}'`)
    expect(script).toContain("PLIST='/Library/LaunchDaemons/ai.autonomous.harness.team.plist'")
    expect(script).toContain("CONFIG='/Library/Application Support/Harness/team.json'")
    expect(script).toContain(`SENTINEL='${OWNER_HOME}/.harness-team-privacy'`)
    expect(script).toContain("'BACKEND_WS_URL=wss://backend.example.test' 'HARNESS_AUTH_DIR=/tmp/auth dir' \"$OWNER_NODE\" \"$OWNER_CLI\" team __handoff")
    // The owner's paths appear only in their assignments: every use goes through the quoted variable.
    expect(script.split(OWNER_HOME).length - 1).toBe(6)
  })

  it('makes a listed, standard account with a random password, and never an administrator', () => {
    const script = buildSetupScript(input())
    expect(script).toContain('dscl . -create "/Users/$TEAM" RealName "$TEAM_NAME"')
    // `*` only while a new record is made, before its UniqueID: the random password replaces it at once.
    expect(script.split("dscl . -create \"/Users/$TEAM\" Password '*'")).toHaveLength(2)
    expect(at(script, "  dscl . -create \"/Users/$TEAM\" Password '*'")).toBeLessThan(at(script, '  dscl . -create "/Users/$TEAM" UniqueID "$uid"'))
    expect(at(script, TEAM_PASSWORD)).toBeLessThan(at(script, 'team_uid=$(id -u "$TEAM")'))
    // Never on a command line: no `dscl . -passwd`, no sysadminctl, no password argument.
    expect(script).not.toMatch(/-passwd|sysadminctl|-password/)
    expect(script).toContain('dscl . -create "/Users/$TEAM" PrimaryGroupID 20')
    expect(script).not.toMatch(/IsHidden 1/)
    expect(script).toContain('dscl . -delete "/Users/$TEAM" IsHidden')
    expect(script).toContain('dseditgroup -o edit -d "$TEAM" -t user admin')
    expect(script).not.toMatch(/-a "\$TEAM" -t user admin|GroupMembership "\$TEAM"/)
    // An account by that name that is not ours is refused, not taken over.
    expect(script).toContain('already exists and is not the Harness Team account')
  })

  it('runs its steps in order: account, homes, stop, runtime, config, sign-in, daemon', () => {
    const script = buildSetupScript(input())
    const order = [
      'owned_by_root "$dir"', 'dscl . -create "/Users/$TEAM"', 'chmod 700 "$TEAM_HOME"', 'chmod 700 "$OWNER_HOME"',
      'as_owner /bin/sh -c', 'launchctl bootout "system/$LABEL"', 'mktemp -d /private/var/tmp/harness-team.XXXXXX', 'as_team /bin/sh -c',
      'npm" install --global --prefix "$home/.local"', 'install -o 0 -g 0 -m 0644 "$STAGE/team.json" "$CONFIG"', 'team __handoff', 'as_team /bin/sh -c \'umask 077',
      'install -o 0 -g 0 -m 0644 "$STAGE/team.plist" "$PLIST"', 'launchctl bootstrap system "$PLIST"',
    ].map((needle) => at(script, needle))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('never writes inside the team home as root: the team account copies and writes its own files', () => {
    const script = buildSetupScript(input())
    for (const line of script.split('\n')) {
      if (/^\s*(cp|mv|ln|printf|cat|install)\b/.test(line) && !line.includes('| as_team') && !line.includes('| as_owner')) {
        expect(line, line).not.toMatch(/TEAM_HOME|HANDOFF|TEAM_SESSION/)
      }
    }
    expect(script).toContain('printf \'%s\\n\' "$code" | as_team /bin/sh -c')
    expect(script).toContain(`| as_owner /bin/sh -c ${sh(WRITE_PUBLIC)} sh "$SENTINEL"`)
  })

  it('hands over a sign-in only when the team account has none, unless asked again', () => {
    expect(buildSetupScript(input())).toContain("SIGN_IN='missing'")
    expect(buildSetupScript(input({ signIn: 'always' }))).toContain("SIGN_IN='always'")
    expect(buildSetupScript(input())).toContain('if [ "$SIGN_IN" = always ] || [ ! -s "$TEAM_SESSION" ]; then')
  })

  it('starts the daemon it stopped again when no sign-in code can be had, then says why', () => {
    // In the VM rig (24 Oct 2026) a repair run whose mint was refused died at step 7, after step 4 had stopped the daemon:
    // the team machine stayed down until the Mac restarted.
    const script = buildSetupScript(input())
    expect(script).not.toMatch(/team __handoff\)[^\n]*\|\| die/)
    expect(script).not.toMatch(/die "the sign-in code was not in the form/)
    const bootstrap = at(script, 'launchctl bootstrap system "$PLIST"')
    expect(at(script, 'no_sign_in="could not get a sign-in code from your Harness sign-in"')).toBeLessThan(bootstrap)
    expect(at(script, 'no_sign_in="the sign-in code was not in the form Harness expects"')).toBeLessThan(bootstrap)
    expect(at(script, '[ -z "$no_sign_in" ] || die "$no_sign_in; the team daemon runs without a new sign-in" 7')).toBeGreaterThan(bootstrap)
    // Nothing is handed over without a code.
    expect(at(script, 'if [ -z "$no_sign_in" ]; then')).toBeLessThan(at(script, 'printf \'%s\\n\' "$code" | as_team'))
    parses(script)
  })

  it('marks the shared folder as its own only when it made it', () => {
    const script = buildSetupScript(input())
    expect(script).toContain('if [ ! -d "$SHARED" ]; then mkdir "$SHARED"; chown 0:0 "$SHARED"; chmod 755 "$SHARED"; made_shared=1; fi')
    expect(at(script, 'owned_by_root "$SHARED"')).toBeLessThan(at(script, '[ -z "$made_shared" ] || : > "$SHARED_MARK"'))
    expect(script).toContain("SHARED_MARK='/Library/Application Support/Harness/.made-by-harness-team-setup'")
  })

  it('copies a managed tmux only when there is one', () => {
    expect(buildSetupScript(input())).toContain("TMUX_NAME=''")
    const script = buildSetupScript(input({ tmuxRuntimeDir: `${OWNER_HOME}/.harness/runtime/tmux-3.5a-darwin-arm64` }))
    expect(script).toContain("TMUX_NAME='tmux-3.5a-darwin-arm64'")
    parses(script)
  })

  it('refuses a value that is not plain, before anything is written', () => {
    const bad: Array<Partial<SetupScriptInput>> = [
      { user: "harness'team" }, { user: 'root' }, { user: 'Harness Team' }, { owner: 'owner;id' }, { owner: 'harnessteam' },
      { ownerHome: "/Users/a'b" }, { ownerHome: '/Users/a$(id)' }, { ownerHome: '/Users/../etc' }, { ownerHome: 'Users/rel' },
      { ownerHome: '/Users/a\nb' }, { ownerHome: '/Users/harnessteam' }, { home: `${OWNER_HOME}/team` },
      { stageDir: '/tmp/`id`' }, { nodeRuntimeDir: '/x/node"v' }, { realName: 'Harness "Team"' },
      { mintEnv: { 'BAD-NAME': 'x' } }, { mintEnv: { BACKEND_WS_URL: 'wss://x\n' } },
    ]
    for (const over of bad) expect(() => buildSetupScript(input(over)), JSON.stringify(over)).toThrow()
  })
})

describe('the team account\'s own engines', () => {
  it('are installed by the team account itself, never by root, from the vendors\' packages, and never fail setup', () => {
    const script = buildSetupScript(input())
    expect(script).toContain(`\nas_team /bin/sh -c ${sh(TEAM_ENGINES_INSTALL)} sh "$TEAM_HOME" "$NODE_NAME" '@anthropic-ai/claude-code' '@openai/codex' || true\n`)
    parses(script)
  })

  it('installs each package with the team account\'s own Node and npm under its own home, and goes on past one that fails', () => {
    const root = temp()
    const home = join(root, 'home'), bin = join(home, '.harness', 'runtime', 'node-v1', 'bin')
    mkdirSync(bin, { recursive: true })
    const log = join(root, 'npm.log')
    // A stand-in npm: it records how it was run and with which PATH, and refuses one package.
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$PATH" "$PWD" "$*" >> '${log}'\ncase "$*" in *@openai/codex*) exit 1 ;; esac\n`, { mode: 0o755 })
    const run = spawnSync('/bin/sh', ['-c', TEAM_ENGINES_INSTALL, 'sh', home, 'node-v1', '@anthropic-ai/claude-code', '@openai/codex'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('harness: installed @anthropic-ai/claude-code for the team account')
    expect(run.stderr).toContain('harness: could not install @openai/codex for the team account; harness team setup tries again')
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('|'))
    expect(calls).toHaveLength(2)
    for (const [path, cwd, args] of calls) {
      expect(path!.split(':')[0]).toBe(bin)
      expect(cwd).toBe(home)
      expect(args).toContain(`install --global --prefix ${home}/.local --no-fund --no-audit --loglevel=error`)
    }
    // No npm in the copied Node: said, and setup goes on.
    const bare = spawnSync('/bin/sh', ['-c', TEAM_ENGINES_INSTALL, 'sh', join(root, 'nobody'), 'node-v1', '@openai/codex'], { encoding: 'utf8' })
    expect(bare.status).toBe(0)
    expect(bare.stderr).toContain('has no npm')
  })
})

describe('the team account\'s copy of the runtime', () => {
  it('lays the runtime, the CLI and the harness launcher into the home it is given, privately', () => {
    const root = temp()
    const stage = join(root, 'stage'), home = join(root, 'home')
    mkdirSync(join(stage, 'node', 'bin'), { recursive: true })
    mkdirSync(join(stage, 'cli'), { recursive: true })
    mkdirSync(home)
    writeFileSync(join(stage, 'node', 'bin', 'node'), '#!/bin/sh\necho node "$@"\n', { mode: 0o755 })
    writeFileSync(join(stage, 'node', 'bin', 'npm'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(stage, 'cli', 'cli.js'), '// cli')
    writeFileSync(join(stage, 'cli', 'package.json'), '{"type":"module"}')
    // A second run replaces what the first laid down.
    for (let run = 0; run < 2; run++) execFileSync('/bin/sh', ['-c', TEAM_COPY, 'sh', stage, home, 'node-v1', ''])
    const runtime = join(home, '.harness', 'runtime')
    expect(readFileSync(join(runtime, 'current-node'), 'utf8')).toBe(`${runtime}/node-v1/bin/node\n`)
    expect(existsSync(join(runtime, 'node-v1.next'))).toBe(false)
    // On the account's PATH, so Codex's `#!/usr/bin/env node` launcher starts in its terminals.
    expect(readlinkSync(join(home, '.local', 'bin', 'node'))).toBe(`${runtime}/node-v1/bin/node`)
    // And npm, for a Builder's packages and tests; npx is linked only where the Node has it.
    expect(readlinkSync(join(home, '.local', 'bin', 'npm'))).toBe(`${runtime}/node-v1/bin/npm`)
    expect(existsSync(join(home, '.local', 'bin', 'npx'))).toBe(false)
    expect(readFileSync(join(home, '.harness', 'cli', 'cli.js'), 'utf8')).toBe('// cli')
    expect(existsSync(join(home, '.harness', 'cli', 'notify.mjs'))).toBe(false)
    expect(statSync(join(home, '.harness')).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, '.harness', 'auth')).mode & 0o777).toBe(0o700)
    const launcher = join(home, '.local', 'bin', 'harness')
    expect(readFileSync(launcher, 'utf8')).toBe(`#!/bin/sh\nexec "${runtime}/node-v1/bin/node" "${home}/.harness/cli/cli.js" "$@"\n`)
    expect(execFileSync(launcher, ['status'], { encoding: 'utf8' })).toBe(`node ${home}/.harness/cli/cli.js status\n`)
  })

  it('links a managed tmux when one is staged', () => {
    const root = temp()
    const stage = join(root, 'stage'), home = join(root, 'home')
    mkdirSync(join(stage, 'node', 'bin'), { recursive: true })
    mkdirSync(join(stage, 'tmux', 'bin'), { recursive: true })
    mkdirSync(join(stage, 'cli'), { recursive: true })
    mkdirSync(home)
    writeFileSync(join(stage, 'tmux', 'bin', 'tmux'), '#!/bin/sh\n', { mode: 0o755 })
    execFileSync('/bin/sh', ['-c', TEAM_COPY, 'sh', stage, home, 'node-v1', 'tmux-3'])
    const runtime = join(home, '.harness', 'runtime')
    expect(readFileSync(join(runtime, 'current-tmux'), 'utf8')).toBe(`${runtime}/tmux-3/bin/tmux\n`)
    expect(readlinkSync(join(home, '.local', 'bin', 'tmux'))).toBe(`${runtime}/tmux-3/bin/tmux`)
  })

  it('writes the sign-in file readable by its owner alone, and the sentinel readable by everyone', () => {
    const dir = temp()
    execFileSync('/bin/sh', ['-c', WRITE_PRIVATE, 'sh', join(dir, 'handoff')], { input: 'code\n' })
    expect(readFileSync(join(dir, 'handoff'), 'utf8')).toBe('code\n')
    expect(statSync(join(dir, 'handoff')).mode & 0o777).toBe(0o600)
    execFileSync('/bin/sh', ['-c', WRITE_PUBLIC, 'sh', join(dir, 'sentinel')], { input: `${SENTINEL_TEXT}\n` })
    expect(statSync(join(dir, 'sentinel')).mode & 0o777).toBe(0o644)
    expect(existsSync(join(dir, 'sentinel.next'))).toBe(false)
  })
})

describe('the team account\'s password', () => {
  /** TEAM_PASSWORD with a stand-in dscl on PATH that records every call (its arguments, and what it read) and keeps the
   *  account's state in a folder. Nothing touches a real account. */
  function run(state: { password?: boolean; refuses?: boolean } = {}) {
    const root = temp()
    const bin = join(root, 'bin'), log = join(root, 'calls')
    mkdirSync(bin)
    if (state.password) writeFileSync(join(root, 'has-password'), '')
    writeFileSync(join(bin, 'dscl'), [
      '#!/bin/sh',
      `printf 'argv:%s\\n' "$*" >> '${log}'`,
      'if [ "$#" = 1 ]; then',
      `  input=$(cat); printf 'stdin:%s\\n' "$input" >> '${log}'`,
      `  ${state.refuses ? 'exit 0' : `case $input in "passwd /Users/harnessteam "*) : > '${root}/has-password' ;; esac`}`,
      '  exit 0',
      'fi',
      `[ -e '${root}/has-password' ] && echo 'AuthenticationAuthority: ;ShadowHash;HASHLIST:<SALTED-SHA512-PBKDF2>'`,
      'exit 0',
    ].join('\n'), { mode: 0o755 })
    const result = spawnSync('/bin/sh', ['-c', `set -eu\ndie() { printf 'harness: %s\\n' "$1" >&2; exit "$2"; }\nTEAM=harnessteam\n${TEAM_PASSWORD}\necho done`],
      { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { result, calls }
  }

  it('is random, 40 letters and digits, and reaches dscl only on its input, never as an argument', () => {
    const { result, calls } = run()
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('done\n')
    const stdin = calls.filter((c) => c.startsWith('stdin:'))
    expect(stdin).toHaveLength(1)
    const password = /^stdin:passwd \/Users\/harnessteam ([A-Za-z0-9]{40})$/.exec(stdin[0]!)?.[1]
    expect(password).toBeDefined()
    // What `ps` would show: the arguments of every call. The password is in none of them.
    for (const call of calls.filter((c) => c.startsWith('argv:'))) expect(call).not.toContain(password)
    expect(calls).toContain('argv:.')
    expect(run().calls.find((c) => c.startsWith('stdin:'))).not.toBe(stdin[0])
  })

  it('is left as it is on a repair run', () => {
    const { result, calls } = run({ password: true })
    expect(result.stdout).toBe('done\n')
    expect(calls).toEqual(['argv:. -read /Users/harnessteam AuthenticationAuthority'])
  })

  it('stops setup, saying why, when macOS does not take it', () => {
    const { result } = run({ refuses: true })
    expect(result.status).toBe(4)
    expect(result.stderr).toBe('harness: macOS did not take a password for the account harnessteam, so Users & Groups would not list it\n')
  })
})

describe('the team daemon\'s job', () => {
  const plistInput = { user: 'harnessteam', home: '/Users/harnessteam', node: '/Users/harnessteam/.harness/runtime/node-v1/bin/node',
    cli: '/Users/harnessteam/.harness/cli/cli.js', port: 18493, env: { BACKEND_WS_URL: 'wss://backend.example.test/a&b' } }

  it('runs the team daemon as the team account, on its own port and data folder, and never as a platform agent', () => {
    const plist = teamLaunchdPlist(plistInput)
    expect(plist).toContain('<key>Label</key>\n\t<string>ai.autonomous.harness.team</string>')
    expect(plist).toContain('<key>UserName</key>\n\t<string>harnessteam</string>')
    expect(plist).toContain('<key>PORT</key>\n\t\t<string>18493</string>')
    expect(plist).toContain('<key>ADAPTER_DATA_DIR</key>\n\t\t<string>/Users/harnessteam/.harness/cli/data</string>')
    expect(plist).toContain('<key>HOME</key>\n\t\t<string>/Users/harnessteam</string>')
    expect(plist).toContain('<string>wss://backend.example.test/a&amp;b</string>')
    expect(plist).toContain('<string>/Users/harnessteam/.harness/team-handoff</string>')
    // The log is opened by the job as the team account, never by launchd, which may open it as root.
    expect(plist).not.toContain('StandardOutPath')
    expect(plist).not.toContain('StandardErrorPath')
    expect(plist).not.toContain('HARNESSD_PLATFORM')
    expect(plist).toContain('<string>Standard</string>')
    if (existsSync('/usr/bin/plutil')) {
      const file = join(temp(), 'team.plist')
      writeFileSync(file, plist)
      expect(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK')
    }
  })

  it('refuses a port the owner\'s or a dev daemon uses, and a value it cannot carry', () => {
    expect(() => teamLaunchdPlist({ ...plistInput, port: 18473 })).toThrow()
    expect(() => teamLaunchdPlist({ ...plistInput, port: 18474 })).toThrow()
    expect(() => teamLaunchdPlist({ ...plistInput, env: { 'A B': 'x' } })).toThrow()
    expect(() => teamLaunchdPlist({ ...plistInput, node: 'relative/node' })).toThrow()
  })

  it('redeems and checks before the daemon, then becomes the daemon, logging both as the team account', () => {
    const dir = temp()
    const node = join(dir, 'node')
    writeFileSync(node, '#!/bin/sh\necho "ran: $*"\n', { mode: 0o755 })
    const log = join(dir, 'harness.log')
    execFileSync('/bin/sh', ['-c', TEAM_JOB_WRAPPER, 'harness-team', node, '/x/cli.js', '/x/team-handoff', log])
    expect(readFileSync(log, 'utf8')).toBe('ran: /x/cli.js team __start /x/team-handoff\nran: /x/cli.js __harnessd\n')
  })

  it('starts the daemon even when the start step fails', () => {
    const dir = temp()
    const node = join(dir, 'node')
    writeFileSync(node, '#!/bin/sh\n[ "$2" = team ] && exit 3\necho "daemon"\n', { mode: 0o755 })
    const log = join(dir, 'harness.log')
    execFileSync('/bin/sh', ['-c', TEAM_JOB_WRAPPER, 'harness-team', node, '/x/cli.js', '/x/h', log])
    expect(readFileSync(log, 'utf8')).toBe('daemon\n')
  })
})

describe('remove script', () => {
  const removeInput = { user: 'harnessteam', home: '/Users/harnessteam', ownerHome: OWNER_HOME }

  it('parses, and deletes the account before anything it cannot undo', () => {
    const script = buildRemoveScript(removeInput)
    parses(script)
    // Where every daemon keeps its computer id (config/env.ts): the product root, not the data folder.
    expect(script).toContain("COMPUTER_ID='/Users/harnessteam/.harness/computer-id'")
    const order = [
      'launchctl bootout "system/$LABEL"', 'dscl . -delete "/Users/$TEAM"', 'pkill -KILL -u "$team_uid"', 'rm -f "$PLIST"',
      'rm -rf "$TEAM_HOME" "$STATUS_DIR"', 'rm -f "$CONFIG" "$SENTINEL"', 'rmdir "$SHARED"',
    ].map((needle) => at(script, needle))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The team account is no longer signed out from here: that cannot be undone, and the deletion may yet be refused.
    expect(script).not.toContain('__signout')
    // The owner's home folder stays private: nothing here changes its mode.
    expect(script).not.toMatch(/chmod/)
  })

  it('leaves an account or a home that is not the Harness Team account\'s alone', () => {
    const script = buildRemoveScript(removeInput)
    expect(script).toContain('is not the Harness Team account (its home is $existing); nothing was removed')
    expect(script).toContain('belongs to $holder; nothing was removed')
    expect(() => buildRemoveScript({ ...removeInput, user: 'root' })).toThrow()
    expect(() => buildRemoveScript({ ...removeInput, home: '/Users/a b/../c' })).toThrow()
  })

  /**
   * The whole removal script, run for real against a temporary folder: every path it names is moved into it, and every
   * system command it calls (dscl, launchctl, pkill, id, stat, sudo, sleep) is a stand-in shell function, defined before
   * the script's first line runs, that records the call and keeps the account's state in files. Nothing touches a real
   * account, job or folder outside the temporary one.
   */
  function sandbox(over: { account?: boolean; refuse?: boolean; bootstrapFails?: boolean; mark?: boolean; otherShared?: boolean; keptHome?: boolean
    otherOwner?: boolean } = {}) {
    const root = temp()
    const state = join(root, 'state'), log = join(root, 'calls')
    mkdirSync(state)
    const p = {
      TEAM_HOME: join(root, 'Users', 'harnessteam'), PLIST: join(root, 'LaunchDaemons', 'ai.autonomous.harness.team.plist'),
      SHARED: join(root, 'Application Support', 'Harness'), SENTINEL: join(root, 'Users', 'owner', '.harness-team-privacy'),
    }
    const paths = { ...p, CONFIG: join(p.SHARED, 'team.json'), STATUS_DIR: join(p.SHARED, 'Team'),
      SHARED_MARK: join(p.SHARED, '.made-by-harness-team-setup'), COMPUTER_ID: join(p.TEAM_HOME, '.harness', 'computer-id'),
      DELETED_HOME: `${p.TEAM_HOME} (Deleted)` }
    // Users & Groups, told to keep the home folder of an account it deletes, renames it.
    mkdirSync(over.keptHome ? join(paths.DELETED_HOME, '.harness') : join(p.TEAM_HOME, '.harness', 'cli', 'data'), { recursive: true })
    if (over.keptHome) mkdirSync(join(p.TEAM_HOME, '.harness', 'cli', 'data'), { recursive: true })
    mkdirSync(join(root, 'LaunchDaemons'))
    mkdirSync(paths.STATUS_DIR, { recursive: true })
    mkdirSync(join(root, 'Users', 'owner'))
    writeFileSync(over.keptHome ? join(paths.DELETED_HOME, '.harness', 'computer-id') : paths.COMPUTER_ID, 'team-computer-1\n')
    writeFileSync(p.PLIST, '<plist/>')
    writeFileSync(paths.CONFIG, '{}')
    writeFileSync(join(paths.STATUS_DIR, 'status.json'), '{}')
    writeFileSync(p.SENTINEL, 'x')
    if (over.mark !== false) writeFileSync(paths.SHARED_MARK, '')
    if (over.otherShared) writeFileSync(join(p.SHARED, 'other.json'), '{}')
    if (over.account !== false) writeFileSync(join(state, 'account'), '')
    writeFileSync(join(state, 'loaded'), '')
    const stub = (name: string, body: string) => `${name}() { printf '%s %s\\n' ${name} "$*" >> ${sh(log)}; ${body}\n}`
    const prelude = [
      // The home's owner by number, and that number's name: the team account's, nobody's once it is deleted, or someone else's.
      stub('id', [
        'case "$*" in',
        "  '-u') echo 0 ;;",
        "  '-u harnessteam') echo 600 ;;",
        `  '-un 600') if [ -e ${sh(`${state}/account`)} ]; then echo harnessteam; else return 1; fi ;;`,
        "  '-un 701') echo someone ;;",
        '  *) return 1 ;;',
        'esac',
      ].join('\n')),
      stub('stat', `[ "$1 $2" = '-f %u' ] && echo ${over.otherOwner ? 701 : 600}`),
      stub('head', 'command head "$@"'),
      stub('dscl', [
        'case "$*" in',
        `  *-read*UniqueID*) [ -e ${sh(`${state}/account`)} ] && echo 'UniqueID: 600' ;;`,
        `  *-read*NFSHomeDirectory*) [ -e ${sh(`${state}/account`)} ] && echo ${sh(`NFSHomeDirectory: ${p.TEAM_HOME}`)} ;;`,
        `  *-delete*) ${over.refuse
          ? "echo '<main> delete status: eDSPermissionError' >&2; echo '<dscl_cmd> DS Error: -14120 (eDSPermissionError)' >&2; return 40"
          : `rm ${sh(`${state}/account`)}`} ;;`,
        'esac',
      ].join('\n')),
      stub('launchctl', [
        'case "$1" in',
        `  bootout) rm -f ${sh(`${state}/loaded`)} ;;`,
        `  bootstrap) ${over.bootstrapFails ? 'return 5' : `: > ${sh(`${state}/loaded`)}`} ;;`,
        `  print) [ -e ${sh(`${state}/loaded`)} ] ;;`,
        'esac',
      ].join('\n')),
      stub('sudo', 'while [ "$#" -gt 0 ]; do case "$1" in -n) shift ;; -u) shift 2 ;; *) break ;; esac; done; "$@"'),
      stub('pkill', ':'),
      stub('sleep', ':'),
    ].join('\n')
    let script = buildRemoveScript(removeInput)
    for (const [name, value] of Object.entries(paths)) {
      expect(script, name).toMatch(new RegExp(`^${name}=`, 'm'))
      script = script.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${sh(value)}`)
    }
    // The stand-ins are found by name: the script's absolute /usr/bin/sudo and /bin/cat would pass them by.
    script = script.replaceAll('/usr/bin/sudo', 'sudo').replaceAll('/bin/cat', 'cat').replace('\ncd /\n', `\ncd /\n${prelude}\n`)
    // Nothing left that names a real place: every path is in the temporary folder.
    expect(script).not.toMatch(/'\/(Users|Library)\//)
    const file = join(root, 'remove.sh')
    writeFileSync(file, script)
    const result = spawnSync('/bin/sh', [file], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { result, calls, paths, state, gone: (path: string) => !existsSync(path) }
  }

  it('removes the account, its daemon and everything setup made, and names its computer for the owner to take off', () => {
    const s = sandbox()
    expect(s.result.stderr).toBe('')
    expect(s.result.status).toBe(0)
    expect(TEAM_COMPUTER_LINE.exec(s.result.stdout)?.[1]).toBe('team-computer-1')
    expect(s.result.stdout).toContain('harness: removed the Harness Team account, its home folder and its daemon')
    for (const path of [s.paths.TEAM_HOME, s.paths.PLIST, s.paths.CONFIG, s.paths.STATUS_DIR, s.paths.SENTINEL, s.paths.SHARED]) expect(s.gone(path), path).toBe(true)
    const deleted = s.calls.indexOf('dscl . -delete /Users/harnessteam')
    expect(deleted).toBeGreaterThan(s.calls.indexOf('launchctl bootout system/ai.autonomous.harness.team'))
    expect(s.calls.indexOf('pkill -KILL -u 600')).toBeGreaterThan(deleted)
    expect(s.calls.some((c) => c.startsWith('launchctl bootstrap'))).toBe(false)
    // Its computer id was read as the team account, not by root.
    expect(s.calls).toContain(`sudo -n -u harnessteam cat ${s.paths.COMPUTER_ID}`)
  })

  it('when macOS refuses the deletion, changes nothing and starts the team daemon again', () => {
    const s = sandbox({ refuse: true })
    expect(s.result.status).toBe(REMOVE_REFUSED)
    expect(s.result.stderr).toBe('harness: could not delete the account harnessteam: macOS did not allow it (eDSPermissionError). '
      + 'Nothing was removed: the Harness Team account and its daemon run as before\n')
    for (const path of [s.paths.TEAM_HOME, s.paths.PLIST, s.paths.CONFIG, s.paths.STATUS_DIR, s.paths.SENTINEL, s.paths.SHARED_MARK, s.paths.COMPUTER_ID]) {
      expect(s.gone(path), path).toBe(false)
    }
    expect(s.calls).toContain(`launchctl bootstrap system ${s.paths.PLIST}`)
    expect(existsSync(join(s.state, 'loaded'))).toBe(true)
    expect(existsSync(join(s.state, 'account'))).toBe(true)
    expect(s.calls.some((c) => c.startsWith('pkill'))).toBe(false)
    expect(s.result.stdout).not.toMatch(TEAM_COMPUTER_LINE)
  })

  it('says so when the team daemon does not start again after a refusal', () => {
    const s = sandbox({ refuse: true, bootstrapFails: true })
    expect(s.result.status).toBe(REMOVE_REFUSED)
    expect(s.result.stderr).toContain('Nothing was removed, but the team daemon did not start again: harness team setup starts it')
    expect(s.gone(s.paths.PLIST)).toBe(false)
  })

  it('finishes after the account was deleted elsewhere (Users & Groups), stopping what still runs under its old id', () => {
    const s = sandbox({ account: false })
    expect(s.result.status).toBe(0)
    expect(s.calls.some((c) => c.startsWith('dscl . -delete'))).toBe(false)
    expect(s.calls).toContain('pkill -KILL -u 600')
    for (const path of [s.paths.TEAM_HOME, s.paths.PLIST, s.paths.CONFIG, s.paths.SHARED]) expect(s.gone(path), path).toBe(true)
    // Its computer id, from the home it left, owned by its old id.
    expect(TEAM_COMPUTER_LINE.exec(s.result.stdout)?.[1]).toBe('team-computer-1')
  })

  it('never reads a computer id through a link, or from a file its old id does not own', () => {
    const script = buildRemoveScript(removeInput)
    expect(script).toContain('[ ! -L "$left" ] && [ ! -L "$left/.harness" ] && [ ! -L "$f" ] && [ -f "$f" ] || continue')
    expect(script).toContain('[ "$(stat -f %u "$f")" = "$team_uid" ] || continue')
  })

  it('also removes the home folder Users & Groups kept, renamed, when the account was deleted there, and names its computer', () => {
    const s = sandbox({ account: false, keptHome: true })
    expect(s.result.status).toBe(0)
    expect(s.gone(s.paths.DELETED_HOME)).toBe(true)
    expect(s.gone(s.paths.TEAM_HOME)).toBe(true)
    expect(s.calls).toContain('pkill -KILL -u 600')
    // Read from the home it left, after its processes were stopped.
    expect(TEAM_COMPUTER_LINE.exec(s.result.stdout)?.[1]).toBe('team-computer-1')
    expect(s.calls.indexOf(`head -n 1 ${s.paths.DELETED_HOME}/.harness/computer-id`)).toBeGreaterThan(s.calls.indexOf('pkill -KILL -u 600'))
    expect(buildRemoveScript(removeInput)).toContain("DELETED_HOME='/Users/harnessteam (Deleted)'")
  })

  it('leaves a home folder that belongs to another account, and everything else, alone', () => {
    const s = sandbox({ account: false, otherOwner: true })
    expect(s.result.status).toBe(4)
    expect(s.result.stderr).toBe(`harness: ${s.paths.TEAM_HOME} belongs to someone; nothing was removed\n`)
    for (const path of [s.paths.TEAM_HOME, s.paths.PLIST, s.paths.CONFIG]) expect(s.gone(path), path).toBe(false)
    expect(s.calls.some((c) => c.startsWith('launchctl') || c.startsWith('pkill'))).toBe(false)
  })

  it('removes the shared folder only when setup made it and nothing else is in it', () => {
    const notMade = sandbox({ mark: false })
    expect(notMade.result.status).toBe(0)
    expect(notMade.gone(notMade.paths.SHARED)).toBe(false)
    const shared = sandbox({ otherShared: true })
    expect(shared.result.status).toBe(0)
    expect(shared.gone(shared.paths.SHARED)).toBe(false)
    expect(shared.gone(shared.paths.SHARED_MARK)).toBe(false)
    expect(shared.gone(shared.paths.CONFIG)).toBe(true)
  })
})

describe('real permission bits on a temporary folder', () => {
  it('the staged runtime folder is readable by others but changeable by its owner alone', () => {
    // What `chmod -R a+rX,go-w` gives the staging folder the team account reads from.
    const dir = temp()
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'node'), '', { mode: 0o700 })
    writeFileSync(join(dir, 'cli.js'), '', { mode: 0o600 })
    chmodSync(dir, 0o700)
    execFileSync('chmod', ['-R', 'a+rX,go-w', dir])
    // An executable stays one for the team account; a plain file only becomes readable.
    expect(statSync(join(dir, 'bin', 'node')).mode & 0o777).toBe(0o755)
    expect(statSync(join(dir, 'cli.js')).mode & 0o777).toBe(0o644)
    expect(statSync(join(dir, 'bin')).mode & 0o777).toBe(0o755)
  })
})

describe('what setup carries from the owner\'s environment', () => {
  it('carries the backend it signs in to, and never switches the team account\'s updates off', async () => {
    const { carriedBackendEnv } = await import('./layout.js')
    expect(carriedBackendEnv({ AUTONOMOUS_ENV: 'stag', ADAPTER_UPDATE_DISABLE: 'true' })).toEqual({ AUTONOMOUS_ENV: 'stag' })
    expect(carriedBackendEnv({ ADAPTER_UPDATE_DISABLE: '1' })).toEqual({})
  })
})
