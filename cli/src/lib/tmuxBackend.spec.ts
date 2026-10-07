import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecFileException } from 'node:child_process'
import { TmuxBackend, clearEnvArgs } from './tmuxBackend.js'
import { clearPaneRemainOnExit, forgetTmuxServer } from './tmux.js'
import { tmuxControlGate } from './tmuxControlGate.js'
import { assumeTmuxVersion, resetTmuxVersionCache } from './tmuxVersion.js'

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
  return { ...actual, patientExec }
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
  it('hands the session its own environment, before the command it launches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-env-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
printf '%%42\\n'
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls

    const created = await new TmuxBackend(undefined, () => 'daemon-a').create({
      cwd: '/tmp/work',
      label: 'harness-test',
      // A grid relay key. It goes here rather than into `command` precisely so it stays out of the
      // engine's argv, where `ps` would expose it for the life of the agent.
      env: { ANTHROPIC_BASE_URL: 'https://relay.example/relay', ANTHROPIC_AUTH_TOKEN: 'gridkey-abc123' },
      command: ['/bin/zsh', '-lic', 'exec "$@"', 'harness-engine', 'claude'],
    })

    expect(created.state).toBe('succeeded')
    // Order is load-bearing: everything after the first non-flag argument is the session's
    // shell-command, so an `-e` placed after `command` would be handed to the engine instead of tmux.
    expect(readFileSync(calls, 'utf8').trim().split('\n')[0]).toBe(
      'new-session -d -P -F #{pane_id} -c /tmp/work -s harness-test'
      + ' -e ANTHROPIC_BASE_URL=https://relay.example/relay -e ANTHROPIC_AUTH_TOKEN=gridkey-abc123'
      + ' /bin/zsh -lic exec "$@" harness-engine claude ; set-option -p remain-on-exit on'
      + ' ; set-option destroy-unattached off ; set-option -p window-style bg=#181818,fg=#f5f5f5 ; set-option -p @harness_daemon daemon-a',
    )
  })
  it('respawns a pane in place with a new environment, keeping the pane id', async () => {
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

    const moved = await new TmuxBackend().respawn({ backend: 'tmux', paneId: '%42' }, {
      cwd: '/tmp/work',
      env: { ANTHROPIC_BASE_URL: 'https://relay.example/relay', ANTHROPIC_MODEL: 'GLM-4.7-Flash' },
      command: ['/bin/zsh', '-lic', 'exec "$@"', 'harness-engine', 'claude', '--resume', 'sess-1'],
    })

    expect(moved).toEqual({ state: 'succeeded', dispatch: 'executed' })
    // `remain-on-exit` is chained BEFORE the respawn, not after: an engine handed a rejected key can
    // exit before a follow-up call lands, taking its own error message down with it.
    expect(readFileSync(calls, 'utf8').trim()).toBe(
      'set-option -p -t %42 remain-on-exit on ; set-option -p -t %42 @harness_engine_exit  ; respawn-pane -k -c /tmp/work'
      + ' -e ANTHROPIC_BASE_URL=https://relay.example/relay -e ANTHROPIC_MODEL=GLM-4.7-Flash'
      + ' -t %42 /bin/zsh -lic exec "$@" harness-engine claude --resume sess-1',
    )
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
function recordingTmux(listing = ''): () => string[] {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-old-'))
  dirs.push(dir)
  const calls = join(dir, 'calls')
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
case "$1" in
  list-panes) printf '${listing.replace(/%/g, '%%')}' ;;
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

  it('refuses a respawn below 3.0, saying why, and asks tmux nothing', async () => {
    assumeTmuxVersion({ major: 2, minor: 9 })
    const calls = recordingTmux()
    // Asked before a restart stops anything, with the same answer.
    expect(await new TmuxBackend().respawnRefusal({ env })).toContain('older than 3.0')
    expect(await new TmuxBackend().respawnRefusal({})).toBeNull()
    const moved = await new TmuxBackend().respawn({ backend: 'tmux', paneId: '%9' }, { env, command: ['codex'] })
    expect(moved).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(moved.state !== 'succeeded' && moved.reason).toContain('older than 3.0')
    expect(calls()).toEqual([])
  })

  it('respawns with them from 3.0, where respawn-pane takes -e', async () => {
    assumeTmuxVersion({ major: 3, minor: 0 })
    const calls = recordingTmux()
    await new TmuxBackend(undefined, () => 'daemon-a').respawn({ backend: 'tmux', paneId: '%9' }, { env, command: ['codex'] })
    expect(calls()).toEqual(['set-option -p -t %9 remain-on-exit on ; set-option -p -t %9 @harness_engine_exit  ; respawn-pane -k -e CODEX_HOME=/work/profile -t %9 codex'])
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
