import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_FILE, makeRealFolders, readBridge, removeBridge, writeBridge, type BridgeRecord } from '../../homeMove/bridge.js'
import { moveLockPath } from '../../homeMove/lock.js'
import { removePath } from '../removePath.js'
import { labelHookRemoval, lockHolder, UNINSTALL_USAGE, uninstallCommand, UninstallLockBusy, type UninstallDeps } from './command.js'
import { checkRemovable, listEntries, RemovalRefused, removeNow } from './removal.js'

function fake(overrides: Partial<UninstallDeps> = {}) {
  const calls: string[] = []
  const out: string[] = []
  const err: string[] = []
  /** The uninstall marker's writes, each said with the step it came after: their order against the steps is the point. */
  const marks: string[] = []
  const after = (what: string) => marks.push(calls.length ? `${what} after ${calls.at(-1)}` : `${what} first`)
  let running = true
  const deps: UninstallDeps = {
    platform: 'darwin', cwd: '/Users/u/code', roots: ['/Users/u/.harness'], binDir: '/Users/u/.harness/bin', home: '/Users/u',
    cliDir: '/Users/u/.harness/cli', dataDir: '/Users/u/.harness/cli/data', authDir: '/Users/u/.harness/auth',
    isTTY: false, harnessOs: false, pane: null,
    markUninstalling: () => { after('mark') },
    unmarkUninstalling: () => { after('unmark') },
    ask: async () => { calls.push('ask'); return 'n' },
    daemonPid: () => (running ? 4242 : null),
    alive: (pid) => running && pid === 4242,
    stopAgents: async () => { calls.push('agents'); return { stopped: 2, failed: [] } },
    service: { name: 'launchd', present: () => true, unregister: () => { calls.push('service'); return { ok: true } } },
    withLock: async (fn) => { calls.push('lock'); return fn() },
    stopDaemon: async () => { calls.push('stop'); running = false; return { pid: 4242, stopped: true } },
    endPtyHosts: async () => { calls.push('pty'); return [] },
    removeHooks: async () => { calls.push('hooks'); return [{ file: '/Users/u/.claude/settings.json', removed: 5 }] },
    removeLaunchers: () => { calls.push('launchers'); return ['/Users/u/.local/bin/harness', '/Users/u/.local/bin/hn'] },
    removePathEntry: () => { calls.push('path'); return { kind: 'rc', edits: [{ file: '/Users/u/.zshrc', removed: 1, changedByPerson: 0 }], keptFor: [] } },
    listEntries: (dir) => (dir === '/Users/u/.harness' ? [{ name: 'auth', dir: true }, { name: 'cli', dir: true }, { name: 'runtime', dir: true }] : [{ name: 'cli.js', dir: false }, { name: 'data', dir: true }]),
    exists: () => true,
    move: null,
    checkRemovable: () => {},
    removeNow: (plan) => { calls.push(`files ${plan.remove.map((t) => t.path.replace('/Users/u/.harness/', '')).join(',')}${plan.removeRoot ? ' +root' : ''}`); return [] },
    scheduleFinalRemoval: (plan) => { calls.push(`final ${plan.remove.length}${plan.removeRoot ? ' +root' : ''}`); return { ok: true, script: 'C:\\T\\h.cmd', log: 'C:\\T\\h.log' } },
    afterword: () => { calls.push('afterword') },
    out: (line) => { out.push(line) },
    err: (line) => { err.push(line) },
    tildify: (path) => path.replace('/Users/u', '~').replace('C:\\Users\\u', '~'),
    ...overrides,
  }
  return { deps, calls, out, err, marks }
}

/** This computer's Windows layout, as the fakes above see it. */
const win = {
  platform: 'win32' as const, cwd: 'C:\\Users\\u', roots: ['C:\\Users\\u\\.harness'], binDir: 'C:\\Users\\u\\.harness\\bin', home: 'C:\\Users\\u', cliDir: 'C:\\Users\\u\\.harness\\cli',
  dataDir: 'C:\\Users\\u\\.harness\\cli\\data', authDir: 'C:\\Users\\u\\.harness\\auth', service: { name: 'Task Scheduler', present: () => true, unregister: () => ({ ok: true as const }) },
  removePathEntry: () => ({ kind: 'windows' as const, result: { state: 'removed' as const, folder: 'C:\\Users\\u\\.harness\\bin' } }),
  listEntries: (dir: string) => (dir === 'C:\\Users\\u\\.harness' ? [{ name: 'bin', dir: true }, { name: 'cli', dir: true }] : []),
}

describe('harness uninstall', () => {
  it('with --yes: harnesses, service, daemon, terminal host, hooks, launchers, PATH, files, in that order', async () => {
    const t = fake()
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.calls).toEqual(['agents', 'lock', 'service', 'stop', 'pty', 'hooks', 'launchers', 'path', 'files auth,cli,runtime +root', 'afterword'])
    expect(t.out).toContain('✓ stopped 2 harnesses')
    expect(t.out).toContain('✓ removed the Harness daemon from launchd: it no longer starts at login')
    expect(t.out).toContain('✓ removed the PATH line Harness added to ~/.zshrc')
    expect(t.out.at(-1)).toBe('Harness is uninstalled.')
  })

  it('asks first in a terminal, and removes nothing on no', async () => {
    const t = fake({ isTTY: true })
    expect(await uninstallCommand([], t.deps)).toBe(1)
    expect(t.calls).toEqual(['ask'])
    expect(t.out).toContain('  · deletes ~/.harness: your sign-in, this computer\'s identity, history and settings (--keep-data keeps them)')
    expect(t.out.at(-1)).toBe('Nothing was removed.')
    const yes = fake({ isTTY: true, ask: async () => 'y' })
    expect(await uninstallCommand([], yes.deps)).toBe(0)
  })

  it('refuses without a terminal or --yes, an unknown option, and Harness OS', async () => {
    const t = fake()
    expect(await uninstallCommand([], t.deps)).toBe(1)
    expect(t.err).toEqual(['✗ harness uninstall asks before it removes anything. Run it in a terminal, or add --yes. Nothing was removed.'])
    expect(await uninstallCommand(['--force'], fake().deps)).toBe(2)
    const os = fake({ harnessOs: true })
    expect(await uninstallCommand(['--yes'], os.deps)).toBe(1)
    expect(os.calls).toEqual([])
  })

  it('with --keep-data removes the program and keeps the data', async () => {
    const t = fake()
    expect(await uninstallCommand(['--yes', '--keep-data'], t.deps)).toBe(0)
    expect(t.calls).toContain('files runtime,cli/cli.js')
    expect(t.out.at(-1)).toBe('Harness is uninstalled. Your sign-in and history are kept for the next install.')
  })

  it('deletes nothing when the service or the daemon would not go', async () => {
    const service = fake({ service: { name: 'systemd', present: () => true, unregister: () => ({ ok: false, detail: 'systemctl --user disable harnessd.service: exit 1' }) } })
    expect(await uninstallCommand(['--yes'], service.deps)).toBe(1)
    expect(service.calls).toEqual(['agents', 'lock'])
    expect(service.err).toEqual(['✗ systemd would not let go of the Harness daemon (systemctl --user disable harnessd.service: exit 1). None of Harness\'s files were deleted. Try again; if it keeps failing, run `harness service uninstall` to see why.'])
    // schtasks ends its message with a full stop: the sentence does not get two.
    const denied = fake({ service: { name: 'Task Scheduler', present: () => true, unregister: () => ({ ok: false, detail: 'ERROR: Access is denied.' }) } })
    expect(await uninstallCommand(['--yes'], denied.deps)).toBe(1)
    expect(denied.err).toEqual(['✗ Task Scheduler would not let go of the Harness daemon (ERROR: Access is denied). None of Harness\'s files were deleted. Try again; if it keeps failing, run `harness service uninstall` to see why.'])
    const stuck = fake({ stopDaemon: async () => ({ pid: 4242, stopped: true }) })
    expect(await uninstallCommand(['--yes'], stuck.deps)).toBe(1)
    expect(stuck.calls).not.toContain('hooks')
    expect(stuck.err).toEqual(['✗ The Harness daemon (pid 4242) did not stop. None of Harness\'s files were deleted. Run `harness stop`, then `harness uninstall` again.'])
  })

  it('reports what it could not do, and still does the rest', async () => {
    const t = fake({
      stopAgents: async () => ({ stopped: 1, failed: [{ name: 'claude-x', error: 'IDENTITY_UNAVAILABLE' }] }),
      removeHooks: async () => [{ file: '/Users/u/.codex/hooks.json', removed: 0, failed: 'the settings file is read-only' }],
      removePathEntry: () => ({ kind: 'rc', edits: [], keptFor: ['claude', 'uv'] }),
    })
    expect(await uninstallCommand(['-y'], t.deps)).toBe(1)
    expect(t.calls).toContain('files auth,cli,runtime +root')
    expect(t.out).toContain('· kept the PATH line in your shell\'s startup file: ~/.local/bin also holds claude, uv, which need it')
    const one = fake({ removePathEntry: () => ({ kind: 'rc', edits: [], keptFor: ['uv'] }) })
    await uninstallCommand(['-y'], one.deps)
    expect(one.out).toContain('· kept the PATH line in your shell\'s startup file: ~/.local/bin also holds uv, which needs it')
    expect(t.err).toEqual([
      '✗ Harness is uninstalled, except:',
      '  · the harness claude-x did not stop (IDENTITY_UNAVAILABLE), so it may still be running',
      '  · Harness\'s hooks are still in ~/.codex/hooks.json (the settings file is read-only): remove the entries that run notify.mjs',
    ])
  })

  it('on Windows: refuses inside ~\\.harness, and leaves the files to the last step', async () => {
    const inside = fake({ ...win, cwd: 'c:\\users\\u\\.harness\\cli' })
    expect(await uninstallCommand(['--yes'], inside.deps)).toBe(1)
    expect(inside.calls).toEqual([])
    const t = fake({ ...win, cwd: 'C:\\Users\\u' })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.calls).not.toContain('launchers')
    expect(t.calls).toContain('final 2 +root')
    expect(t.out).toContain('✓ removed ~\\.harness\\bin from your PATH')
    expect(t.out).toContain('✓ ~\\.harness goes once this command has exited (anything left is listed in C:\\T\\h.log)')
    // The plan's PATH line, which the question shows before anything is removed.
    const asked = fake({ ...win, isTTY: true })
    expect(await uninstallCommand([], asked.deps)).toBe(1)
    expect(asked.out).toContain('  · removes ~\\.harness\\bin from your PATH')
  })

  // Stopping the harnesses, then the daemon and the terminal host, ends the pane this command runs in, and the command
  // with it: partway, with no summary, and the desktop then starts the daemon again.
  it('refuses inside a Harness terminal, on every OS, before it touches anything', async () => {
    for (const pane of ['%3', 'p1:%3']) {
      for (const platform of [{}, win]) {
        const t = fake({ ...platform, pane, isTTY: true, ask: async () => 'y' })
        expect(await uninstallCommand(['--yes'], t.deps)).toBe(1)
        expect(t.calls).toEqual([])
        expect(t.marks).toEqual([])
        expect(t.err).toEqual(['✗ This terminal is one of Harness\'s, which the uninstall closes before it has finished. Run harness uninstall from a terminal outside Harness.'])
      }
    }
  })

  // The desktop app starts a daemon that has gone quiet (local_cli_discovery.dart `startSupervising`): between the daemon
  // stopping and the files going it would start one again, which then holds the files the removal is taking.
  it('marks the uninstall before it stops anything, and leaves the mark to the step that removes the files last', async () => {
    const t = fake()
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    // removeNow takes the mark itself, after the rest and before the root; the CLI's own removal finds it gone.
    expect(t.marks).toEqual(['mark first', 'unmark after afterword'])
    const windows = fake({ ...win })
    expect(await uninstallCommand(['--yes'], windows.deps)).toBe(0)
    // The cmd.exe that removes the files once this process has exited removes the mark after them.
    expect(windows.marks).toEqual(['mark first'])
    const asked = fake({ isTTY: true })
    asked.deps.ask = async () => { asked.calls.push('ask'); return 'y' }
    await uninstallCommand([], asked.deps)
    expect(asked.marks[0]).toBe('mark after ask')
    const no = fake({ isTTY: true })
    await uninstallCommand([], no.deps)
    expect(no.marks).toEqual([])
  })

  it('takes the mark away on every way out that leaves Harness to start again', async () => {
    const service = fake({ service: { name: 'systemd', present: () => true, unregister: () => ({ ok: false, detail: 'exit 1' }) } })
    expect(await uninstallCommand(['--yes'], service.deps)).toBe(1)
    expect(service.marks).toEqual(['mark first', 'unmark after lock'])
    const busy = fake({ withLock: async () => { throw new UninstallLockBusy('busy', 'Harness is being updated by process 51') } })
    expect(await uninstallCommand(['--yes'], busy.deps)).toBe(1)
    expect(busy.marks).toEqual(['mark first', 'unmark after agents'])
    const unscheduled = fake({ ...win, scheduleFinalRemoval: () => ({ ok: false, reason: 'Windows did not start it.', manual: 'Delete it.', detail: 'WMI' }) })
    expect(await uninstallCommand(['--yes'], unscheduled.deps)).toBe(1)
    expect(unscheduled.marks).toEqual(['mark first', 'unmark after afterword'])
    const thrown = fake({ stopAgents: async () => { throw new Error('boom') }, stopDaemon: async () => { throw new Error('no stop') } })
    expect(await uninstallCommand(['--yes'], thrown.deps)).toBe(1)
    expect(thrown.marks).toEqual(['mark first', 'unmark after service'])
  })

  it('prints its usage', async () => {
    const t = fake()
    expect(await uninstallCommand(['--help'], t.deps)).toBe(0)
    expect(t.out).toEqual([UNINSTALL_USAGE])
  })

  it('uninstalls a half install: no daemon, no task, no terminal host, no cli\\current, only bin\\ and runtime\\', async () => {
    const half = {
      platform: 'win32' as const, cwd: 'C:\\Users\\u', roots: ['C:\\Users\\u\\.harness'], binDir: 'C:\\Users\\u\\.harness\\bin', home: 'C:\\Users\\u',
      cliDir: 'C:\\Users\\u\\.harness\\cli', dataDir: 'C:\\Users\\u\\.harness\\cli\\data', authDir: 'C:\\Users\\u\\.harness\\auth',
      daemonPid: () => null, alive: () => false,
      service: { name: 'Task Scheduler', present: () => false, unregister: () => { throw new Error('there is no task to unregister') } },
      stopDaemon: async () => ({ pid: null, stopped: false }),
      endPtyHosts: async () => [],
      removeHooks: async () => [],
      removePathEntry: () => ({ kind: 'windows' as const, result: { state: 'absent' as const, folder: 'C:\\Users\\u\\.harness\\bin' } }),
      // cli\ is gone with its pointer: only bin\ and runtime\ are left.
      listEntries: (dir: string) => (dir === 'C:\\Users\\u\\.harness' ? [{ name: 'bin', dir: true }, { name: 'runtime', dir: true }] : []),
      exists: () => false,
    }
    let planned: string[] = []
    const t = fake({
      ...half,
      scheduleFinalRemoval: (plan) => { planned = plan.remove.map((target) => target.path.split('\\').at(-1)!); return { ok: true, script: 'C:\\T\\h.cmd', log: 'C:\\T\\h.log' } },
    })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.err).toEqual([])
    // Each step that found nothing said nothing: no harness, task, daemon, terminal host, hook or PATH line.
    expect(t.out).toEqual(['✓ ~\\.harness goes once this command has exited (anything left is listed in C:\\T\\h.log)', 'Harness is uninstalled.'])
    expect(t.calls).toEqual(['lock', 'afterword'])
    expect(planned.sort()).toEqual(['bin', 'runtime'])
    // A daemon that does not answer but whose pid is alive still ends it before anything is deleted (the existing rule).
    const stuck = fake({
      ...half, daemonPid: () => 4242, alive: (pid) => pid === 4242,
      stopAgents: async () => ({ stopped: 0, failed: [], unreachable: 'no answer' }),
      stopDaemon: async () => ({ pid: 4242, stopped: false }),
    })
    expect(await uninstallCommand(['--yes'], stuck.deps)).toBe(1)
    expect(stuck.calls.some((call) => call.startsWith('final'))).toBe(false)
    expect(stuck.err).toEqual(['✗ The Harness daemon (pid 4242) did not stop. None of Harness\'s files were deleted. Run `harness stop`, then `harness uninstall` again.'])
  })

  // The B5.9 carries: what the summary must say so that a person can trust it.

  it('names the daemon the service stopped as it was taken out of it', async () => {
    let running = true
    const t = fake({
      daemonPid: () => (running ? 4242 : null), alive: (pid) => running && pid === 4242,
      service: { name: 'launchd', present: () => true, unregister: () => { running = false; return { ok: true } } },
      stopDaemon: async () => ({ pid: null, stopped: false }),
    })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.out).toContain('✓ stopped the Harness daemon (pid 4242)')
    // A pid file whose pid the stop proved another process's (Windows hands freed pids out again) is not a daemon left running.
    const reused = fake({ daemonPid: () => 4242, alive: (pid) => pid === 4242, stopDaemon: async () => ({ pid: null, stopped: false }) })
    expect(await uninstallCommand(['--yes'], reused.deps)).toBe(0)
    expect(reused.out).not.toContain('✓ stopped the Harness daemon (pid 4242)')
  })

  it('deletes nothing while another Harness command holds the daemon', async () => {
    const t = fake({ withLock: async () => { throw new UninstallLockBusy('busy', lockHolder({ pid: 51, purpose: 'update', since: 1_000 }, 5_200)) } })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(1)
    expect(t.calls).toEqual(['agents'])
    expect(t.err).toEqual(['✗ Another Harness command is using the Harness daemon (Harness is being updated by process 51, for 4 seconds). None of Harness\'s files were deleted. Try again in a moment.'])
    expect(lockHolder({ pid: 7, purpose: 'start', since: 0 }, 1_000)).toBe('Harness is being started by process 7, for 1 second')
    // Something at the lock's path that this CLI did not make: no other command is the cause, and none will release it.
    const foreign = fake({ withLock: async () => { throw new UninstallLockBusy('foreign', 'not a lock this CLI made: /Users/u/.harness/cli/data/spawn.lock — remove it by hand (EEXIST)') } })
    expect(await uninstallCommand(['--yes'], foreign.deps)).toBe(1)
    expect(foreign.err).toEqual(['✗ Harness found something it did not make where it keeps its daemon lock (not a lock this CLI made: /Users/u/.harness/cli/data/spawn.lock — remove it by hand (EEXIST)). None of Harness\'s files were deleted.'])
    // Anything else that went wrong stopping it is said as a stop that failed.
    const broken = fake({ stopDaemon: async () => { throw new Error('EPERM') } })
    expect(await uninstallCommand(['--yes'], broken.deps)).toBe(1)
    expect(broken.err).toEqual(['✗ Harness could not stop the Harness daemon (EPERM). None of Harness\'s files were deleted. Run `harness stop`, then `harness uninstall` again.'])
  })

  it('lists a daemon it could not ask to stop the harnesses', async () => {
    const t = fake({ stopAgents: async () => ({ stopped: 0, failed: [], unreachable: 'it refused to list them: BUSY' }) })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(1)
    expect(t.err).toEqual(['✗ Harness is uninstalled, except:', '  · Harness could not ask the Harness daemon to stop the harnesses (it refused to list them: BUSY), so some harnesses may still be running'])
  })

  it('a terminal host it could not end, a launcher it could not remove, and a PATH note', async () => {
    const t = fake({
      endPtyHosts: async () => [{ pid: 77, protocol: 4, panes: 0, how: 'left', detail: 'it would not shut down (busy)' }, { pid: 78, protocol: 3, panes: 2, how: 'shut down' }],
      removeLaunchers: () => ['/Users/u/.local/bin/harness', { path: '/Users/u/.local/bin/hn', failed: 'EACCES' }],
    })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(1)
    expect(t.out).toContain('✓ ended 2 terminals in the Harness terminal host')
    expect(t.out).toContain('✓ removed ~/.local/bin/harness')
    expect(t.err).toEqual([
      '✗ Harness is uninstalled, except:',
      '  · the Harness terminal host is still running (pid 77: it would not shut down (busy)), so some terminals may still be open',
      '  · could not remove ~/.local/bin/hn (EACCES): delete it yourself',
    ])
    const note = fake({ ...win, removePathEntry: () => ({ kind: 'windows', result: { state: 'removed', folder: 'C:\\Users\\u\\.harness\\bin', note: 'Could not announce the PATH change; terminals opened before you sign in again may still have it.' } }) })
    expect(await uninstallCommand(['--yes'], note.deps)).toBe(0)
    expect(note.out).toContain('· Could not announce the PATH change; terminals opened before you sign in again may still have it.')
    const failed = fake({ ...win, removePathEntry: () => ({ kind: 'windows', result: { state: 'failed', folder: 'C:\\Users\\u\\.harness\\bin', detail: 'could not read your PATH (exit 1)' } }) })
    expect(await uninstallCommand(['--yes'], failed.deps)).toBe(1)
    expect(failed.err).toContain('  · Harness could not take ~\\.harness\\bin off your PATH (could not read your PATH (exit 1)): remove it yourself in "Edit environment variables for your account"')
  })

  it('lists every hook file it left, in words for each kind, and says once that Codex may ask again', async () => {
    const t = fake({
      removeHooks: async () => [
        { file: '/Users/u/.codex/hooks.json', removed: 3, kind: 'settings', codex: true },
        { file: '/Users/u/.codex/config.toml', removed: 2, kind: 'reviews' },
        { file: '/Users/u/.codex/rules/harness.rules', removed: 1, kind: 'file' },
        { file: '/Users/u/work/.codex/hooks.json', removed: 3, kind: 'settings', codex: true },
        { file: '/Users/u/.config/opencode/plugin/harness.ts', removed: 0, kept: 'another author’s file', kind: 'file' },
        { file: '/Users/u/.pi/agent/extensions/harness.ts', removed: 0, failed: 'the plugin entry is an alias', kind: 'file' },
        { file: '/Users/u/.grok/hooks/harness.json', removed: 0, failed: 'the plugin entry is an alias', kind: 'settings' },
        { file: '/Users/u/work/.codex/config.toml', removed: 0, failed: 'the hook review configuration is not complete TOML', kind: 'reviews' },
        { file: 'the homes Harness adopted', removed: 0, failed: 'EACCES', kind: 'adopted' },
      ],
    })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(1)
    expect(t.out).toEqual(expect.arrayContaining([
      '✓ removed Harness\'s hooks from ~/.codex/hooks.json',
      '✓ removed Codex\'s record of Harness\'s hooks from ~/.codex/config.toml',
      '✓ removed ~/.codex/rules/harness.rules',
      '· kept ~/.config/opencode/plugin/harness.ts: it is another author’s file',
      '· left Codex\'s record of Harness\'s hooks in ~/work/.codex/config.toml (the hook review configuration is not complete TOML): it does nothing once the hooks are gone',
    ]))
    expect(t.out.filter((line) => line.includes('Codex may ask'))).toEqual([
      '· Codex may ask you to review your own hooks again: it remembers the hooks you reviewed by their place in ~/.codex/hooks.json, and taking Harness\'s out moved them',
    ])
    expect(t.err).toEqual([
      '✗ Harness is uninstalled, except:',
      '  · ~/.pi/agent/extensions/harness.ts is still there (the file is a link): remove it by hand',
      '  · Harness\'s hooks are still in ~/.grok/hooks/harness.json (the file is a link): remove it by hand',
      '  · could not read which other folders Claude Code and Codex were moved to (EACCES), so Harness\'s hooks were removed from their usual folders only',
    ])
  })

  it('does not say a person\'s own permission rules are untouched', async () => {
    const t = fake({ isTTY: true })
    await uninstallCommand([], t.deps)
    expect(t.out).toContain('  · removes the hooks and permission rules Harness added to Claude Code, Codex and your other agents (a rule of yours that is the same as one of Harness\'s goes too)')
  })

  it('says what stayed in ~/.harness when it is not removed whole', async () => {
    const desktop = fake({ listEntries: (dir) => (dir === '/Users/u/.harness' ? [{ name: 'cli', dir: true }, { name: 'desktop-app-v2', dir: true }] : []) })
    expect(await uninstallCommand(['--yes'], desktop.deps)).toBe(0)
    expect(desktop.calls).toContain('files cli')
    expect(desktop.out).toContain('✓ removed everything in ~/.harness except desktop-app-v2')
    expect(desktop.out).not.toContain('✓ removed ~/.harness')
    expect(desktop.out).toContain('· kept the Harness desktop app\'s own settings in ~/.harness: the app sets Harness up again when it starts. Remove the app to remove them.')
    // Something that arrived since the plan (a .DS_Store) keeps the root.
    const busy = fake({ removeNow: () => ['/Users/u/.harness'] })
    expect(await uninstallCommand(['--yes'], busy.deps)).toBe(1)
    expect(busy.out).not.toContain('✓ removed ~/.harness')
    expect(busy.err).toEqual(['✗ Harness is uninstalled, except:', '  · ~/.harness is still there: something was added to it during the uninstall. Look in it, then delete it yourself'])
    const partly = fake({ removeNow: () => ['/Users/u/.harness/runtime', '/Users/u/.harness'] })
    expect(await uninstallCommand(['--yes'], partly.deps)).toBe(1)
    expect(partly.err).toEqual(['✗ Harness is uninstalled, except:', '  · could not remove ~/.harness/runtime: delete it yourself', '  · ~/.harness is still there, with what could not be removed in it'])
  })

  it('removes and schedules nothing when there is nothing to remove, and prints no empty line for it', async () => {
    const t = fake({ ...win, listEntries: (dir: string) => (dir === 'C:\\Users\\u\\.harness' ? [{ name: 'auth', dir: true }] : []) })
    expect(await uninstallCommand(['--yes', '--keep-data'], t.deps)).toBe(0)
    expect(t.calls.some((call) => call.startsWith('final'))).toBe(false)
    expect(t.out.some((line) => line.includes('goes once'))).toBe(false)
    const gone = fake({ listEntries: () => [], exists: () => false })
    expect(await uninstallCommand(['--yes'], gone.deps)).toBe(0)
    expect(gone.calls.some((call) => call.startsWith('files'))).toBe(false)
    expect(gone.out.some((line) => line.startsWith('✓ removed ~/.harness'))).toBe(false)
  })

  it('a plan it refuses deletes nothing, and it does not say Harness is uninstalled', async () => {
    const refused = new RemovalRefused('Harness will not remove "/Users/u/.harness": your home folder is inside it.')
    for (const deps of [
      fake({ removeNow: () => { throw refused } }),
      fake({ ...win, scheduleFinalRemoval: () => { throw refused } }),
    ]) {
      expect(await uninstallCommand(['--yes'], deps.deps)).toBe(1)
      expect(deps.err[0]).toBe('✗ Harness is only partly uninstalled:')
      expect(deps.err.at(-1)).toMatch(/^ {2}· Harness will not remove "[^"]+": .+\. None of its files were deleted$/)
      expect(deps.out.some((line) => line.startsWith('Harness is uninstalled'))).toBe(false)
    }
  })

  it('on Windows, a last step that did not start says why and what to do, and the uninstall is not done', async () => {
    const t = fake({
      ...win,
      scheduleFinalRemoval: () => ({
        ok: false, reason: 'Windows did not start the step that removes Harness\'s files once this command has ended.',
        manual: 'When this command has finished, delete these yourself:\n  C:\\Users\\u\\.harness\\bin\n  C:\\Users\\u\\.harness\\cli', detail: 'Win32_Process.Create returned 2',
      }),
    })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(1)
    expect(t.out.some((line) => line.startsWith('Harness is uninstalled') || line.includes('goes once'))).toBe(false)
    expect(t.err).toEqual([
      '✗ Harness is only partly uninstalled:',
      '  · Windows did not start the step that removes Harness\'s files once this command has ended. (Win32_Process.Create returned 2) When this command has finished, delete these yourself:\n      C:\\Users\\u\\.harness\\bin\n      C:\\Users\\u\\.harness\\cli',
    ])
  })

  // Data and state may get roots of their own (config/harnessHome.ts): the uninstall covers each, and checks all first.
  it('with two roots, every step runs for each', async () => {
    const roots = ['/Users/u/.harness', '/Users/u/state/.harness']
    const listEntries = (dir: string) => (dir === roots[0] ? [{ name: 'auth', dir: true }, { name: 'cli', dir: true }] : dir === roots[1] ? [{ name: 'logs', dir: true }, { name: 'runtime', dir: true }] : [])
    const t = fake({ roots, listEntries, dataDir: '/Users/u/state/.harness/data' })
    t.deps.checkRemovable = (plan) => { t.calls.push(`check ${plan.root}`) }
    t.deps.removeNow = (plan) => { t.calls.push(`files ${plan.root}`); return [] }
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.calls).toEqual([`check ${roots[0]}`, `check ${roots[1]}`, 'agents', 'lock', 'service', 'stop', 'pty', 'hooks', 'launchers', 'path', `files ${roots[0]}`, `files ${roots[1]}`, 'afterword'])
    expect(t.out).toContain('✓ removed ~/.harness')
    expect(t.out).toContain('✓ removed ~/state/.harness')
    // The data folder is in the second root: not a folder left outside Harness's.
    expect(t.out.some((line) => line.startsWith('· left'))).toBe(false)
    // The second root's refusal comes before anything is stopped or removed, the first root's files included.
    const refused = fake({
      roots, listEntries,
      checkRemovable: (plan) => { if (plan.root === roots[1]) throw new RemovalRefused(`Harness will not remove "${roots[1]}": it is a link to another folder.`) },
    })
    expect(await uninstallCommand(['--yes'], refused.deps)).toBe(1)
    expect(refused.calls).toEqual([])
    expect(refused.err).toEqual(['✗ Harness will not remove "~/state/.harness": it is a link to another folder. Nothing was removed. Remove the link yourself, and the folder it points to if it is Harness\'s.'])
    const inState = fake({ ...win, roots: ['C:\\Users\\u\\.harness', 'C:\\Users\\u\\state\\.harness'], cwd: 'C:\\Users\\u\\state\\.harness\\logs' })
    expect(await uninstallCommand(['--yes'], inState.deps)).toBe(1)
    expect(inState.calls).toEqual([])
    expect(inState.err[0]).toMatch(/^✗ This terminal is in ~\\state\\\.harness\\logs, which the uninstall removes/)
  })
})

describe('harness uninstall, review round 1', () => {
  it('refuses a root it would not remove before it asks, stops or removes anything', async () => {
    const link = new RemovalRefused('Harness will not remove "/Users/u/.harness": it is a link to another folder.')
    const t = fake({ isTTY: true, checkRemovable: () => { throw link } })
    expect(await uninstallCommand([], t.deps)).toBe(1)
    expect(t.calls).toEqual([])
    expect(t.out).toEqual([])
    expect(t.err).toEqual(['✗ Harness will not remove "~/.harness": it is a link to another folder. Nothing was removed. Remove the link yourself, and the folder it points to if it is Harness\'s.'])
    // The plan itself refused (a root that is not a .harness folder) is refused the same way, as early.
    const odd = fake({ roots: ['/Users/u/harness'] })
    expect(await uninstallCommand(['--yes'], odd.deps)).toBe(1)
    expect(odd.calls).toEqual([])
    expect(odd.err).toEqual(['✗ Harness will not remove "~/harness": it is not a folder named .harness. Nothing was removed.'])
  })

  it('an error before the first step says nothing was removed', async () => {
    for (const broken of [
      fake({ listEntries: () => { throw new Error('EACCES: permission denied, scandir') } }),
      fake({ checkRemovable: () => { throw new Error('EBUSY') } }),
      fake({ isTTY: true, ask: async () => { throw new Error('stdin closed') } }),
    ]) {
      expect(await uninstallCommand([], broken.deps)).toBe(1)
      expect(broken.calls.filter((call) => call !== 'ask')).toEqual([])
      expect(broken.err).toHaveLength(1)
      expect(broken.err[0]).toMatch(/^✗ harness uninstall could not start \(.+\)\. Nothing was removed\.$/)
    }
    // A stop of the harnesses that throws is a daemon that did not answer, not a crash half way.
    const agents = fake({ stopAgents: async () => { throw new Error('socket hang up') } })
    expect(await uninstallCommand(['--yes'], agents.deps)).toBe(1)
    expect(agents.err).toContain('  · Harness could not ask the Harness daemon to stop the harnesses (socket hang up), so some harnesses may still be running')
  })

  it('a pid file naming another live process: no daemon answered, none was stopped, and nothing went wrong', async () => {
    const t = fake({
      isTTY: true, ask: async () => 'y',
      daemonPid: () => 4242, alive: (pid) => pid === 4242, service: { name: 'launchd', present: () => false, unregister: () => ({ ok: true }) },
      stopAgents: async () => ({ stopped: 0, failed: [], unreachable: 'connect ECONNREFUSED 127.0.0.1:18473' }),
      stopDaemon: async () => ({ pid: null, stopped: false }),
    })
    expect(await uninstallCommand([], t.deps)).toBe(0)
    expect(t.err).toEqual([])
    expect(t.out.some((line) => line.includes('4242'))).toBe(false)
    expect(t.out.at(-1)).toBe('Harness is uninstalled.')
  })

  it('an error nobody expected after the daemon stopped is one more problem, and the rest still runs', async () => {
    const t = fake({ removeHooks: async () => { throw new Error('EMFILE: too many open files') } })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(1)
    expect(t.calls).toEqual(['agents', 'lock', 'service', 'stop', 'pty', 'launchers', 'path', 'files auth,cli,runtime +root', 'afterword'])
    expect(t.out).toContain('✓ removed ~/.harness')
    expect(t.err).toEqual(['✗ Harness is uninstalled, except:', '  · Harness could not remove its hooks from your agents\' settings (EMFILE: too many open files), so your agents may still try to reach Harness'])
    const files = fake({ removeNow: () => { throw new Error('EIO') } })
    expect(await uninstallCommand(['--yes'], files.deps)).toBe(1)
    expect(files.err).toEqual(['✗ Harness is only partly uninstalled:', '  · Harness could not remove its files in ~/.harness (EIO): delete ~/.harness yourself once this command has finished'])
  })

  it('says, with --yes too, that a rule of the person\'s that was the same as Harness\'s went from Claude Code\'s settings', async () => {
    const t = fake({ removeHooks: async () => [{ file: '/Users/u/.claude/settings.json', removed: 5, kind: 'settings', claude: true }] })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.out).toContain('· if you had added a permission rule in ~/.claude/settings.json that is the same as one of Harness\'s, it went too: add it again if you need it')
    expect(fake().out.some((line) => line.includes('permission rule'))).toBe(false)
  })
})

/** Linux's two roots once Harness moved there (config/harnessHome.ts), as the fakes above see them. */
const DATA = '/home/u/.local/share/harness'
const STATE = '/home/u/.local/state/harness'
const linux = {
  platform: 'linux' as const, cwd: '/home/u/code', home: '/home/u', binDir: `${DATA}/bin`,
  service: { name: 'systemd', present: () => true, unregister: () => ({ ok: true as const }) },
  removeHooks: async () => [{ file: '/home/u/.claude/settings.json', removed: 5 }],
  removeLaunchers: () => ['/home/u/.local/bin/harness', '/home/u/.local/bin/hn'],
  removePathEntry: () => ({ kind: 'rc' as const, edits: [{ file: '/home/u/.bashrc', removed: 1, changedByPerson: 0 }], keptFor: [] }),
  move: { lock: '/home/u/.harness.move-lock', readBridge: () => null, removeBridge: () => 'removed' as const, remove: () => {} },
  tildify: (path: string) => path.replace('/home/u', '~'),
}
const xdg = {
  ...linux, roots: [DATA, STATE], cliDir: `${DATA}/cli`, dataDir: `${DATA}/cli/data`, authDir: `${DATA}/auth`,
  listEntries: (dir: string) => (dir === DATA ? [{ name: 'auth', dir: true }, { name: 'bin', dir: true }, { name: 'cli', dir: true }]
    : dir === STATE ? [{ name: 'logs', dir: true }, { name: 'runtime', dir: true }] : [{ name: 'cli.js', dir: false }, { name: 'data', dir: true }]),
}
/** A Linux home that has not moved: ~/.harness, as on macOS. */
const legacyLinux = {
  ...linux, roots: ['/home/u/.harness'], binDir: '/home/u/.harness/bin', cliDir: '/home/u/.harness/cli', dataDir: '/home/u/.harness/cli/data', authDir: '/home/u/.harness/auth',
  listEntries: (dir: string) => (dir === '/home/u/.harness' ? [{ name: 'auth', dir: true }, { name: 'cli', dir: true }, { name: 'runtime', dir: true }] : [{ name: 'cli.js', dir: false }, { name: 'data', dir: true }]),
}

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

/**
 * A Linux home Harness moved to its two XDG folders, on disk: the program and the person's data in them, the data root's
 * marker; the bridge at ~/.harness, a link per entry and its two real folders (connections with a hard link to the shim);
 * the bridge's record, the move's own, and the lock a start left beside ~/.harness.
 */
function movedHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'uninstall-')))
  homes.push(home)
  const oldHome = join(home, '.harness'), data = join(home, '.local', 'share', 'harness'), state = join(home, '.local', 'state', 'harness')
  const kept: Record<string, string> = {
    [join(data, 'auth', 'session.json')]: 'signed in', [join(data, 'cli', 'data', 'registry.json')]: '[]',
    [join(data, 'connections', 'mcp-shim.mjs')]: 'shim', [join(state, 'logs', 'harness.log')]: 'started', [join(data, '.harness-root')]: '1\n',
  }
  const program = [join(data, 'bin', 'harness'), join(data, 'cli', 'cli.js'), join(state, 'runtime', 'current-node')]
  const written = { ...kept, ...Object.fromEntries(program.map((path) => [path, 'program'])), [join(state, 'home-move.json')]: '{}', [join(moveLockPath(oldHome), 'owner')]: '{}' }
  for (const [path, text] of Object.entries(written)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  mkdirSync(oldHome)
  for (const [name, root] of [['auth', data], ['bin', data], ['cli', data], ['connections', data], ['logs', state], ['runtime', state]]) symlinkSync(join(root, name), join(oldHome, name))
  makeRealFolders(oldHome)
  linkSync(join(data, 'connections', 'mcp-shim.mjs'), join(oldHome, 'connections', 'mcp-shim.mjs'))
  writeFileSync(join(oldHome, 'hook-routes', 'route.json'), '{}')
  writeBridge(state, { version: 1, movedAt: 1, oldHome, oldDataDir: join(oldHome, 'cli', 'data'), oldTag: '0'.repeat(16), newTag: '1'.repeat(16), panes: [] })
  return { home, oldHome, data, state, kept, program }
}

/** This computer's removal (deps.ts) on [home]'s disk, with Linux's paths wherever the suite runs. */
const onDisk = (home: string, roots: string[], lock: string) => ({
  ...linux, home, cwd: home, roots, binDir: join(roots[0], 'bin'), cliDir: join(roots[0], 'cli'), dataDir: join(roots[0], 'cli', 'data'), authDir: join(roots[0], 'auth'),
  listEntries, exists: existsSync,
  checkRemovable: (plan: Parameters<UninstallDeps['checkRemovable']>[0]) => { checkRemovable(plan, { platform: 'linux', home }) },
  removeNow: (plan: Parameters<UninstallDeps['removeNow']>[0]) => removeNow(plan, { platform: 'linux', home }),
  move: { lock, readBridge, removeBridge: (bridge: BridgeRecord, state: string) => removeBridge(bridge, state, null), remove: removePath },
  tildify: (path: string) => path.replace(home, '~'),
})
const movedDisk = (m: ReturnType<typeof movedHome>) => onDisk(m.home, [m.data, m.state], moveLockPath(m.oldHome))

// Linux moves Harness from ~/.harness to two XDG folders, and leaves a bridge at ~/.harness while old processes run.
describe('harness uninstall on Linux\'s two roots', () => {
  // Links are Linux's here: on Windows a standard user cannot make one.
  it.runIf(process.platform !== 'win32')('it removes the bridge without following a link', async () => {
    const m = movedHome()
    const t = fake(movedDisk(m))
    expect(await uninstallCommand(['--yes', '--keep-data'], t.deps)).toBe(0)
    expect(existsSync(m.oldHome)).toBe(false)
    // What the links pointed to is whole, the shim the real connections folder linked to too, and the data root's marker
    // with the data it keeps; both roots' program is gone.
    for (const [path, text] of Object.entries(m.kept)) expect(readFileSync(path, 'utf8'), path).toBe(text)
    for (const path of m.program) expect(existsSync(path), path).toBe(false)
    expect(t.out).toContain('✓ removed ~/.harness, which held only links')
    expect(t.err).toEqual([])
    // A file of the person's in it stays, with the folder, and is said.
    const mine = movedHome()
    writeFileSync(join(mine.oldHome, 'notes.txt'), 'mine')
    const left = fake(movedDisk(mine))
    expect(await uninstallCommand(['--yes'], left.deps)).toBe(1)
    expect(readdirSync(mine.oldHome)).toEqual(['notes.txt'])
    // The data root goes whole, its marker with it.
    expect(existsSync(mine.data) || existsSync(mine.state)).toBe(false)
    expect(left.err).toEqual(['✗ Harness is uninstalled, except:', '  · ~/.harness is still there: something in it is not Harness\'s. Look in it, then delete it yourself'])
  })

  it.runIf(process.platform !== 'win32')('it removes the move lock and both records', async () => {
    for (const keepData of [false, true]) {
      const m = movedHome()
      expect(await uninstallCommand(['--yes', ...(keepData ? ['--keep-data'] : [])], fake(movedDisk(m)).deps)).toBe(0)
      for (const path of [moveLockPath(m.oldHome), join(m.state, BRIDGE_FILE), join(m.state, 'home-move.json')]) expect(existsSync(path), `${path}, --keep-data ${keepData}`).toBe(false)
    }
    // A home that has not moved: the record a waiting move left in ~/.harness, and the lock a start left beside it.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'uninstall-')))
    homes.push(home)
    const root = join(home, '.harness'), lock = moveLockPath(root)
    for (const path of [join(root, 'auth', 'session.json'), join(root, 'cli', 'cli.js'), join(root, 'home-move.json'), join(lock, 'owner')]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '{}')
    }
    const t = fake(onDisk(home, [root], lock))
    expect(await uninstallCommand(['--yes', '--keep-data'], t.deps)).toBe(0)
    expect([existsSync(join(root, 'home-move.json')), existsSync(lock), existsSync(join(root, 'cli', 'cli.js'))]).toEqual([false, false, false])
    expect(readFileSync(join(root, 'auth', 'session.json'), 'utf8')).toBe('{}')
    expect(t.out.at(-1)).toBe('Harness is uninstalled. Your sign-in and history are kept for the next install.')
  })

  // Only ~/.harness is the move's: a record naming any other folder would have the uninstall empty it.
  it.runIf(process.platform !== 'win32')('a bridge.json that names a folder other than ~/.harness is refused: nothing in that folder is removed, and that is said', async () => {
    const m = movedHome()
    const other = join(m.home, 'projects')
    for (const name of ['connections', 'hook-routes']) {
      mkdirSync(join(other, name), { recursive: true })
      writeFileSync(join(other, name, 'mine.txt'), 'mine')
    }
    symlinkSync(join(m.home, 'code'), join(other, 'code'))
    writeBridge(m.state, { ...readBridge(m.state)!, oldHome: other, oldDataDir: join(other, 'cli', 'data') })
    const t = fake(movedDisk(m))
    expect(await uninstallCommand(['--yes', '--keep-data'], t.deps)).toBe(1)
    expect(readdirSync(other).sort()).toEqual(['code', 'connections', 'hook-routes'])
    for (const name of ['connections', 'hook-routes']) expect(readFileSync(join(other, name, 'mine.txt'), 'utf8')).toBe('mine')
    expect(t.err).toEqual(['✗ Harness is uninstalled, except:', '  · ~/.local/state/harness/bridge.json names a folder other than ~/.harness: nothing in that folder was removed'])
    // The record itself goes, with the move's own.
    expect(existsSync(join(m.state, BRIDGE_FILE))).toBe(false)
  })

  it('its lines name both folders', async () => {
    const asked = fake({ ...xdg, isTTY: true })
    expect(await uninstallCommand([], asked.deps)).toBe(1)
    expect(asked.out).toContain('  · deletes ~/.local/share/harness and ~/.local/state/harness: your sign-in, this computer\'s identity, history and settings (--keep-data keeps them)')
    const askedKeep = fake({ ...xdg, isTTY: true })
    expect(await uninstallCommand(['--keep-data'], askedKeep.deps)).toBe(1)
    expect(askedKeep.out).toContain('  · deletes the program in ~/.local/share/harness and ~/.local/state/harness, and keeps your sign-in, this computer\'s identity, history and settings there')
    const t = fake({ ...xdg })
    expect(await uninstallCommand(['--yes'], t.deps)).toBe(0)
    expect(t.out).toEqual(expect.arrayContaining(['✓ removed ~/.local/share/harness', '✓ removed ~/.local/state/harness']))
    const kept = fake({ ...xdg })
    expect(await uninstallCommand(['--yes', '--keep-data'], kept.deps)).toBe(0)
    expect(kept.out).toEqual(expect.arrayContaining(['✓ removed the program from ~/.local/share/harness', '✓ removed the program from ~/.local/state/harness']))
    // A data folder ADAPTER_DATA_DIR puts outside both.
    const outside = fake({ ...xdg, dataDir: '/srv/data' })
    expect(await uninstallCommand(['--yes'], outside.deps)).toBe(0)
    expect(outside.out).toContain('· left /srv/data: it is outside ~/.local/share/harness and ~/.local/state/harness (ADAPTER_DATA_DIR or HARNESS_AUTH_DIR names it); delete it yourself if it is Harness\'s')
  })

  it('with one root every line is today\'s', async () => {
    const asked = (service: string, path: string, root: string, keepData: boolean) => [
      'harness uninstall removes Harness from this computer:',
      '  · stops every harness running here, then the Harness daemon',
      `  · takes the Harness daemon out of ${service}, so it no longer starts at login`,
      '  · removes the hooks and permission rules Harness added to Claude Code, Codex and your other agents (a rule of yours that is the same as one of Harness\'s goes too)',
      path,
      keepData
        ? `  · deletes the program in ${root}, and keeps your sign-in, this computer's identity, history and settings there`
        : `  · deletes ${root}: your sign-in, this computer's identity, history and settings (--keep-data keeps them)`,
      '',
      '✓ stopped 2 harnesses',
      `✓ removed the Harness daemon from ${service}: it no longer starts at login`,
      '✓ stopped the Harness daemon (pid 4242)',
      '✓ removed Harness\'s hooks from ~/.claude/settings.json',
    ]
    const done = (keepData: boolean) => (keepData ? 'Harness is uninstalled. Your sign-in and history are kept for the next install.' : 'Harness is uninstalled.')
    const posixLines = (service: string, rc: string) => (keepData: boolean) => [
      ...asked(service, '  · removes the harness and hn commands, and the PATH line the installer added', '~/.harness', keepData),
      '✓ removed ~/.local/bin/harness',
      '✓ removed ~/.local/bin/hn',
      `✓ removed the PATH line Harness added to ${rc}`,
      keepData ? '✓ removed the program from ~/.harness' : '✓ removed ~/.harness',
      done(keepData),
    ]
    const windowsLines = (keepData: boolean) => [
      ...asked('Task Scheduler', '  · removes ~\\.harness\\bin from your PATH', '~\\.harness', keepData),
      '✓ removed ~\\.harness\\bin from your PATH',
      `✓ ${keepData ? 'the program in ~\\.harness' : '~\\.harness'} goes once this command has exited (anything left is listed in C:\\T\\h.log)`,
      done(keepData),
    ]
    for (const [name, platform, lines] of [['macOS', {}, posixLines('launchd', '~/.zshrc')], ['Windows', win, windowsLines], ['Linux', legacyLinux, posixLines('systemd', '~/.bashrc')]] as const) {
      for (const keepData of [false, true]) {
        const t = fake({ ...platform, isTTY: true, ask: async () => 'y' })
        expect(await uninstallCommand(keepData ? ['--keep-data'] : [], t.deps), name).toBe(0)
        expect(t.out, `${name}, --keep-data ${keepData}`).toEqual(lines(keepData))
        expect(t.err, name).toEqual([])
      }
    }
  })
})

describe('labelHookRemoval', () => {
  const labels = {
    claudeSettings: new Set(['/h/.claude/settings.json']), codexSettings: new Set(['/h/.codex/hooks.json']), reviews: new Set(['/h/.codex/config.toml']), whole: new Set(['/h/.codex/rules/harness.rules']),
    adopted: 'the homes Harness adopted', hooksLeft: 'Harness\'s hook commands are in a hooks: mapping Harness did not write; remove them by hand.',
  }
  it('says which kind of file each one is', () => {
    expect(labelHookRemoval({ file: '/h/.codex/hooks.json', removed: 2 }, labels)).toEqual({ file: '/h/.codex/hooks.json', removed: 2, kind: 'settings', codex: true })
    expect(labelHookRemoval({ file: '/h/.codex/config.toml', removed: 1 }, labels)).toEqual({ file: '/h/.codex/config.toml', removed: 1, kind: 'reviews' })
    expect(labelHookRemoval({ file: '/h/.codex/rules/harness.rules', removed: 1 }, labels)).toEqual({ file: '/h/.codex/rules/harness.rules', removed: 1, kind: 'file' })
    expect(labelHookRemoval({ file: 'the homes Harness adopted', removed: 0, failed: 'x' }, labels)).toMatchObject({ kind: 'adopted' })
    expect(labelHookRemoval({ file: '/h/.claude/settings.json', removed: 1 }, labels)).toEqual({ file: '/h/.claude/settings.json', removed: 1, kind: 'settings', claude: true })
    expect(labelHookRemoval({ file: '/h/.grok/hooks/harness.json', removed: 1 }, labels)).toEqual({ file: '/h/.grok/hooks/harness.json', removed: 1, kind: 'settings' })
  })
  it('reads hooks left in a mapping Harness did not write as hooks still there', () => {
    expect(labelHookRemoval({ file: '/h/.hermes/config.yaml', removed: 1, kept: labels.hooksLeft }, labels))
      .toEqual({ file: '/h/.hermes/config.yaml', removed: 1, kind: 'settings', failed: 'they are in a hooks: section Harness did not write' })
  })
})
