import { describe, expect, it } from 'vitest'
import { labelHookRemoval, lockHolder, UNINSTALL_USAGE, uninstallCommand, UninstallLockBusy, type UninstallDeps } from './command.js'
import { RemovalRefused } from './removal.js'

function fake(overrides: Partial<UninstallDeps> = {}) {
  const calls: string[] = []
  const out: string[] = []
  const err: string[] = []
  /** The uninstall marker's writes, each said with the step it came after: their order against the steps is the point. */
  const marks: string[] = []
  const after = (what: string) => marks.push(calls.length ? `${what} after ${calls.at(-1)}` : `${what} first`)
  let running = true
  const deps: UninstallDeps = {
    platform: 'darwin', cwd: '/Users/u/code', root: '/Users/u/.harness', home: '/Users/u',
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
  platform: 'win32' as const, cwd: 'C:\\Users\\u', root: 'C:\\Users\\u\\.harness', home: 'C:\\Users\\u', cliDir: 'C:\\Users\\u\\.harness\\cli',
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
      platform: 'win32' as const, cwd: 'C:\\Users\\u', root: 'C:\\Users\\u\\.harness', home: 'C:\\Users\\u',
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
    const odd = fake({ root: '/Users/u/harness' })
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
