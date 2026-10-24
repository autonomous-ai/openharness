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
  SENTINEL_TEXT, TEAM_COPY, TEAM_ENGINES_INSTALL, TEAM_JOB_WRAPPER, WRITE_PRIVATE, WRITE_PUBLIC, buildRemoveScript, buildSetupScript, sh, teamLaunchdPlist,
  type SetupScriptInput,
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

  it('makes a visible, standard account with an unusable password, and never an administrator', () => {
    const script = buildSetupScript(input())
    expect(script).toContain('dscl . -create "/Users/$TEAM" RealName "$TEAM_NAME"')
    expect(script).toContain("dscl . -create \"/Users/$TEAM\" Password '*'")
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
    writeFileSync(join(stage, 'cli', 'cli.js'), '// cli')
    writeFileSync(join(stage, 'cli', 'package.json'), '{"type":"module"}')
    // A second run replaces what the first laid down.
    for (let run = 0; run < 2; run++) execFileSync('/bin/sh', ['-c', TEAM_COPY, 'sh', stage, home, 'node-v1', ''])
    const runtime = join(home, '.harness', 'runtime')
    expect(readFileSync(join(runtime, 'current-node'), 'utf8')).toBe(`${runtime}/node-v1/bin/node\n`)
    expect(existsSync(join(runtime, 'node-v1.next'))).toBe(false)
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
  const removeInput = { user: 'harnessteam', home: '/Users/harnessteam', ownerHome: OWNER_HOME,
    teamNode: '/Users/harnessteam/.harness/runtime/node-v1/bin/node', teamCli: '/Users/harnessteam/.harness/cli/cli.js',
    env: { AUTONOMOUS_ENV: 'stag' } }

  it('parses, signs the account out as itself first, then removes the job, the account and its files', () => {
    const script = buildRemoveScript(removeInput)
    parses(script)
    const order = [
      'team __signout', 'launchctl bootout "system/$LABEL"', 'rm -f "$PLIST"', 'pkill -KILL -u "$TEAM"', 'dscl . -delete "/Users/$TEAM"',
      'rm -rf "$TEAM_HOME" "$STATUS_DIR"', 'rm -f "$CONFIG" "$SENTINEL"',
    ].map((needle) => at(script, needle))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(script).toContain('/usr/bin/sudo -n -H -u "$TEAM" /usr/bin/env \'AUTONOMOUS_ENV=stag\' "$TEAM_NODE" "$TEAM_CLI" team __signout')
    // The owner's home folder stays private: nothing here changes its mode.
    expect(script).not.toMatch(/chmod/)
  })

  it('leaves an account or a home that is not the Harness Team account\'s alone', () => {
    const script = buildRemoveScript(removeInput)
    expect(script).toContain('is not the Harness Team account (its home is $existing); nothing was removed')
    expect(script).toContain('belongs to $holder; nothing was removed')
  })

  it('skips the sign-out when the config does not name the team account\'s CLI', () => {
    const script = buildRemoveScript({ ...removeInput, teamNode: null, teamCli: null, env: {} })
    expect(script).toContain("TEAM_NODE=''")
    parses(script)
    expect(() => buildRemoveScript({ ...removeInput, user: 'root' })).toThrow()
    expect(() => buildRemoveScript({ ...removeInput, home: '/Users/a b/../c' })).toThrow()
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
