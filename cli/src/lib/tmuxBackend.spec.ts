import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, type ExecFileException } from 'node:child_process'
import { TmuxBackend, clearEnvArgs, serverVariables, tmuxScript, tmuxWord, unsetServerEnvArgs } from './tmuxBackend.js'
import { clearPaneRemainOnExit, forgetTmuxServer } from './tmux.js'
import { tmuxControlGate } from './tmuxControlGate.js'
import { assumeTmuxVersion, resetTmuxVersionCache, tmuxFeatures } from './tmuxVersion.js'
import { isHarnessdVariable } from './harnessdEnv.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { DEFAULT_HOST_THEME } from './hostTheme.js'

/**
 * The fake tmux in these specs is a real `/bin/sh` script, and on a loaded machine one takes seconds to
 * start. The daemon's 2 s deadline (patientExec.ts) then killed it, and the backend answered, rightly,
 * as for a tmux it could not ask: a pane with no server read as `unknown`, not `gone`, and a listing
 * as `unavailable` (CI, and 1 run in 4 locally under load). Here every call runs to its answer
 * however long it takes; what a deadline does is patientExec.spec.ts's to test. And each call is
 * counted while it runs, so a test can wait for the ones a scan leaves going behind it: the restyle
 * after an inventory wrote into the test's folder as `afterEach` removed it (ENOTEMPTY on #826).
 */
const running = vi.hoisted(() => new Set<Promise<void>>())
vi.mock('./patientExec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./patientExec.js')>()
  const patientExec: typeof actual.patientExec = (execFile) => (file, args, options, done) => {
    const { timeout: _timeout, killSignal: _killSignal, ...rest } = options
    let finished = (): void => {}
    const call = new Promise<void>((resolve) => { finished = resolve })
    running.add(call)
    execFile(file, [...args], { ...rest, encoding: 'utf8' }, (error: ExecFileException | null, stdout: string, stderr: string) => {
      // Whatever the answer starts (the next restyle of a pane) is counted before this one ends.
      try { done(error, stdout ?? '', stderr ?? '') } finally {
        running.delete(call)
        finished()
      }
    })
  }
  // The same for a list given on stdin (`runScript`), which arms the deadline itself.
  return { ...actual, patientExec, patientDeadline: () => () => {} }
})

/** Until no tmux or `ps` call is running, the ones a scan left going in the background included. */
async function settled(): Promise<void> {
  for (let quiet = 0; quiet < 3;) {
    await new Promise((resolve) => setImmediate(resolve))
    if (running.size) {
      quiet = 0
      await Promise.all(running)
    } else quiet++
  }
}

// No deadline above, so a slow machine makes a test slow, never wrong: room for it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const originalPath = process.env.PATH
const dirs: string[] = []

// A tmux that answers `-V` with no number reads as the newest; the specs that need an older one say so.
beforeEach(() => assumeTmuxVersion(null))

afterEach(async () => {
  await settled()
  // The server an inventory remembered is this test's fake, never the next one's (`rememberTmuxServer`).
  forgetTmuxServer()
  resetTmuxVersionCache()
  process.env.PATH = originalPath
  delete process.env.TMUX_BACKEND_CALLS
  // Retried: listing panes also remembers the tmux server in the background (lib/tmux.ts), and that
  // fake tmux can still be writing its call into the folder as the test ends (ENOTEMPTY on CI's Linux).
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('TmuxBackend lifecycle', () => {
  it('keeps environment writes out of a pane revoked during session lookup', async () => {
    const calls = recordingTmux('', '$4')
    let current = true
    const pending = new TmuxBackend().clearEnv({ backend: 'tmux', paneId: '%4' }, ['FIXTURE_MODEL'], () => current)
    current = false
    expect(await pending).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(calls()).toEqual(['display-message -p -t %4 #{session_id}'])
  })

  it('does not retain a pane after ownership changes during feature discovery', async () => {
    const calls = recordingTmux()
    let release!: () => void, current = true
    const ready = new Promise<void>(done => { release = done })
    const features = vi.fn(async () => { await ready; return { paneOptions: true } })
    const pending = new TmuxBackend(undefined, undefined, undefined, features as never)
      .holdOpen({ backend: 'tmux', paneId: '%4' }, () => current)
    await vi.waitFor(() => expect(features).toHaveBeenCalled())
    current = false
    release()
    expect(await pending).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(calls()).toEqual([])
  })

  it.each(['create', 'respawn'] as const)('rechecks core ownership after the feature wait before %s dispatch', async operation => {
    let release!: () => void
    let current = true
    const pending = new Promise<void>(done => { release = done })
    const features = vi.fn(async () => { await pending; return { paneOptions: true, sessionEnv: true, respawnEnv: true, controlNotifyGuard: true } })
    const backend = new TmuxBackend(undefined, () => 'private-test-owner', () => {}, features as never)
    const onDispatch = vi.fn()
    const request = { command: ['never-executed'], current: () => current, onDispatch }
    const result = operation === 'create' ? backend.create(request) : backend.respawn({ backend: 'tmux', paneId: '%42' }, request)
    await vi.waitFor(() => expect(features).toHaveBeenCalled())
    current = false
    release()
    expect(await result).toMatchObject({ state: 'failed', dispatch: 'not_started', reason: 'The harness changed before pane dispatch' })
    expect(onDispatch).not.toHaveBeenCalled()
  })

  it('rechecks ownership inside the tmux notification gate before allocating a pane', async () => {
    assumeTmuxVersion({ major: 3, minor: 4 })
    const leave = await tmuxControlGate.enter('attach')
    let current = true
    const onDispatch = vi.fn()
    const result = new TmuxBackend(undefined, () => 'private-test-owner', () => {}).create({ current: () => current, onDispatch })
    await vi.waitFor(() => expect(tmuxControlGate.state.waiting).toBe(1))
    current = false
    leave()
    expect(await result).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(onDispatch).not.toHaveBeenCalled()
  })

  it.each(['tmux', 'ps'] as const)('does not declare a running pane gone when the %s probe fails', async failed => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-probe-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\n${failed === 'tmux' ? 'exit 1' : 'echo 12345'}\n`, { mode: 0o700 })
    writeFileSync(join(dir, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    expect(await new TmuxBackend().validate({ backend: 'tmux', paneId: '%42' }, {
      engine: 'claude', processIdentity: { pid: 12345, executable: 'claude', startMarker: 'Sun Sep 27 20:00:00 2026' },
    })).toMatchObject({ state: 'unknown' })
  })

  it('submits a text, and leaves it typed with no Enter when the check before the Enter says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-submit-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$1" >> "$TMUX_BACKEND_CALLS"\nif [ "$1" = "load-buffer" ]; then cat > /dev/null; fi\n`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    const backend = new TmuxBackend(undefined, () => 'daemon-a')
    const pane = { backend: 'tmux' as const, paneId: '%42' }
    await expect(backend.submitText(pane, 'hi', { beforeEnter: async () => null })).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    await expect(backend.submitText(pane, 'hi', { beforeEnter: async () => 'permission_open' })).resolves
      .toEqual({ state: 'unknown', dispatch: 'possibly_executed', reason: 'enter_withheld:permission_open' })
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['load-buffer', 'paste-buffer', 'send-keys', 'load-buffer', 'paste-buffer'])
  })

  it('reports a failed buffer load as not pasted, rather than a possible submission', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-load-fail-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$1" >> "$TMUX_BACKEND_CALLS"
if [ "$1" = "load-buffer" ]; then cat > /dev/null; exit 2; fi
`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    const result = await new TmuxBackend().submitText({ backend: 'tmux', paneId: '%42' }, 'one message')
    expect(result).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['load-buffer', 'delete-buffer'])
  })

  it('creates a detached session and closes only its exact pane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-lifecycle-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
case "$1" in
  new-session) printf '%%42\\n' ;;
  display-message) printf '$7\\n' ;;
esac
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    const backend = new TmuxBackend(undefined, () => 'daemon-a')

    const created = await backend.create({ cwd: '/tmp/work', label: 'harness-test' })
    expect(created).toEqual({
      state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%42' },
    })
    if (created.state !== 'succeeded') return
    await expect(backend.kill(created.runtime)).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      // `remain-on-exit` is chained into the SAME invocation, not sent after it: an engine that
      // exits immediately would otherwise take its session down before a follow-up call landed,
      // and its error text with it.
      // `window-style` rides the same invocation for the same reason: the engine asks its
      // terminal for its colours (OSC 10/11) once, at startup, and never again. And so does the
      // daemon's tag: another daemon on this tmux server must never see the pane untagged.
      // All three on the pane itself, where tmux has pane options: they go with it wherever the person
      // moves it, and never touch the rest of a window of theirs.
      'new-session -d -P -F #{pane_id} -c /tmp/work -s harness-test ; set-option -p remain-on-exit on ; set-option destroy-unattached off ; set-option -p window-style bg=#181818,fg=#f5f5f5 ; set-option -p @harness_daemon daemon-a',
      'set-option -t %42 mouse on',
      'kill-pane -t %42',
    ])
  })

  it('on a tmux before 3.7, makes and closes a session only while no terminal is attaching (tmuxControlGate.ts)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-gate-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$1" >> "$TMUX_BACKEND_CALLS"\n[ "$1" = new-session ] && printf '%%42\\n'\nexit 0\n`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    assumeTmuxVersion({ major: 3, minor: 4 })
    const backend = new TmuxBackend(undefined, () => 'daemon-a')
    const asked = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
    const wait = () => new Promise((resolve) => setTimeout(resolve, 100))

    let attaching = await tmuxControlGate.enter('attach')
    const created = backend.create({ cwd: '/tmp/work' })
    await wait()
    expect(asked()).toEqual([])
    attaching()
    const made = await created
    expect(made.state).toBe('succeeded')
    expect(asked()[0]).toBe('new-session')
    if (made.state !== 'succeeded') return
    await settled()

    attaching = await tmuxControlGate.enter('attach')
    const before = asked().length
    const killed = backend.kill(made.runtime)
    await wait()
    expect(asked()).toHaveLength(before)
    attaching()
    await expect(killed).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(asked().at(-1)).toBe('kill-pane')
  })

  it('reads the machine\'s name before tmux makes a pane, the name tmux titles it with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-name-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"\nprintf '%%42\\n'\n`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    // Whether tmux had run yet, each time the backend read the machine's name.
    const tmuxHadRun: boolean[] = []
    const backend = new TmuxBackend(undefined, () => 'daemon-a', () => { tmuxHadRun.push(existsSync(calls)) })
    expect((await backend.create({ cwd: '/tmp/work' })).state).toBe('succeeded')
    expect(tmuxHadRun).toEqual([false])
    expect(readFileSync(calls, 'utf8')).toContain('new-session')
  })

  it.each(['gone', 'present', 'unknown', 'malformed', 'no server', 'no socket', 'empty'] as const)('verifies %s inventory after a failed pane-close reply', async mode => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-close-'))
    dirs.push(dir)
    // `empty`: a listing with nothing in it, which a running server never gives: an answer that was lost.
    const inventory = mode === 'gone' ? "printf '%%43\\n'" : mode === 'present' ? "printf '%%42\\n'"
      : mode === 'empty' ? 'exit 0'
      : mode === 'malformed' ? "printf 'not a pane\\n'" : mode === 'no server'
        ? "printf 'no server running on /tmp/fixture\\n' >&2; exit 1"
        : mode === 'no socket' ? `printf 'error connecting to ${join(dir, 'gone')} (No such file or directory)\\n' >&2; exit 1` : 'exit 1'
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nif [ "$1" = list-panes ]; then\n${inventory}\nelse\nexit 1\nfi\n`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    const backend = new TmuxBackend()
    // Even if discovery hides this pane (e.g. its session was renamed), the
    // exact-pane check must see it and refuse a false successful pause.
    const discovery = vi.spyOn(backend, 'inventory').mockResolvedValue({ state: 'available', roots: [] })
    expect((await backend.kill({ backend: 'tmux', paneId: '%42' })).state).toBe(mode === 'gone' || mode === 'no server' || mode === 'no socket' ? 'succeeded' : 'unknown')
    expect((await backend.killHeld({ backend: 'tmux', paneId: '%42' }, '12345678-1234-1234-1234-123456789012', () => true)).state)
      .toBe(mode === 'gone' || mode === 'no server' || mode === 'no socket' ? 'succeeded' : 'failed')
    expect(discovery).not.toHaveBeenCalled()
  })

  it('takes a pane listing with nothing in it for a read that was lost, never for no panes', async () => {
    // What Node hands back when its timeout fires on an answer a held event loop had not read yet:
    // success, and nothing. Read as an answer, it said every agent's pane was gone (e2e/stall.e2e.ts).
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-empty-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    expect(await new TmuxBackend(undefined, () => 'daemon-a').inventory()).toEqual({ state: 'unavailable', reason: 'tmux listed no panes' })
  })

  it('sees the panes it tagged wherever they moved, untagged ones only in its sessions, never another daemon\'s', async () => {
    // A dev daemon beside the release one, on one tmux server (2026-10-03): each opened an agent for the
    // other's panes until a pane said whose it was. And the person moves panes: a renamed session, a pane
    // joined into a window of their own (e2e/tmuxmoves.e2e.ts).
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-owner-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh
case "$1" in
  list-panes) printf '%%1|100|harness-claude-1|/work/mine|daemon-a\\n%%2|101|harness-codex-2|/work/theirs|daemon-b\\n%%3|102|harness-claude-3|/work/old|\\n%%4|103|my-claude-work|/work/moved|daemon-a\\n%%5|104|my-shell|/work/shell|\\n%%6|105|their-work|/work/their-moved|daemon-b\\n' ;;
esac
`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    const inventory = await new TmuxBackend(undefined, () => 'daemon-a').inventory()
    expect(inventory.state).toBe('available')
    if (inventory.state !== 'available') return
    // Its own (%1), one a build before the tag created (%3), and its own moved into a session the person
    // named (%4). Not the other daemon's anywhere (%2, %6), and not the person's own shell (%5).
    expect(inventory.roots.map((root) => root.runtime.paneId)).toEqual(['%1', '%3', '%4'])
  })

  it('rejects broad tmux targets before executing a command', async () => {
    const backend = new TmuxBackend()
    expect(await backend.kill({ backend: 'tmux', paneId: '*' })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
  })

  it('styles panes with the theme the app last sent, and re-styles existing ones on a scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-theme-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
case "$1" in
  set-option) sleep 0.05 ;;
  new-session) printf '%%7\\n' ;;
  list-panes) printf '%%7|100|harness-codex-1|/tmp/work\\n%%9|101|harness-claude-2|/tmp/other\\n' ;;
esac
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    let theme = { background: '#171b29', foreground: '#f5f5f5' }
    const backend = new TmuxBackend(() => theme, () => 'daemon-a')

    await backend.create({ cwd: '/tmp/work', label: 'harness-codex-1' })
    await backend.inventory()
    // Nothing changed: the scan touches only the pane it has not styled yet.
    await backend.inventory()
    theme = { background: '#300a24', foreground: '#ffffff' }
    await backend.inventory()
    const styleCalls = () => readFileSync(calls, 'utf8').trim().split('\n').filter((line) => line.includes('window-style'))
    await settled()
    const [created, ...restyled] = styleCalls()
    expect(created).toBe('new-session -d -P -F #{pane_id} -c /tmp/work -s harness-codex-1 ; set-option -p remain-on-exit on ; set-option destroy-unattached off ; set-option -p window-style bg=#171b29,fg=#f5f5f5 ; set-option -p @harness_daemon daemon-a')
    // Sorted: the restyles run beside each other, and which writes its line first is the machine's choice.
    expect(restyled.sort()).toEqual([
      // The pane this daemon did not create is styled on the first scan; %7 already was. Each pane on
      // its own, never its window: the person may have moved it into one of theirs.
      'set-option -p -t %9 window-style bg=#171b29,fg=#f5f5f5',
      // The app changed its palette: every live pane, once.
      'set-option -p -t %7 window-style bg=#300a24,fg=#ffffff',
      'set-option -p -t %9 window-style bg=#300a24,fg=#ffffff',
    ].sort())
    // A scan with nothing changed restyles nothing.
    await backend.inventory()
    await settled()
    expect(styleCalls()).toHaveLength(4)
  })

  it('carries tmux\'s own refusal into the failure reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-refusal-'))
    dirs.push(dir)
    const tmux = join(dir, 'tmux')
    // What a real tmux does when the session name is taken: exit 1, reason on stderr, nothing on
    // stdout. Swallowing that turned every distinct cause into one bare SPAWN_FAILED.
    writeFileSync(tmux, `#!/bin/sh
printf 'duplicate session: harness-test\\n' >&2
exit 1
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`

    const created = await new TmuxBackend().create({ cwd: '/tmp/work', label: 'harness-test' })

    expect(created.state).not.toBe('succeeded')
    if (created.state === 'succeeded') return
    expect(created.reason).toContain('duplicate session: harness-test')
  })

  it('still reports a missing tmux as unavailable rather than a refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-absent-'))
    dirs.push(dir)
    // An empty directory as the ENTIRE path: nothing named tmux is resolvable, so execFile ENOENTs.
    process.env.PATH = dir

    const created = await new TmuxBackend().create({ cwd: '/tmp/work', label: 'harness-test' })

    expect(created.state).not.toBe('succeeded')
    if (created.state === 'succeeded') return
    expect(created.reason).toBe('tmux is unavailable')
    // The same with variables, whose list goes on stdin: a pipe to no process is not a throw.
    expect(await new TmuxBackend().create({ label: 'harness-test', env: { K: 'v' } }))
      .toMatchObject({ state: 'failed', dispatch: 'not_started', reason: 'tmux is unavailable' })
    expect(await new TmuxBackend().respawn({ backend: 'tmux', paneId: '%9' }, { env: { K: 'v' }, command: ['claude'] }))
      .toMatchObject({ state: 'failed', dispatch: 'not_started', reason: 'tmux is unavailable' })
  })

  it('re-arms remain-on-exit on an already-live pane for holdOpen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-holdopen-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls

    await expect(new TmuxBackend().holdOpen({ backend: 'tmux', paneId: '%9' }))
      .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(readFileSync(calls, 'utf8').trim()).toBe('set-option -p -t %9 remain-on-exit on')
  })

  it('inventory only exposes panes whose session was named by agent_create (autonomous-harness-desktop#6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-inventory-'))
    dirs.push(dir)
    const tmux = join(dir, 'tmux')
    // Three panes: one from a daemon-created `harness-*` session (must be listed), one from a
    // session the user opened by hand, and one from a session an agent spawned itself with a
    // nested `tmux new-session` — neither of the latter two went through agent_create, so
    // neither should ever reach discovery.
    writeFileSync(tmux, `#!/bin/sh
case "$1" in
  list-panes)
    printf '%%1|100|harness-claude-1699999999999|/work/demo\\n'
    printf '%%2|200|mysession|/home/user\\n'
    printf '%%3|300|child-of-agent|/work/demo\\n'
    ;;
esac
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`

    const result = await new TmuxBackend().inventory()

    expect(result.state).toBe('available')
    if (result.state !== 'available') return
    expect(result.roots).toEqual([
      { runtime: { backend: 'tmux', paneId: '%1' }, rootPid: 100, cwd: '/work/demo' },
    ])
  })

  it.each([
    ['a stale socket', 'no server running on /tmp/tmux-1000/default'],
    // What `kill-server`, a tmux crash and a reboot leave: the socket file itself gone.
    ['no socket', 'error connecting to /nonexistent/tmux-1000/default (No such file or directory)'],
  ])('treats no tmux server (%s) as an available empty inventory', async (_name, message) => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-no-server-'))
    dirs.push(dir)
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
if [ "$1" = list-panes ]; then
  printf '${message}\\n' >&2
  exit 1
fi
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`

    await expect(new TmuxBackend().inventory()).resolves.toEqual({
      state: 'available',
      roots: [],
    })
  })

  it('reads a pane as gone, not unknown, when no tmux server is running at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-validate-'))
    dirs.push(dir)
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf 'error connecting to ${join(dir, 'gone')} (No such file or directory)\\n' >&2
exit 1
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    await expect(new TmuxBackend().validate({ backend: 'tmux', paneId: '%42' }, { engine: 'claude' })).resolves.toMatchObject({ state: 'gone' })
    // A socket it cannot reach for another reason still says nothing about the pane.
    writeFileSync(tmux, `#!/bin/sh
printf 'error connecting to ${dir} (Permission denied)\\n' >&2
exit 1
`)
    await expect(new TmuxBackend().validate({ backend: 'tmux', paneId: '%42' }, { engine: 'claude' })).resolves.toMatchObject({ state: 'unknown' })
  })

  it('respawns a pane in place with -k, an optional cwd, and the exact argv, no shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-respawn-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls

    const backend = new TmuxBackend()
    await expect(backend.respawn({ backend: 'tmux', paneId: '%9' }, {
      command: ['claude', '--resume', 'abc; rm -rf /'],
      cwd: '/tmp/work',
    })).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    await expect(backend.respawn({ backend: 'tmux', paneId: '%9' }, { command: ['claude'] }))
      .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      // The `;` inside an argv element is never shell-interpreted — it lands as one literal token.
      'set-option -p -t %9 remain-on-exit on ; set-option -p -t %9 @harness_engine_exit  ; respawn-pane -k -c /tmp/work -t %9 claude --resume abc; rm -rf /',
      'set-option -p -t %9 remain-on-exit on ; set-option -p -t %9 @harness_engine_exit  ; respawn-pane -k -t %9 claude',
    ])
  })

  it('displays a bounded message in the addressed pane without a shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-notify-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls

    await expect(new TmuxBackend().notify(
      { backend: 'tmux', paneId: '%7' },
      'Build status',
      'Ready; touch /tmp/must-not-run',
    )).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(readFileSync(calls, 'utf8').trim()).toBe(
      'display-message -t %7 -- Build status: Ready; touch /tmp/must-not-run',
    )
  })
  it('hands the session its own environment, before the command it launches, with no value on a command line', async () => {
    const tmux = scriptTmux()
    const created = await new TmuxBackend(undefined, () => 'daemon-a').create({
      cwd: '/tmp/work',
      label: 'harness-test',
      // A grid relay key. It goes here rather than into `command` precisely so it stays out of the
      // engine's argv, where `ps` would expose it for the life of the agent.
      env: { ANTHROPIC_BASE_URL: 'https://relay.example/relay', ANTHROPIC_AUTH_TOKEN: 'gridkey-abc123' },
      command: ['/bin/zsh', '-lic', 'exec "$@"', 'harness-engine', 'claude'],
    })

    expect(created).toEqual({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%42' } })
    // Audit M2: tmux's own command line names no value. A server it starts keeps it as its title, which
    // every account on the machine reads; the list goes on stdin.
    expect(tmux.calls()[0]).toBe('start-server ; source-file -')
    expect(tmux.calls().join('\n')).not.toContain('gridkey-abc123')
    // Order is load-bearing: everything after the first non-flag argument is the session's
    // shell-command, so an `-e` placed after `command` would be handed to the engine instead of tmux.
    expect(tmux.stdin()).toBe(tmuxScript([
      'new-session', '-d', '-P', '-F', '#{pane_id}', '-c', '/tmp/work', '-s', 'harness-test',
      '-e', 'ANTHROPIC_BASE_URL=https://relay.example/relay', '-e', 'ANTHROPIC_AUTH_TOKEN=gridkey-abc123',
      '/bin/zsh', '-lic', 'exec "$@"', 'harness-engine', 'claude',
      // Each option names the new session: from `source-file`, an untargeted one went to another session's pane.
      ';', 'set-option', '-p', '-t', '=harness-test:', 'remain-on-exit', 'on', ';', 'set-option', '-t', '=harness-test:', 'destroy-unattached', 'off',
      ';', 'set-option', '-p', '-t', '=harness-test:', 'window-style', 'bg=#181818,fg=#f5f5f5',
      ';', 'set-option', '-p', '-t', '=harness-test:', '@harness_daemon', 'daemon-a',
    ]))
  })

  it.each([
    ['no name', undefined],
    ['a name tmux would read as a window', 'harness:test'],
    ['a name tmux would read as a pane', 'harness.test'],
  ])('refuses a create with variables and %s, asking tmux nothing, rather than set options on a pane it cannot name', async (_, label) => {
    const tmux = scriptTmux()
    const created = await new TmuxBackend().create({ label, env: { K: 'v' }, command: ['claude'] })
    expect(created).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(tmux.calls()).toEqual([])
  })

  it('takes the pane id from the first line, before the ~/.tmux.conf errors a server it started prints on stdin', async () => {
    scriptTmux(`printf '%%7\\n/home/someone/.tmux.conf:1: invalid option: bogus\\n'`)
    expect(await new TmuxBackend().create({ label: 'harness-test', env: { K: 'v' }, command: ['claude'] }))
      .toEqual({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%7' } })
  })

  it('keeps a create with no variables on the command line it always had', async () => {
    const tmux = scriptTmux()
    await new TmuxBackend(undefined, () => 'daemon-a').create({ label: 'harness-test', command: ['claude'] })
    expect(tmux.calls()[0]).toBe('new-session -d -P -F #{pane_id} -s harness-test claude ; set-option -p remain-on-exit on'
      + ' ; set-option destroy-unattached off ; set-option -p window-style bg=#181818,fg=#f5f5f5 ; set-option -p @harness_daemon daemon-a')
    expect(tmux.stdin()).toBe('')
  })

  it('says why tmux refused a create given on stdin', async () => {
    scriptTmux(`printf 'duplicate session: harness-test\\n' >&2; exit 1`)
    const refused = await new TmuxBackend().create({ label: 'harness-test', env: { K: 'v' }, command: ['claude'] })
    expect(refused).toMatchObject({ state: 'unknown', dispatch: 'possibly_executed', reason: 'tmux session creation did not complete: duplicate session: harness-test' })
  })

  it('respawns a pane in place with a new environment, keeping the pane id, with no value on a command line', async () => {
    const tmux = scriptTmux()
    const moved = await new TmuxBackend().respawn({ backend: 'tmux', paneId: '%42' }, {
      cwd: '/tmp/work',
      env: { ANTHROPIC_BASE_URL: 'https://relay.example/relay', ANTHROPIC_AUTH_TOKEN: 'gridkey-abc123' },
      command: ['/bin/zsh', '-lic', 'exec "$@"', 'harness-engine', 'claude', '--resume', 'sess-1'],
    })

    expect(moved).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(tmux.calls()).toEqual(['start-server ; source-file -'])
    // `remain-on-exit` is chained BEFORE the respawn, not after: an engine handed a rejected key can
    // exit before a follow-up call lands, taking its own error message down with it.
    expect(tmux.stdin()).toBe(tmuxScript([
      'set-option', '-p', '-t', '%42', 'remain-on-exit', 'on', ';', 'set-option', '-p', '-t', '%42', '@harness_engine_exit', '',
      ';', 'respawn-pane', '-k', '-c', '/tmp/work',
      '-e', 'ANTHROPIC_BASE_URL=https://relay.example/relay', '-e', 'ANTHROPIC_AUTH_TOKEN=gridkey-abc123',
      '-t', '%42', '/bin/zsh', '-lic', 'exec "$@"', 'harness-engine', 'claude', '--resume', 'sess-1',
    ]))
  })

  it('respawns a waiting pane with its variables on stdin too, and still hears a changed pane', async () => {
    const token = '0b4f6a8e-6d0c-4bd1-9a51-6c1a3b0f2e77'
    const tmux = scriptTmux(`printf 'adoption-mismatch\\n'`)
    const moved = await new TmuxBackend().respawn({ backend: 'tmux', paneId: '%42' }, {
      env: { ANTHROPIC_AUTH_TOKEN: 'gridkey-abc123' }, command: ['claude'], expectedHeldToken: token,
    })
    expect(moved).toMatchObject({ state: 'failed', dispatch: 'not_started', reason: 'The waiting pane changed' })
    expect(tmux.calls()).toEqual(['start-server ; source-file -'])
    // The if-shell's own command list is one word of the script, quoted twice over.
    expect(tmux.stdin()).toContain(tmuxWord(`'respawn-pane' '-k' '-e' 'ANTHROPIC_AUTH_TOKEN=gridkey-abc123' '-t' '%42' 'claude'`).slice(1, -1))
  })

  it('never reports a failed respawn as untouched, because -k already killed the old process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-respawn-fail-'))
    dirs.push(dir)
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf 'no such pane: %%99\\n' >&2
exit 1
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`

    const moved = await new TmuxBackend().respawn({ backend: 'tmux', paneId: '%99' }, { command: ['claude'] })
    expect(moved.state).toBe('unknown')
    expect(moved).toMatchObject({ dispatch: 'possibly_executed' })
    if (moved.state === 'unknown') expect(moved.reason).toContain('no such pane')
  })
})

/** A fake tmux on PATH that records every call, prints [listing] for `list-panes` and `%42` otherwise. */
/**
 * A tmux that records each command line, and what it was given on stdin for `source-file -` (read only then:
 * nothing else writes to a call's stdin, so reading it would wait for ever); then runs [script], or answers
 * as `new-session -P` does.
 */
function scriptTmux(script = `printf '%%42\\n'`): { calls: () => string[]; stdin: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-script-'))
  dirs.push(dir)
  const calls = join(dir, 'calls')
  const stdin = `${calls}.stdin`
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
case "$*" in *'source-file -') cat >> "$TMUX_BACKEND_CALLS.stdin" ;; esac
${script}
`, { mode: 0o700 })
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
  process.env.TMUX_BACKEND_CALLS = calls
  return {
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
    stdin: () => existsSync(stdin) ? readFileSync(stdin, 'utf8') : '',
  }
}

function recordingTmux(listing = '', sessionId = '%42'): () => string[] {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-old-'))
  dirs.push(dir)
  const calls = join(dir, 'calls')
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
case "$1" in
  list-panes) printf '${listing.replace(/%/g, '%%')}' ;;
  display-message) printf '${sessionId.replace(/%/g, '%%')}\\n' ;;
  *) printf '%%42\\n' ;;
esac
`, { mode: 0o700 })
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
  process.env.TMUX_BACKEND_CALLS = calls
  return () => { try { return readFileSync(calls, 'utf8').trim().split('\n') } catch { return [] } }
}

// Debian 10 ships tmux 2.8 and RHEL 8 ships 2.7: no pane options, and tmux checks a whole `;` list before
// it runs any of it. One `set-option -p` chained into `new-session` failed every agent create there.
describe('TmuxBackend on a tmux before 3.0', () => {
  beforeEach(() => assumeTmuxVersion({ major: 2, minor: 8 }))
  const command = ['/bin/zsh', '-lic', 'exec "$@"', 'harness-engine', 'claude']

  it('creates the session with nothing in the list that tmux cannot run, the tag on the window and in the start command', async () => {
    const calls = recordingTmux()
    const created = await new TmuxBackend(undefined, () => 'daemon-a').create({ cwd: '/tmp/work', label: 'harness-test', command })
    expect(created).toEqual({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%42' } })
    expect(calls()[0]).toBe(
      'new-session -d -P -F #{pane_id} -c /tmp/work -s harness-test'
      // The start command goes with the pane wherever the person moves it, where a window option stays.
      + ' /usr/bin/env HARNESS_DAEMON=daemon-a /bin/zsh -lic exec "$@" harness-engine claude'
      + ' ; set-option -w remain-on-exit on ; set-option destroy-unattached off'
      // tmux 2.x keeps a style for each pane: `select-pane -P`, aimed at the pane just made.
      + ' ; select-pane -P bg=#181818,fg=#f5f5f5 ; set-option -w @harness_daemon daemon-a',
    )
    expect(calls()[0]).not.toContain(' -p ')
  })

  it('starts tmux\'s default shell as it is: env with nothing to run would print and exit', async () => {
    const calls = recordingTmux()
    await new TmuxBackend(undefined, () => 'daemon-a').create({ label: 'harness-test' })
    expect(calls()[0]).toMatch(/^new-session -d -P -F #\{pane_id\} -s harness-test ; set-option -w remain-on-exit on/)
  })

  it('respawns with the tag kept in the new start command and the exit mark on the window', async () => {
    const calls = recordingTmux()
    await expect(new TmuxBackend(undefined, () => 'daemon-a').respawn({ backend: 'tmux', paneId: '%9' }, { command: ['claude'] }))
      .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(calls()).toEqual([
      'set-option -w -t %9 remain-on-exit on ; set-option -w -t %9 @harness_engine_exit  ; respawn-pane -k -t %9 /usr/bin/env HARNESS_DAEMON=daemon-a claude',
    ])
  })

  it('re-arms remain-on-exit on the window, the only place it can go', async () => {
    const calls = recordingTmux()
    await new TmuxBackend().holdOpen({ backend: 'tmux', paneId: '%9' })
    expect(calls()).toEqual(['set-option -w -t %9 remain-on-exit on'])
  })

  it('styles each pane with select-pane -P, never its window', async () => {
    const calls = recordingTmux('%9|100|harness-claude-1|/work|daemon-a\\n')
    await new TmuxBackend(undefined, () => 'daemon-a').inventory()
    await settled()
    expect(calls()).toContain('select-pane -t %9 -P bg=#181818,fg=#f5f5f5')
    expect(calls().join('\n')).not.toContain('window-style')
  })

  it('finds its panes by the start command wherever they moved, by the window\'s tag otherwise, never another daemon\'s', async () => {
    const calls = recordingTmux(
      '%1|100|mine-claude|/work/moved|/usr/bin/env HARNESS_DAEMON=daemon-a\\n'
      + '%2|101|harness-codex-2|/work/theirs|/usr/bin/env HARNESS_DAEMON=daemon-b\\n'
      + '%3|102|harness-claude-3|/work/respawned|daemon-a\\n'
      + '%4|103|my-shell|/work/shell|\\n',
    )
    const inventory = await new TmuxBackend(undefined, () => 'daemon-a').inventory()
    expect(inventory.state === 'available' && inventory.roots.map((root) => root.runtime.paneId)).toEqual(['%1', '%3'])
    expect(calls()[0]).toContain('#{?#{m:/usr/bin/env HARNESS_DAEMON=*,#{pane_start_command}},#{=44:pane_start_command},#{?#{m:harness-*,#{session_name}},#{@harness_daemon},}}')
  })
})

describe('handing a pane back to tmux\'s disposal', () => {
  it('cannot turn off a newer owner\'s remain-on-exit after the feature await', async () => {
    const calls = recordingTmux()
    let current = true
    const pending = clearPaneRemainOnExit('%4', () => current)
    current = false
    await pending
    expect(calls()).toEqual([])
  })
  // A window option on an agent the person had moved into a window of their own switched
  // remain-on-exit off for their panes there too.
  it('switches remain-on-exit off on the pane alone where tmux has pane options', async () => {
    assumeTmuxVersion({ major: 3, minor: 0 })
    const calls = recordingTmux()
    await clearPaneRemainOnExit('%9')
    expect(calls()).toEqual(['set-option -p -t %9 remain-on-exit off'])
  })

  it('switches it off on the window before tmux 3.0, the only place it can go', async () => {
    assumeTmuxVersion({ major: 2, minor: 8 })
    const calls = recordingTmux()
    await clearPaneRemainOnExit('%9')
    expect(calls()).toEqual(['set-option -w -t %9 remain-on-exit off'])
  })
})

describe('asking TmuxBackend for a pane\'s root process', () => {
  it('rootProcess maps "can\'t find pane" to missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-root-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf "can't find pane: %%9\\n" >&2\nexit 1\n`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    const backend = new TmuxBackend()
    expect(await backend.rootProcess({ backend: 'tmux', paneId: '%9' })).toBe('missing')
  })
})

describe('TmuxBackend with variables on a tmux that cannot take them', () => {
  const env = { CODEX_HOME: '/work/profile' }

  it('refuses a create below 3.2, saying why, and asks tmux nothing', async () => {
    assumeTmuxVersion({ major: 3, minor: 1 })
    const calls = recordingTmux()
    const created = await new TmuxBackend().create({ label: 'harness-test', env, command: ['codex'] })
    expect(created).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(created.state !== 'succeeded' && created.reason).toContain('older than 3.2')
    expect(calls()).toEqual([])
  })

  // `respawn-pane -e` is 3.0, but its list goes on stdin (`source-file -`, 3.1): on 3.0 the value would be on
  // tmux's command line, so it is refused instead (audit M2).
  it('refuses a respawn below 3.1, saying why, and asks tmux nothing', async () => {
    assumeTmuxVersion({ major: 3, minor: 0 })
    const calls = recordingTmux()
    // Asked before a restart stops anything, with the same answer.
    expect(await new TmuxBackend().respawnRefusal({ env })).toContain('older than 3.1')
    expect(await new TmuxBackend().respawnRefusal({})).toBeNull()
    const moved = await new TmuxBackend().respawn({ backend: 'tmux', paneId: '%9' }, { env, command: ['codex'] })
    expect(moved).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(moved.state !== 'succeeded' && moved.reason).toContain('older than 3.1')
    expect(calls()).toEqual([])
  })

  it('respawns with them from 3.1, on stdin', async () => {
    assumeTmuxVersion({ major: 3, minor: 1 })
    const tmux = scriptTmux()
    await new TmuxBackend(undefined, () => 'daemon-a').respawn({ backend: 'tmux', paneId: '%9' }, { env, command: ['codex'] })
    expect(tmux.calls()).toEqual(['start-server ; source-file -'])
    expect(tmux.stdin()).toBe(tmuxScript(['set-option', '-p', '-t', '%9', 'remain-on-exit', 'on', ';', 'set-option', '-p', '-t', '%9',
      '@harness_engine_exit', '', ';', 'respawn-pane', '-k', '-e', 'CODEX_HOME=/work/profile', '-t', '%9', 'codex']))
  })
})

// The command line is the whole contract here: `set-environment -u` REMOVES a variable, while the
// `-e VAR=` form a respawn takes would set it to an empty string. An engine handed
// ANTHROPIC_BASE_URL="" does not fall back to its own login; it tries to dial the empty string.
describe('clearEnv command shape', () => {
  it('unsets each name against the pane\'s session, never assigning an empty value', () => {
    const args = clearEnvArgs('$3', ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'])
    expect(args).toEqual([
      'set-environment', '-t', '$3', '-u', 'ANTHROPIC_BASE_URL',
      ';',
      'set-environment', '-t', '$3', '-u', 'ANTHROPIC_MODEL',
    ])
    expect(args.join(' ')).not.toContain('=')
  })

  it('asks for nothing when there is nothing to clear', () => {
    expect(clearEnvArgs('$3', [])).toEqual([])
  })
})

// A tmux server copies the environment it was started with into every pane it makes. One started by a core
// before it held harnessd's variables back (lib/harnessdEnv.ts) gave them to every agent and terminal, the
// service token among them (found 2026-10-11: `env` in an agent's pane listed every one).
describe('harnessd\'s variables in the tmux server\'s environment', () => {
  const LISTING = 'HOME=/home/someone\nHARNESSD_SERVICE_TOKEN=fixture-token\n-HARNESSD_RESTARTS\nHARNESSD_SUPERVISED=1\nMY_HARNESSD_NOTE=kept\nHARNESSD_SUPERVISED=1\n'

  it('are the ones the server lists with a value, once each, and none it already removes', () => {
    expect(serverVariables(LISTING, isHarnessdVariable)).toEqual(['HARNESSD_SERVICE_TOKEN', 'HARNESSD_SUPERVISED'])
    expect(serverVariables('', isHarnessdVariable)).toEqual([])
    // A value with a newline in it: what follows is not a name.
    expect(serverVariables('NOTE=one\n two=HARNESSD_X\n', isHarnessdVariable)).toEqual([])
  })

  it('are removed from the global environment in one invocation', () => {
    expect(unsetServerEnvArgs(['HARNESSD_SERVICE_TOKEN', 'HARNESSD_SUPERVISED'])).toEqual([
      'set-environment', '-g', '-u', 'HARNESSD_SERVICE_TOKEN', ';', 'set-environment', '-g', '-u', 'HARNESSD_SUPERVISED',
    ])
  })

  /** A tmux that lists [listing] for the global environment, or answers as one with no server; and records each call. */
  const fakeTmux = (script: string): () => string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-env-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"\n${script}\n`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    return () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
  }

  it('are unset, and named, when the server has them', async () => {
    const calls = fakeTmux(`[ "$1" = show-environment ] && printf '${LISTING.replace(/\n/g, '\\n')}'\nexit 0`)
    await expect(new TmuxBackend().unsetServerEnvironment(isHarnessdVariable)).resolves.toEqual(['HARNESSD_SERVICE_TOKEN', 'HARNESSD_SUPERVISED'])
    expect(calls()).toEqual([
      'show-environment -g',
      'set-environment -g -u HARNESSD_SERVICE_TOKEN ; set-environment -g -u HARNESSD_SUPERVISED',
    ])
  })

  it('cost one call when the server has none, and one when there is no server: the next starts without them', async () => {
    const none = fakeTmux(`[ "$1" = show-environment ] && printf 'HOME=/home/someone\\n'\nexit 0`)
    await expect(new TmuxBackend().unsetServerEnvironment(isHarnessdVariable)).resolves.toEqual([])
    expect(none()).toEqual(['show-environment -g'])
    const noServer = fakeTmux(`echo 'no server running on /tmp/tmux-501/default' >&2\nexit 1`)
    await expect(new TmuxBackend().unsetServerEnvironment(isHarnessdVariable)).resolves.toEqual([])
    expect(noServer()).toEqual(['show-environment -g'])
  })

  it('are named as removed only when tmux removed them', async () => {
    const calls = fakeTmux(`[ "$1" = show-environment ] && { printf 'HARNESSD_SERVICE_TOKEN=fixture-token\\n'; exit 0; }\nexit 1`)
    await expect(new TmuxBackend().unsetServerEnvironment(isHarnessdVariable)).resolves.toEqual([])
    expect(calls()).toEqual(['show-environment -g', 'set-environment -g -u HARNESSD_SERVICE_TOKEN'])
  })

  it.skipIf(!resolveBinaryOnPath('tmux'))('reach no pane a real server makes once they are unset, though the panes before have them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tmux-backend-env-home-'))
    dirs.push(home)
    // The server starts as one an earlier core started did: from an environment with harnessd's variables.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !isHarnessdVariable(name)))
    const tmux = await isolatedTmux({ ...inherited, HOME: home, ZDOTDIR: home, HISTFILE: join(home, 'history'),
      HARNESSD_SERVICE_TOKEN: 'fixture-token', HARNESSD_SUPERVISED: '1', HARNESSD_WATCHDOG_MS: '30000' })
    // The backend's own bare `tmux` reaches this private server and no other.
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    vi.stubEnv('TMUX_TMPDIR', tmux.root)
    const harnessdIn = async (session: string): Promise<string[]> => {
      const file = join(home, `${session}.env`)
      await tmux.run('new-session', '-d', '-s', session, '/bin/sh', '-c', `env > ${file}.tmp && mv ${file}.tmp ${file}; sleep 60`)
      for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 25))
      return readFileSync(file, 'utf8').split('\n').map((line) => line.split('=')[0]).filter(isHarnessdVariable).sort()
    }
    try {
      expect(await harnessdIn('before')).toEqual(['HARNESSD_SERVICE_TOKEN', 'HARNESSD_SUPERVISED', 'HARNESSD_WATCHDOG_MS'])
      await expect(new TmuxBackend().unsetServerEnvironment(isHarnessdVariable)).resolves.toEqual(['HARNESSD_SERVICE_TOKEN', 'HARNESSD_SUPERVISED', 'HARNESSD_WATCHDOG_MS'])
      // The client that asks for a pane still has them: tmux gives a new pane none of the client's own but
      // those `update-environment` names, so the pane has none.
      expect(await harnessdIn('after')).toEqual([])
      // And a second core finds nothing left to remove.
      await expect(new TmuxBackend().unsetServerEnvironment(isHarnessdVariable)).resolves.toEqual([])
    } finally {
      vi.unstubAllEnvs()
      await tmux.close()
    }
  })
})

// What main.ts did for tmux at daemon start, now the backend's own: find tmux, rename the sessions an older
// build named, forget harnessd's variables, and say what the first inventory found — in that order.
describe('readying tmux at daemon start', () => {
  it('prepare reports tmux absent as unavailable, not a throw', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const backend = new TmuxBackend(() => DEFAULT_HOST_THEME, undefined, undefined, undefined, { ensureOnPath: async () => ({ state: 'absent', reason: 'no tmux' }) })
      expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'unavailable', code: 'TMUX_UNAVAILABLE', reason: 'no tmux' })
      expect(error.mock.calls).toEqual([['[tmux] unavailable: no tmux · install tmux and verify `tmux -V`, then restart — agents cannot be created or restored until then']])
    } finally { error.mockRestore() }
  })

  it('prepare adopts tmux, renames legacy sessions, forgets harnessd variables, then logs the first inventory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-prepare-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$1" >> "$TMUX_BACKEND_CALLS"
case "$1" in
  list-panes) printf '%%7|4242|claude-1790000000000|/work|\\n' ;;
  show-environment) printf 'HOME=/home/someone\\nHARNESSD_SERVICE_TOKEN=fixture-token\\nCLAUDECODE=1\\n' ;;
esac
exit 0
`, { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const backend = new TmuxBackend(undefined, () => 'daemon-a', () => {}, undefined,
        { ensureOnPath: async () => ({ state: 'adopted', path: '/opt/tmux/bin/tmux', from: '/opt/tmux/bin' }) })
      expect(await backend.prepare({ ownedPanes: new Map([['%7', 'claude']]) })).toEqual({ state: 'ready' })
      expect(log.mock.calls.map(([line]) => line)).toEqual([
        '[tmux] not on the daemon PATH · adopted /opt/tmux/bin/tmux · /opt/tmux/bin',
        expect.stringMatching(/^\[terminal\] renamed tmux session claude-1790000000000 → harness-claude-\d+-[0-9a-f-]+ \(pane %7\) · named by a build before the harness- prefix$/),
        '[terminal] tmux: removed HARNESSD_SERVICE_TOKEN, CLAUDECODE from the environment new panes start with',
        // The renamed session is still `claude-…` in this fake, so the inventory whitelists none of it.
        '[terminal] tmux: available',
      ])
      const commands = readFileSync(calls, 'utf8').trim().split('\n')
      expect(commands.indexOf('rename-session')).toBeLessThan(commands.indexOf('show-environment'))
      expect(commands.lastIndexOf('list-panes')).toBeGreaterThan(commands.indexOf('set-environment'))
    } finally { log.mockRestore() }
  })

  it('stays ready when the first inventory cannot be read, and says why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-prepare-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const backend = new TmuxBackend(undefined, () => 'daemon-a', () => {}, undefined, { ensureOnPath: async () => ({ state: 'present' }) })
      expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
      expect(log.mock.calls).toEqual([['[terminal] tmux: unavailable (tmux listed no panes)']])
    } finally { log.mockRestore() }
  })

  it('capabilities says whether this tmux can give a new session its own environment', async () => {
    assumeTmuxVersion({ major: 3, minor: 1 })
    expect(await new TmuxBackend().capabilities()).toEqual({ sessionEnv: false })
    assumeTmuxVersion({ major: 3, minor: 2 })
    expect(await new TmuxBackend().capabilities()).toEqual({ sessionEnv: true })
  })
})

// Audit M2 (docs/security/2026-11-02-team-account-boundary.md): every account on a machine reads every process's
// command line, so a list with values goes to tmux on stdin, in tmux's own command syntax.
describe('a tmux command list given on stdin', () => {
  it('quotes each word whole, and keeps `;` the separator it is on a command line', () => {
    expect(tmuxScript(['set-option', '-g', '@x', 'a b', ';', 'display-message', ''])).toBe(`'set-option' '-g' '@x' 'a b' ; 'display-message' ''\n`)
    expect(tmuxWord(`it's`)).toBe(`'it'"'"'s'`)
  })

  it('gives a newline or carriage return as an escape, never raw inside quotes', () => {
    // A raw newline in single quotes lost the next line when it began with `#` (tmux 3.7).
    expect(tmuxWord('a\n# b\r')).toBe(`'a'"\\n"'# b'"\\r"''`)
    expect(tmuxScript(['x\ny'])).not.toMatch(/\n./)
  })
})

describe.skipIf(!resolveBinaryOnPath('tmux'))('session variables on a real tmux server (audit M2)', () => {
  const exec = promisify(execFile)
  const token = `m2-fixture-token-${randomUUID()}`
  // Every character tmux's command syntax treats specially, a line that would read as a comment or a
  // directive, and a non-ASCII one: the engine must get the exact value.
  const tricky = `a'b"c $HOME ~ #{pane_id} ; { } \\ \n# next\n%if 1\r\t✓ ${token}`
  let tmux: IsolatedTmux

  beforeEach(async (context) => {
    // This machine's real tmux, not the newest the specs above assume.
    resetTmuxVersionCache()
    // `new-session -e` is 3.2: older servers are refused before tmux is asked (above).
    if (!(await tmuxFeatures()).sessionEnv) context.skip()
    tmux = await isolatedTmux()
    tmux.env.HOME = tmux.root
    // The backend's own bare `tmux` reaches this private server and no other, with no ~/.tmux.conf.
    vi.stubEnv('HOME', tmux.root)
    vi.stubEnv('ZDOTDIR', tmux.root)
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    vi.stubEnv('TMUX_TMPDIR', tmux.root)
  })

  afterEach(async () => {
    await tmux?.close()
    vi.unstubAllEnvs()
  })

  /**
   * The command lines on this machine, as any other account reads them, that show [value]. Only those: a
   * failure must not print the rest, which may hold other accounts' own secrets.
   */
  const showing = async (value: string): Promise<string[]> =>
    (await exec('ps', ['-A', '-ww', '-o', 'args='], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\n').filter((line) => line.includes(value))

  /** What [file] holds once a pane's command has written it. */
  const written = async (file: string): Promise<string> => {
    await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 10_000 })
    return readFileSync(file, 'utf8')
  }

  it('starts the server with no value in its title, and the engine gets each value exactly', async () => {
    // No server yet: the create starts it, and a server keeps the command line that started it for its life.
    await expect(tmux.run('list-sessions')).rejects.toThrow()
    const out = join(tmux.root, 'env.out')
    const created = await new TmuxBackend(undefined, () => 'daemon-a', () => {}).create({
      label: 'harness-m2-create',
      env: { M2_TOKEN: token, M2_TRICKY: tricky },
      command: ['/bin/sh', '-c', `printf '%s|%s' "$M2_TOKEN" "$M2_TRICKY" > '${out}.tmp' && mv '${out}.tmp' '${out}'; exec sleep 300`],
    })
    expect(created.state).toBe('succeeded')
    expect(await written(out)).toBe(`${token}|${tricky}`)
    expect(await tmux.run('show-environment', '-t', 'harness-m2-create', 'M2_TOKEN')).toBe(`M2_TOKEN=${token}`)
    expect(await showing(token)).toEqual([])
  })

  it('gives its options to the new session, never to another already on the server', async () => {
    // A person's own session, or another daemon's, with its own pane options.
    await tmux.run('new-session', '-d', '-s', 'theirs', '/bin/sleep', '300')
    await tmux.run('set-option', '-p', '-t', '=theirs:', '@harness_daemon', 'someone-else')
    const created = await new TmuxBackend(undefined, () => 'daemon-a', () => {}).create({
      label: 'harness-m2-second', env: { M2_TOKEN: token }, command: ['/bin/sleep', '300'],
    })
    if (created.state !== 'succeeded') throw new Error(created.reason)
    const option = (target: string, name: string, scope = '-p') => tmux.run('show-options', '-v', scope, '-t', target, name)
    expect(await option('=theirs:', '@harness_daemon')).toBe('someone-else')
    expect(await option('=theirs:', 'remain-on-exit')).not.toBe('on')
    expect(await option(created.runtime.paneId, '@harness_daemon')).toBe('daemon-a')
    expect(await option(created.runtime.paneId, 'remain-on-exit')).toBe('on')
    expect(await option('=harness-m2-second:', 'destroy-unattached', '-q')).toBe('off')
    expect(await showing(token)).toEqual([])
  })

  it('starts a server whose ~/.tmux.conf has an error and ends unattached sessions, and the agent stays', async () => {
    writeFileSync(join(tmux.root, '.tmux.conf'), 'set -g fixture-no-such-option on\nset -g destroy-unattached on\n')
    const created = await new TmuxBackend(undefined, () => 'daemon-a', () => {}).create({
      label: 'harness-m2-conf', env: { M2_TOKEN: token }, command: ['/bin/sleep', '300'],
    })
    expect(created).toMatchObject({ state: 'succeeded' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await tmux.run('list-sessions', '-F', '#{session_name}')).toBe('harness-m2-conf')
  })

  it('respawns a pane, and a waiting one, with no value on any command line', async () => {
    const held = randomUUID()
    const created = await new TmuxBackend(undefined, () => 'daemon-a', () => {}).create({
      label: 'harness-m2-respawn', command: ['/bin/sh', '-c', 'exec sleep 300', 'harness-held', held],
    })
    if (created.state !== 'succeeded') throw new Error(created.reason)
    const backend = new TmuxBackend(undefined, () => 'daemon-a', () => {})
    const launch = (out: string) => ['/bin/sh', '-c', `printf '%s' "$M2_TRICKY" > '${out}.tmp' && mv '${out}.tmp' '${out}'; exec sleep 300`]
    // The waiting pane's own check runs inside tmux, and its command list is quoted inside the script.
    const first = join(tmux.root, 'held.out')
    expect(await backend.respawn(created.runtime, { env: { M2_TRICKY: tricky }, command: launch(first), expectedHeldToken: held }))
      .toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(await written(first)).toBe(tricky)
    const second = join(tmux.root, 'plain.out')
    expect(await backend.respawn(created.runtime, { env: { M2_TRICKY: tricky }, command: launch(second) }))
      .toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(await written(second)).toBe(tricky)
    expect(await showing(token)).toEqual([])
  })
})
