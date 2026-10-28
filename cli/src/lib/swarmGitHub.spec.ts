import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GIT_HOOK_NAMES, gitConfigParameters, shellWord, swarmGitHubLaunch, swarmGitHubSessionDir, swarmGitPrepareEnv, writeSessionGitHub, writeSwarmGitHubTools } from './swarmGitHub.js'

// Real git against folders made here, with a home of its own and no system config: never this machine's git settings,
// and nothing reaches github.com (only `git credential fill` and `git ls-remote --get-url`, which make no connection).
const root = mkdtempSync(join(tmpdir(), 'swarm-github-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0
const fresh = (name: string) => { const dir = join(root, `${name}-${made++}`); mkdirSync(dir, { recursive: true }); return dir }
const home = fresh('home')
const script = (file: string, body: string) => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** GitHub's stateless installation token: ghs_, the app id, and a JWT, about 520 characters with dots and dashes. */
const STATELESS = `ghs_123456_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTYifQ.${'s'.repeat(470)}-x_y`
const git = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) => spawnSync('git', args, {
  cwd, input, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', ...env },
})

describe('git configuration for a Swarm session', () => {
  it('quotes values for git as `git -c` does, single quotes included', () => {
    expect(shellWord("it's")).toBe(`'it'\\''s'`)
    const parameters = gitConfigParameters("/data/it's/git-credential", '/data/hooks')
    expect(parameters).toContain(`'credential.https://github.com.helper'=''`)
    expect(parameters).toContain(`'core.hookspath'='/data/hooks'`)
  })

  it('makes Harness\'s helper the only one git asks for github.com, keeps other hosts on their own, and fetches ssh over https', () => {
    const dir = fresh('credential')
    const ownerLog = join(dir, 'owner.log')
    const owner = script(join(dir, 'owner-helper'), `echo "$1" >> '${ownerLog}'\n[ "$1" = get ] && printf 'username=owner\\npassword=owner-secret\\n'`)
    writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = ${owner}\n`)
    const helper = script(join(dir, "Harness's helper"), `cat > '${join(dir, 'asked.txt')}'\n[ "$1" = get ] && printf 'username=x-access-token\\npassword=task-token\\n'`)
    const env = { GIT_CONFIG_PARAMETERS: gitConfigParameters(helper, join(dir, 'hooks')) }
    const github = git(dir, ['credential', 'fill'], env, 'url=https://github.com/acme/app.git\n\n')
    expect(github.stdout).toContain('password=task-token')
    // git sends the repository's path, which the helper checks.
    expect(readFileSync(join(dir, 'asked.txt'), 'utf8')).toContain('path=acme/app.git')
    expect(existsSync(ownerLog)).toBe(false)
    const other = git(dir, ['credential', 'fill'], env, 'url=https://gitlab.example.com/acme/app.git\n\n')
    expect(other.stdout).toContain('password=owner-secret')
    expect(git(dir, ['ls-remote', '--get-url', 'git@github.com:acme/app.git'], env).stdout.trim()).toBe('https://github.com/acme/app.git')
    expect(git(dir, ['ls-remote', '--get-url', 'ssh://git@github.com/acme/app.git'], env).stdout.trim()).toBe('https://github.com/acme/app.git')
    expect(git(dir, ['ls-remote', '--get-url', 'git@gitlab.example.com:acme/app.git'], env).stdout.trim()).toBe('git@gitlab.example.com:acme/app.git')
    rmSync(join(home, '.gitconfig'))
  })
})

describe('the shared helper and hooks', () => {
  it('prepares a Swarm folder with the app\'s token alone: none of the owner\'s git setup, ssh over https, and nothing on a command line', () => {
    const dir = fresh('prepare')
    const ownerLog = join(dir, 'owner.log')
    const owner = script(join(dir, 'owner-helper'), `echo "$1" >> '${ownerLog}'\n[ "$1" = get ] && printf 'username=owner\\npassword=owner-secret\\n'`)
    // An owner whose global config has a credential helper and sends github.com over their own ssh key.
    const ownerHome = fresh('owner-home')
    writeFileSync(join(ownerHome, '.gitconfig'), `[credential]\n\thelper = ${owner}\n[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n`)
    const token = `ghs_${'t'.repeat(36)}`
    const env = swarmGitPrepareEnv(token, { PATH: process.env.PATH!, HOME: ownerHome, GIT_ASKPASS: '/owner/askpass', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: owner, GH_TOKEN: 'owner-gh-token', GIT_SSH_COMMAND: 'ssh -i /owner/key' })
    for (const key of ['GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GH_TOKEN']) expect(env).not.toHaveProperty(key)
    expect(env.GIT_SSH_COMMAND).not.toContain('/owner/key')
    expect(env.GIT_CONFIG_PARAMETERS).not.toContain(token)
    const run = (args: string[], input?: string) => spawnSync('git', args, { cwd: dir, input, encoding: 'utf8', env: env as Record<string, string> })
    const filled = run(['credential', 'fill'], 'url=https://github.com/acme/app.git\n\n')
    expect(filled.status).toBe(0)
    expect(filled.stdout).toContain('username=x-access-token')
    expect(filled.stdout).toContain(`password=${token}`)
    expect(existsSync(ownerLog)).toBe(false)
    // The owner's rewrite to ssh is not read; ssh addresses of github.com go over https.
    expect(run(['ls-remote', '--get-url', 'https://github.com/acme/app.git']).stdout.trim()).toBe('https://github.com/acme/app.git')
    expect(run(['ls-remote', '--get-url', 'git@github.com:acme/app.git']).stdout.trim()).toBe('https://github.com/acme/app.git')
    expect(run(['config', '--get-all', 'credential.helper']).stdout).not.toContain('owner-helper')
    // GitHub's stateless installation token, ghs_APPID_ and a JWT of about 520 characters, is in GitHub's form.
    expect(swarmGitPrepareEnv(STATELESS).HARNESS_SWARM_GIT_TOKEN).toBe(STATELESS)
    // A token not in GitHub's form is refused before any git runs with it.
    expect(() => swarmGitPrepareEnv('not a token; rm -rf /')).toThrow('not in the form GitHub gives')
  })

  it('writes the helper for this daemon\'s CLI and one hook for every hook git runs, private to its user, once', () => {
    const dataDir = fresh('data')
    const { helper, hooks } = writeSwarmGitHubTools({ dataDir, command: "'/opt/node' '/opt/harness/cli.js'", port: 18500, machineId: 'machine-1' })
    expect(readFileSync(helper, 'utf8')).toBe('#!/bin/sh\n# Written by Harness for Swarm agents\' git (docs/swarm-github-app.md); rewritten as agents start.\n'
      + `ADAPTER_DATA_DIR='${dataDir}' exec '/opt/node' '/opt/harness/cli.js' git-credential --port 18500 --machine 'machine-1' "$@"\n`)
    expect(statSync(helper).mode & 0o777).toBe(0o700)
    for (const name of GIT_HOOK_NAMES) expect(statSync(join(hooks, name)).mode & 0o777).toBe(0o700)
    const before = statSync(join(hooks, 'pre-commit')).ino
    writeSwarmGitHubTools({ dataDir, command: "'/opt/node' '/opt/harness/cli.js'", port: 18500, machineId: 'machine-1' })
    expect(statSync(join(hooks, 'pre-commit')).ino).toBe(before)
    writeSwarmGitHubTools({ dataDir, command: "'/opt/node' '/opt/harness/cli.js'", port: 18501, machineId: 'machine-1' })
    expect(readFileSync(helper, 'utf8')).toContain('--port 18501')
  })
})

// One daemon folder for every session below, as on a machine: macOS checks each new executable the first time it runs,
// which takes seconds for a fresh set of hooks.
describe('commits in a Swarm session', { timeout: 60_000 }, () => {
  const shared = fresh('daemon')
  const cli = script(join(shared, 'fake-cli'), `echo "$*" >> "$HARNESS_SWARM_GITHUB_DIR/cli.log"\n[ "$6" = trailers ] && printf 'Co-authored-by: Ada <ada@example.com>\\nHarness-Agent: Atlas\\n' > "$HARNESS_SWARM_GITHUB_DIR/trailers"\nexit 0`)
  /** A repository and a session whose fake CLI answers `trailers` by writing them, and logs every call. */
  function session() {
    const dir = fresh('commit')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const launch = swarmGitHubLaunch(`harness-claude-fixture-${made}`, { dataDir: shared, command: `/bin/sh ${shellWord(cli)}`, port: 18500, machineId: 'machine-1' }, 'darwin')!
    expect(git(repo, ['init', '-q', '-b', 'main']).status).toBe(0)
    const env = { GIT_CONFIG_PARAMETERS: launch.env.GIT_CONFIG_PARAMETERS!, HARNESS_SWARM_GITHUB_DIR: launch.env.HARNESS_SWARM_GITHUB_DIR! }
    const commit = (args: string[], extra: Record<string, string> = {}) => git(repo, ['commit', '-q', '--allow-empty', ...args], { ...env, ...extra })
    const message = () => git(repo, ['log', '-1', '--format=%B'], env).stdout
    const own = (name: string, body: string, where = join(repo, '.git', 'hooks')) => { mkdirSync(where, { recursive: true }); script(join(where, name), body) }
    return { dir, repo, env, commit, message, own, calls: join(launch.env.HARNESS_SWARM_GITHUB_DIR!, 'cli.log'), trailers: join(launch.env.HARNESS_SWARM_GITHUB_DIR!, 'trailers') }
  }

  it('adds the trailers after the repository\'s own hooks, once, and without them the commit asks the CLI for them', () => {
    const s = session()
    s.own('pre-commit', `touch '${join(s.dir, 'pre-commit-ran')}'`)
    s.own('prepare-commit-msg', 'printf "\\nTicket: OPS-1\\n" >> "$1"')
    expect(s.commit(['-m', 'Add search']).status).toBe(0)
    expect(existsSync(join(s.dir, 'pre-commit-ran'))).toBe(true)
    expect(s.message()).toBe('Add search\n\nTicket: OPS-1\nCo-authored-by: Ada <ada@example.com>\nHarness-Agent: Atlas\n\n')
    expect(readFileSync(s.calls, 'utf8')).toBe('git-credential --port 18500 --machine machine-1 trailers\n')
    expect(s.commit(['--amend', '--no-edit']).status).toBe(0)
    expect(s.message().match(/Harness-Agent/g)).toHaveLength(1)
    // The file is there now: no second call.
    expect(s.commit(['-m', 'Second']).status).toBe(0)
    expect(readFileSync(s.calls, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('keeps the trailers with --no-verify, a message from the editor, and a message file', () => {
    const s = session()
    writeFileSync(s.trailers, 'Co-authored-by: Ada <ada@example.com>\n')
    expect(s.commit(['--no-verify', '-m', 'Skip checks']).status).toBe(0)
    expect(s.message()).toContain('Co-authored-by: Ada <ada@example.com>')
    const editor = script(join(s.dir, 'editor'), 'printf "Written in the editor\\n" > "$1"')
    expect(s.commit([], { GIT_EDITOR: editor }).status).toBe(0)
    expect(s.message()).toBe('Written in the editor\n\nCo-authored-by: Ada <ada@example.com>\n\n')
    writeFileSync(join(s.dir, 'msg.txt'), 'From a file\n')
    expect(s.commit(['-F', join(s.dir, 'msg.txt')]).status).toBe(0)
    expect(s.message()).toContain('From a file\n\nCo-authored-by: Ada <ada@example.com>')
  })

  it('still aborts an empty message, and the repository\'s own failing hook still refuses the commit', () => {
    const s = session()
    writeFileSync(s.trailers, 'Harness-Agent: Atlas\n')
    const empty = s.commit(['-m', ''])
    expect(empty.status).not.toBe(0)
    expect(empty.stderr).toContain('empty commit message')
    s.own('commit-msg', 'echo "commit-msg says no" >&2\nexit 1')
    const refused = s.commit(['-m', 'Bad'])
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('commit-msg says no')
  })

  it('runs hooks from the repository\'s own hooksPath, and hands a pre-push hook its input', () => {
    const s = session()
    writeFileSync(s.trailers, 'Harness-Agent: Atlas\n')
    expect(git(s.repo, ['config', 'core.hooksPath', '.husky'], s.env).status).toBe(0)
    s.own('pre-commit', `touch '${join(s.dir, 'husky-ran')}'`, join(s.repo, '.husky'))
    s.own('pre-push', `cat > '${join(s.dir, 'pushed.txt')}'`, join(s.repo, '.husky'))
    expect(s.commit(['-m', 'With husky']).status).toBe(0)
    expect(existsSync(join(s.dir, 'husky-ran'))).toBe(true)
    const remote = join(s.dir, 'remote.git')
    expect(git(s.dir, ['init', '-q', '--bare', remote]).status).toBe(0)
    expect(git(s.repo, ['push', '-q', remote, 'main'], s.env).status).toBe(0)
    expect(readFileSync(join(s.dir, 'pushed.txt'), 'utf8')).toMatch(/^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main 0{40}\n$/)
  })
})

describe('a session\'s gh login and trailers', () => {
  it('writes gh\'s login for github.com, private to its user, and empties it on request', () => {
    const dir = fresh('gh')
    writeSessionGitHub(dir, 'ghs_fixtureToken0000001', ['Co-authored-by: Ada <ada@example.com>', 'bad line', 'Harness-Agent: Atlas\nInjected: x'])
    expect(readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8')).toBe('github.com:\n    users:\n        x-access-token:\n            oauth_token: ghs_fixtureToken0000001\n'
      + '    git_protocol: https\n    oauth_token: ghs_fixtureToken0000001\n    user: x-access-token\n')
    expect(readFileSync(join(dir, 'gh', 'config.yml'), 'utf8')).toBe('version: "1"\n')
    expect(statSync(join(dir, 'gh', 'hosts.yml')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, 'trailers'), 'utf8')).toBe('Co-authored-by: Ada <ada@example.com>\n')
    writeSessionGitHub(dir, null)
    expect(readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8')).toBe('{}\n')
    // Trailers are kept: who the work is for does not change with the token.
    expect(readFileSync(join(dir, 'trailers'), 'utf8')).toBe('Co-authored-by: Ada <ada@example.com>\n')
    writeSessionGitHub(dir, STATELESS)
    expect(readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8')).toContain(`    oauth_token: ${STATELESS}\n`)
    writeSessionGitHub(dir, 'not a token\n    oauth_token: other')
    expect(readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8')).toBe('{}\n')
  })

  // A Harness Team account has no git identity: its commits read "Harness Team <harnessteam@<host>.local>" (PR #1934).
  it('makes the session\'s commits the app\'s when the server names its bot account, and git\'s own otherwise', () => {
    const dir = fresh('identity')
    // git as the session runs it: no identity in the environment, only what its config says.
    const env = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_PARAMETERS: gitConfigParameters('/no/helper', join(dir, 'hooks'), join(dir, 'gitconfig')) }
    const vars = (name: string) => spawnSync('git', ['var', name], { cwd: dir, encoding: 'utf8', env }).stdout
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Owner\n\temail = owner@example.com\n')
    const ident = () => vars('GIT_AUTHOR_IDENT')
    expect(ident()).toMatch(/^Owner <owner@example\.com> /)
    const bot = { name: 'harness-for-autonomous[bot]', email: '245891234+harness-for-autonomous[bot]@users.noreply.github.com' }
    writeSessionGitHub(dir, 'ghs_fixtureToken0000001', [], bot)
    expect(statSync(join(dir, 'gitconfig')).mode & 0o777).toBe(0o600)
    expect(ident()).toMatch(/^harness-for-autonomous\[bot\] <245891234\+harness-for-autonomous\[bot\]@users\.noreply\.github\.com> /)
    expect(vars('GIT_COMMITTER_IDENT')).toMatch(/^harness-for-autonomous\[bot\] </)
    // A refusal keeps it; an answer without one (an older server, a person's machine) or with anything else drops it.
    writeSessionGitHub(dir, null)
    expect(ident()).toMatch(/^harness-for-autonomous\[bot\] </)
    for (const other of [null, { name: 'Mallory', email: 'm@example.com' }, { ...bot, name: 'x[bot]\n[core]' }, 'bot']) {
      writeSessionGitHub(dir, 'ghs_fixtureToken0000001', [], bot)
      writeSessionGitHub(dir, 'ghs_fixtureToken0000001', [], other)
      expect(existsSync(join(dir, 'gitconfig'))).toBe(false)
      expect(ident()).toMatch(/^Owner </)
    }
    rmSync(join(home, '.gitconfig'))
  })
})

describe('a Swarm session\'s launch', () => {
  it('names the session\'s gh folder and Harness\'s git settings, clears inherited GitHub tokens, and starts with no gh login', () => {
    const dataDir = fresh('launch')
    const launch = swarmGitHubLaunch('harness-codex-abc', { dataDir, command: 'harness', port: 18473, machineId: 'm1' }, 'linux')!
    const dir = swarmGitHubSessionDir(dataDir, 'harness-codex-abc')!
    expect(launch.env).toEqual({
      GIT_CONFIG_PARAMETERS: gitConfigParameters(join(dataDir, 'swarm-github', 'bin', 'git-credential'), join(dataDir, 'swarm-github', 'hooks'), join(dir, 'gitconfig')),
      GIT_TERMINAL_PROMPT: '0', GH_CONFIG_DIR: join(dir, 'gh'), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', HARNESS_SWARM_GITHUB_DIR: dir,
    })
    expect(launch.clearEnv).toEqual(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])
    expect(readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8')).toBe('{}\n')
    // A relaunch keeps a login the daemon has written since.
    writeSessionGitHub(dir, 'ghs_fixtureToken0000002')
    swarmGitHubLaunch('harness-codex-abc', { dataDir, command: 'harness', port: 18473, machineId: 'm1' }, 'linux')
    expect(readFileSync(join(dir, 'gh', 'hosts.yml'), 'utf8')).toContain('ghs_fixtureToken0000002')
  })

  it('does not apply on Windows or to a key unfit for a path', () => {
    const dataDir = fresh('none')
    expect(swarmGitHubLaunch('harness-codex-abc', { dataDir, command: 'harness', port: 18473, machineId: 'm1' }, 'win32')).toBeNull()
    expect(swarmGitHubLaunch('../escape', { dataDir, command: 'harness', port: 18473, machineId: 'm1' }, 'darwin')).toBeNull()
    expect(existsSync(join(dataDir, 'swarm-github'))).toBe(false)
  })
})

// Review of #1998: a start held between its launch preparation and its session's registration could look untouched for 15
// minutes and lose its folder (superTabs/github.ts emptyStopped). Each launch preparation marks the folder as just used.
describe('a session\'s GitHub folder at launch', () => {
  it('is marked as just used every time a launch is prepared', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'swarm-github-launch-'))
    try {
      const tools = { dataDir, command: 'harness', port: 18473, machineId: 'm1' }
      expect(swarmGitHubLaunch('harness-codex-held', tools, 'darwin')).not.toBeNull()
      const dir = swarmGitHubSessionDir(dataDir, 'harness-codex-held')!
      const old = new Date(Date.now() - 20 * 60_000)
      utimesSync(dir, old, old)
      swarmGitHubLaunch('harness-codex-held', tools, 'darwin')
      expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(60_000)
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })
})
