import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TmuxBackend } from './tmuxBackend.js'
import { ensureTmuxOnPath, managedTmuxPath, requireTmuxAvailable, resolveViaLoginShell, tmuxInstallDirectories } from './tmuxOnPath.js'

const dirs: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A runtime dir with no managed tmux — so a developer machine's real ~/.harness never leaks in. */
const noManagedTmux = () => scratch('tmux-onpath-no-runtime-')

/** A stand-in for the user's shell: it knows about `binDir`, the daemon's own PATH does not. */
function fakeShell(binDir: string): string {
  const dir = scratch('tmux-onpath-shell-')
  const shell = join(dir, 'sh')
  writeFileSync(shell, `#!/bin/sh
# Mimics "zsh -lic <script> $0 $1": drop the flag, run the script with the remaining positionals.
shift
# Hermetic: ONLY this dir, or the real tmux on the test machine leaks in and the
# "cannot find it either" case silently passes for the wrong reason.
PATH="${binDir}" exec /bin/sh -c "$@"
`)
  chmodSync(shell, 0o700)
  return shell
}

/** A shell that answers ONLY when asked as a login shell — a bash user with PATH in ~/.bash_profile. */
function loginOnlyShell(binDir: string): string {
  const dir = scratch('tmux-onpath-login-')
  const shell = join(dir, 'bash')
  writeFileSync(shell, `#!/bin/sh
# The daemon asks bash with '-ic'; only '-lic' reads the file this user's PATH lives in.
case "$1" in
  -lic) ;;
  *) exit 0 ;;
esac
shift
PATH="${binDir}" exec /bin/sh -c "$@"
`)
  chmodSync(shell, 0o700)
  return shell
}

function fakeTmux(): string {
  const dir = scratch('tmux-onpath-bin-')
  const tmux = join(dir, 'tmux')
  writeFileSync(tmux, '#!/bin/sh\nexit 0\n')
  chmodSync(tmux, 0o700)
  return dir
}

describe('ensureTmuxOnPath', () => {
  it('adopts the directory the user\'s shell finds tmux in', async () => {
    const binDir = fakeTmux()
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent-for-this-test' }

    const outcome = await ensureTmuxOnPath(env, fakeShell(binDir), noManagedTmux())

    expect(outcome.state).toBe('adopted')
    if (outcome.state !== 'adopted') return
    expect(outcome.from).toBe(binDir)
    // The point of the whole exercise: every later execFile('tmux', …) now resolves.
    expect(env.PATH?.split(delimiter)[0]).toBe(binDir)
    expect(env.PATH).toContain('/nonexistent-for-this-test')
  })

  it('asks again as a login shell when the interactive one comes back empty', async () => {
    // A bash machine, measured here: `bash -ic` resolved nothing and `bash -lic` returned
    // /usr/local/bin/tmux, so the daemon logged "tmux: unavailable (spawn tmux ENOENT)" and served
    // ZERO agents while nine tmux sessions were running. zsh keeps PATH in .zshrc, which `-i` reads;
    // bash keeps it in .bash_profile, which only `-l` does.
    const binDir = fakeTmux()
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent' }
    const outcome = await ensureTmuxOnPath(env, loginOnlyShell(binDir), noManagedTmux())

    expect(outcome.state).toBe('adopted')
    expect(env.PATH?.split(delimiter)[0]).toBe(binDir)
  })

  it('finds tmux after startup chatter from the login shell', async () => {
    const binDir = fakeTmux()
    const shell = join(scratch('tmux-onpath-chatty-shell-'), 'zsh')
    writeFileSync(shell, `#!/bin/sh
shift
printf '%s\\n' 'Now using node v25.7.0'
PATH="${binDir}" exec /bin/sh -c "$@"
`)
    chmodSync(shell, 0o700)
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent-for-this-test' }

    const outcome = await ensureTmuxOnPath(env, shell, noManagedTmux())

    expect(outcome).toMatchObject({ state: 'adopted', path: join(binDir, 'tmux') })
    expect(env.PATH?.split(delimiter)[0]).toBe(binDir)
  })

  it('falls back to the managed tmux when no shell can resolve one', async () => {
    const runtimeDir = scratch('tmux-onpath-runtime-')
    const binDir = join(runtimeDir, 'tmux-9.9-darwin-arm64', 'bin')
    mkdirSync(binDir, { recursive: true })
    const managed = join(binDir, 'tmux')
    writeFileSync(managed, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(runtimeDir, 'current-tmux'), `${managed}\n`)
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent' }

    const outcome = await ensureTmuxOnPath(env, '/nonexistent/shell', runtimeDir)

    expect(outcome).toEqual({ state: 'adopted', path: managed, from: 'managed runtime' })
    expect(env.PATH!.split(delimiter)[0]).toBe(binDir)
  })

  it("prefers the tmux the user's shell resolves over the managed one", async () => {
    // Both exist: the daemon must run what the terminal runs, or they talk to two servers.
    const runtimeDir = scratch('tmux-onpath-runtime-both-')
    const managedBin = join(runtimeDir, 'tmux-9.9-darwin-arm64', 'bin')
    mkdirSync(managedBin, { recursive: true })
    writeFileSync(join(managedBin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(runtimeDir, 'current-tmux'), `${join(managedBin, 'tmux')}\n`)
    const usersBin = scratch('tmux-onpath-users-')
    writeFileSync(join(usersBin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent' }

    const outcome = await ensureTmuxOnPath(env, fakeShell(usersBin), runtimeDir)

    expect(outcome).toEqual({ state: 'adopted', path: join(usersBin, 'tmux'), from: usersBin })
    expect(env.PATH!.split(delimiter)[0]).toBe(usersBin)
  })

  it('ignores a current-tmux that points outside the runtime dir or cannot run', () => {
    const runtimeDir = scratch('tmux-onpath-runtime-bad-')
    const elsewhere = scratch('tmux-onpath-elsewhere-')
    const outside = join(elsewhere, 'tmux')
    writeFileSync(outside, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(runtimeDir, 'current-tmux'), `${outside}\n`)
    expect(managedTmuxPath(runtimeDir)).toBeNull()

    writeFileSync(join(runtimeDir, 'current-tmux'), `${join(runtimeDir, 'gone', 'bin', 'tmux')}\n`)
    expect(managedTmuxPath(runtimeDir)).toBeNull()

    expect(managedTmuxPath(scratch('tmux-onpath-runtime-empty-'))).toBeNull()
  })

  it('leaves an already-working PATH untouched', async () => {
    const binDir = fakeTmux()
    const env: NodeJS.ProcessEnv = { PATH: binDir }

    const outcome = await ensureTmuxOnPath(env, fakeShell(binDir), noManagedTmux())

    expect(outcome.state).toBe('present')
    // No duplicate entry: this runs on every start, so it has to be idempotent.
    expect(env.PATH).toBe(binDir)
  })

  it('reports absent when neither the daemon nor the shell can find tmux', async () => {
    const emptyBin = scratch('tmux-onpath-empty-')
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent-for-this-test' }

    const outcome = await ensureTmuxOnPath(env, fakeShell(emptyBin), noManagedTmux(), [])

    expect(outcome.state).toBe('absent')
    expect(env.PATH).toBe('/nonexistent-for-this-test')
  })

  it('fails before daemon startup when tmux is unavailable', () => {
    expect(() => requireTmuxAvailable({
      state: 'absent',
      reason: 'the user\'s login shell does not resolve tmux either',
    })).toThrow('tmux is required but unavailable')
  })

  it('does not consult a shell it cannot trust', async () => {
    // A relative SHELL is not something to hand a command to.
    expect(await resolveViaLoginShell('tmux', 'sh')).toBeNull()
  })
  it('turns the reported failure into a working create', async () => {
    // A tmux that answers like the real one, in a directory the daemon's PATH does not list.
    const binDir = scratch('tmux-onpath-real-')
    const tmux = join(binDir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
case "$1" in
  new-session) printf '%%7\\n' ;;
esac
exit 0
`)
    chmodSync(tmux, 0o700)
    const shell = fakeShell(binDir)

    // Before: exactly what the machine reported after its reboot.
    process.env.PATH = '/nonexistent-for-this-test'
    const before = await new TmuxBackend().create({ cwd: '/tmp', label: 'harness-test' })
    expect(before.state).not.toBe('succeeded')
    if (before.state !== 'succeeded') expect(before.reason).toBe('tmux is unavailable')

    // After: the same call, once the daemon has been told where the user's shell finds tmux.
    expect((await ensureTmuxOnPath(process.env, shell, noManagedTmux())).state).toBe('adopted')
    const after = await new TmuxBackend().create({ cwd: '/tmp', label: 'harness-test' })

    expect(after).toEqual({
      state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%7' },
    })
  })

  it('creates the first pane with an installed tmux absent from a fresh user’s shell', async () => {
    const binDir = scratch('tmux-onpath-installed-')
    writeFileSync(join(binDir, 'tmux'), `#!/bin/sh
case "$1" in
  -V) printf 'tmux 3.7c\\n' ;;
  new-session) printf '%%0\\n' ;;
esac
`, { mode: 0o700 })
    const runtimeDir = noManagedTmux()
    process.env.PATH = '/nonexistent-for-this-test'
    const backend = new TmuxBackend()
    expect(await backend.create({ label: 'harness-first' })).toMatchObject({
      state: 'failed', reason: 'tmux is unavailable',
    })

    // The installer found Homebrew in a known prefix. Neither the daemon nor
    // this new OS user's login shell inherited the installer's temporary PATH.
    const outcome = await ensureTmuxOnPath(process.env, '/nonexistent/shell', runtimeDir, [binDir])
    expect(outcome).toMatchObject({ state: 'adopted', path: join(binDir, 'tmux') })
    expect(await backend.create({ label: 'harness-first' })).toMatchObject({
      state: 'succeeded', runtime: { backend: 'tmux', paneId: '%0' },
    })
  })

  it('checks the user bin and both macOS Homebrew prefixes, but not Homebrew on Linux', () => {
    expect(tmuxInstallDirectories({ HOME: '/Users/new-user' }, 'darwin')).toEqual([
      '/Users/new-user/.local/bin', '/opt/homebrew/bin', '/usr/local/bin',
    ])
    expect(tmuxInstallDirectories({ HOME: '/home/new-user' }, 'linux')).toEqual(['/home/new-user/.local/bin'])
    expect(tmuxInstallDirectories({ HARNESS_BIN_DIR: '/custom/bin', HARNESS_HOMEBREW_PREFIXES: '/custom/brew' }, 'darwin'))
      .toEqual(['/custom/bin', '/custom/brew/bin'])
  })

  it('skips a broken install candidate and adopts the next runnable tmux', async () => {
    const broken = scratch('tmux-onpath-broken-')
    writeFileSync(join(broken, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    const working = scratch('tmux-onpath-working-')
    writeFileSync(join(working, 'tmux'), '#!/bin/sh\nprintf "tmux 3.7c\\n"\n', { mode: 0o700 })
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent' }
    expect(await ensureTmuxOnPath(env, '/nonexistent/shell', noManagedTmux(), [broken, working]))
      .toMatchObject({ state: 'adopted', path: join(working, 'tmux') })
    expect(env.PATH?.split(delimiter)[0]).toBe(working)
  })
})
