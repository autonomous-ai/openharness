import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PtyHostDiscovery } from '../ptyHost/client.js'
import { endPtyHosts, HOST_EXIT_WAIT_MS, PANE_GRACE_MS, ptyHostsDeps, type HostClient, type PtyHostsDeps } from './ptyHosts.js'

const discovery = (pid: number, protocol = 2, instance = `p${protocol}`): PtyHostDiscovery => ({ protocol, instance, endpoint: 'e', pid, version: '0.5.0', token: 't' })
/** When the record was written, as it was read: after both rows' start markers below. */
const WRITTEN = Date.parse('Sun Oct 18 10:00:00 2026')
const rec = (pid: number, protocol = 2, written: number | null = WRITTEN, instance = `p${protocol}`) => ({ discovery: discovery(pid, protocol, instance), written })
const filetime = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`

const WIN_HOME = 'C:\\Users\\u\\.harness\\adapters\\pty'
const WIN_EXE = 'C:\\Users\\u\\.harness\\runtime\\pty\\0.5.0\\harness-pty.exe'
const winRow = (overrides: Record<string, unknown> = {}) => ({ pid: 100, parentPid: 1, executable: WIN_EXE, startMarker: 'w:1', args: `"${WIN_EXE}" serve --home ${WIN_HOME} --history-limit 2000 --no-reexec`, ...overrides })
const UNIX_HOME = '/Users/u/.harness/adapters/pty'
const unixRow = (overrides: Record<string, unknown> = {}) => ({ pid: 100, parentPid: 1, executable: '/Users/u/.harness/runtime/pty/0.5.0/harness-pty', startMarker: 'Sat Oct 17 10:00:00 2026', args: `/Users/u/.harness/runtime/pty/0.5.0/harness-pty serve --home ${UNIX_HOME}`, ...overrides })

function host(panes: string[], options: { refuseFirstShutdown?: boolean; refuseShutdown?: boolean; exitsOnShutdown?: boolean; protocol?: number; inventoryFails?: boolean } = {}) {
  const calls: string[] = []
  let alive = true
  let refused = !options.refuseFirstShutdown
  const table = new Set(panes)
  const client: HostClient = {
    protocol: options.protocol ?? 2,
    pid: 100,
    close: () => { calls.push('close') },
    call: (async (op: { op: string; pane?: string }) => {
      calls.push(op.pane ? `${op.op} ${op.pane}` : op.op)
      if (op.op === 'inventory') {
        if (options.inventoryFails) return { state: 'failed', dispatch: 'rejected', code: 'internal', reason: 'the table is busy' }
        return { state: 'ok', value: { panes: [...table].map((pane) => ({ pane })) } }
      }
      if (op.op === 'kill') { table.delete(op.pane!); return { state: 'ok', value: {} } }
      if (op.op === 'shutdown') {
        if (options.refuseShutdown) return { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'host still has panes (1)' }
        if (!refused) { refused = true; table.add('%9'); return { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'host still has panes (1)' } }
        if (options.exitsOnShutdown !== false) alive = false
        return { state: 'ok', value: {} }
      }
      return { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'no' }
    }) as HostClient['call'],
  }
  return { client, calls, alive: () => alive, kill: () => { alive = false } }
}

function deps(h: ReturnType<typeof host> | null, overrides: Partial<PtyHostsDeps> = {}): { deps: PtyHostsDeps; slept: number[]; ended: string[] } {
  const slept: number[] = []
  const ended: string[] = []
  return {
    slept, ended,
    deps: {
      platform: 'win32',
      home: WIN_HOME,
      discover: () => [rec(100)],
      reach: async () => (h ? { client: h.client } : { unreachable: 'nothing answers' }),
      alive: (pid) => pid === 100 && (h ? h.alive() : true),
      dead: async () => false,
      rows: async () => [winRow()],
      terminate: async (pid, marker) => { ended.push(`${pid} ${marker}`); h?.kill(); return 'ended' },
      sleep: async (ms) => { slept.push(ms) },
      ...overrides,
    },
  }
}

const left = (detail: string, panes = 0) => [{ pid: 100, protocol: 2, panes, how: 'left', detail }]

describe('endPtyHosts', () => {
  it('kills each pane, gives them their grace, then shuts the host down', async () => {
    const h = host(['%1', '%2'])
    const t = deps(h)
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 2, panes: 2, how: 'shut down' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'kill %2', 'shutdown', 'close'])
    expect(t.slept).toContain(PANE_GRACE_MS)
    expect(t.ended).toEqual([])
  })

  it('goes round once more when a pane appeared before the shutdown', async () => {
    const h = host(['%1'], { refuseFirstShutdown: true })
    expect(await endPtyHosts(deps(h).deps)).toEqual([{ pid: 100, protocol: 2, panes: 2, how: 'shut down' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'shutdown', 'inventory', 'kill %9', 'shutdown', 'close'])
  })

  it('ends an unreachable Windows host by its pid and start marker, and leaves a pid that is not a harness-pty', async () => {
    const t = deps(null)
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    expect(t.ended).toEqual(['100 w:1'])
    const other = deps(null, { rows: async () => [winRow({ executable: 'C:\\x\\notepad.exe', startMarker: 'w:2' })] })
    expect(await endPtyHosts(other.deps)).toEqual(left('nothing answers, and pid 100 is not a harness-pty process'))
    expect(other.ended).toEqual([])
  })

  it('leaves a harness-pty that serves another home, comparing a Windows home without case', async () => {
    const other = deps(null, { rows: async () => [winRow({ args: `"${WIN_EXE}" serve --home C:\\work\\b4\\pty --no-reexec` })] })
    expect(await endPtyHosts(other.deps)).toEqual(left(`nothing answers, and pid 100 is not the host of ${WIN_HOME}`))
    expect(other.ended).toEqual([])
    const noHome = deps(null, { rows: async () => [winRow({ args: `"${WIN_EXE}" ps --json` })] })
    expect((await endPtyHosts(noHome.deps))[0]!.how).toBe('left')
    const cased = deps(null, { rows: async () => [winRow({ args: `"${WIN_EXE}" serve --home "${WIN_HOME.toUpperCase()}\\" --no-reexec` })] })
    expect(await endPtyHosts(cased.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    const native = deps(null, { rows: async () => [winRow({ args: '', nativeArgv: [WIN_EXE, 'serve', '--home', WIN_HOME] })] })
    expect((await endPtyHosts(native.deps))[0]!.how).toBe('ended')
  })

  it('leaves a harness-pty that started after its record was written, or whose record has no time', async () => {
    const later = deps(null, { rows: async () => [winRow({ startMarker: filetime(WRITTEN + 10_000) })] })
    expect(await endPtyHosts(later.deps)).toEqual(left('nothing answers, and pid 100 started after its record was written, so it is another process'))
    expect((await endPtyHosts(deps(null, { rows: async () => [winRow({ startMarker: filetime(WRITTEN + 1_000) })] }).deps))[0]!.how).toBe('ended')
    // Fail closed: no time for the record, or a start marker that does not read as a time, is no proof.
    const untimed = deps(null, { discover: () => [rec(100, 2, null)] })
    expect(await endPtyHosts(untimed.deps)).toEqual(left("nothing answers, and its record's time could not be read"))
    const unparsed = deps(null, { rows: async () => [winRow({ startMarker: 'soon' })] })
    expect(await endPtyHosts(unparsed.deps)).toEqual(left("nothing answers, and its record's time could not be read"))
    expect([...later.ended, ...untimed.ended, ...unparsed.ended]).toEqual([])
  })

  it('reports a host that exited between the table read and the kill as gone', async () => {
    let asked = 0
    const t = deps(null, { alive: () => asked++ < 1 })
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'gone' }])
    expect(t.ended).toEqual([])
  })

  it('reads a --home value as a whole token: a further token after it is another path', async () => {
    const win = deps(null, { rows: async () => [winRow({ args: `"${WIN_EXE}" serve --home ${WIN_HOME} old` })] })
    expect(await endPtyHosts(win.deps)).toEqual(left(`nothing answers, and pid 100 is not the host of ${WIN_HOME}`))
    const unix = deps(null, { platform: 'linux', home: '/x/pty', rows: async () => [unixRow({ args: 'harness-pty serve --home /x/pty old' })] })
    expect(await endPtyHosts(unix.deps)).toEqual(left('nothing answers, and pid 100 is not the host of /x/pty'))
    expect([...win.ended, ...unix.ended]).toEqual([])
    const flagged = deps(null, { platform: 'linux', home: '/x/pty', alive: () => !flagged.ended.length, rows: async () => [unixRow({ args: 'harness-pty serve --home /x/pty --history-limit 2000' })] })
    expect((await endPtyHosts(flagged.deps))[0]!.how).toBe('ended')
  })

  it('leaves a host whose start time cannot be read, or that changed while it was being ended', async () => {
    const unread = deps(null, { rows: async () => null })
    expect(await endPtyHosts(unread.deps)).toEqual(left('nothing answers, and its start time could not be read'))
    const unmarked = deps(null, { rows: async () => [winRow({ startMarker: '' })] })
    expect(await endPtyHosts(unmarked.deps)).toEqual(left('nothing answers, and its start time could not be read'))
    expect([...unread.ended, ...unmarked.ended]).toEqual([])
    const changed = deps(null, { terminate: async () => 'mismatch' })
    expect(await endPtyHosts(changed.deps)).toEqual(left('nothing answers; pid 100 changed while it was being ended'))
    const vanished = deps(null, { terminate: async () => 'gone' })
    expect(await endPtyHosts(vanished.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'gone' }])
  })

  it('leaves a host proven dead or gone alone', async () => {
    expect(await endPtyHosts(deps(null, { dead: async () => true }).deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'gone' }])
    expect(await endPtyHosts(deps(null, { alive: () => false }).deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'gone' }])
  })

  it('on Unix, ends an unreachable host with the identity-checked SIGTERM, only once its row proves it is the host', async () => {
    let up = true
    const unix = deps(null, { platform: 'darwin', home: UNIX_HOME, alive: () => up, rows: async () => [unixRow()], terminate: async (pid, marker) => { unix.ended.push(`${pid} ${marker}`); up = false; return 'ended' } })
    expect(await endPtyHosts(unix.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    expect(unix.ended).toEqual(['100 Sat Oct 17 10:00:00 2026'])
    // After a reboot the recorded pid may be any of the user's processes.
    const shell = deps(null, { platform: 'darwin', home: UNIX_HOME, rows: async () => [unixRow({ executable: '/bin/zsh', args: '-zsh' })] })
    expect(await endPtyHosts(shell.deps)).toEqual(left('nothing answers, and pid 100 is not a harness-pty process'))
    const later = deps(null, { platform: 'darwin', home: UNIX_HOME, rows: async () => [unixRow({ startMarker: 'Sun Oct 18 10:00:10 2026' })] })
    expect((await endPtyHosts(later.deps))[0]!.how).toBe('left')
    const elsewhere = deps(null, { platform: 'darwin', home: UNIX_HOME, rows: async () => [unixRow({ args: 'harness-pty serve --home /Users/u/other/pty' })] })
    expect(await endPtyHosts(elsewhere.deps)).toEqual(left(`nothing answers, and pid 100 is not the host of ${UNIX_HOME}`))
    // Unix paths keep their case.
    const cased = deps(null, { platform: 'linux', home: UNIX_HOME, rows: async () => [unixRow({ args: `harness-pty serve --home ${UNIX_HOME.toUpperCase()}` })] })
    expect((await endPtyHosts(cased.deps))[0]!.how).toBe('left')
    expect([...shell.ended, ...later.ended, ...elsewhere.ended, ...cased.ended]).toEqual([])
  })

  it("on macOS, reads the image from argv when ps cuts comm to 16 characters, but only when comm is the start of it", async () => {
    // Measured 2026-10-18: `ps -o comm=` shows `/Users/<user>/` and `pty/target/relea` for two hosts.
    const program = '/Users/John Doe/.harness/runtime/pty/0.5.0/harness-pty'
    const args = `${program} serve --home ${UNIX_HOME} --history-limit 2000`
    let up = true
    const cut = deps(null, { platform: 'darwin', home: UNIX_HOME, alive: () => up, rows: async () => [unixRow({ executable: program.slice(0, 16), args })], terminate: async () => { up = false; return 'ended' } })
    expect(await endPtyHosts(cut.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    const relative = deps(null, { platform: 'darwin', home: UNIX_HOME, alive: () => up, rows: async () => [unixRow({ executable: 'pty/target/relea', args: `pty/target/release/harness-pty serve --home ${UNIX_HOME}` })], terminate: async () => { up = false; return 'ended' } })
    up = true
    expect((await endPtyHosts(relative.deps))[0]!.how).toBe('ended')
    const renamed = deps(null, { platform: 'darwin', home: UNIX_HOME, rows: async () => [unixRow({ executable: '/usr/bin/python3', args })] })
    expect(await endPtyHosts(renamed.deps)).toEqual(left('nothing answers, and pid 100 is not a harness-pty process'))
    const windows = deps(null, { rows: async () => [winRow({ executable: 'C:\\Users\\u\\', args: `${WIN_EXE} serve --home ${WIN_HOME}` })] })
    expect((await endPtyHosts(windows.deps))[0]!.how).toBe('left')
  })

  it('on Unix, finds a home with a space in it in the unquoted ps text, and reports a host that outlives SIGTERM', async () => {
    const home = '/Users/John Doe/.harness/adapters/pty'
    const spaced = deps(null, { platform: 'darwin', home, rows: async () => [unixRow({ args: `/opt/harness-pty serve --home ${home} --history-limit 2000` })] })
    expect(await endPtyHosts(spaced.deps)).toEqual(left('nothing answers, and it outlived SIGTERM'))
    expect(spaced.ended).toEqual(['100 Sat Oct 17 10:00:00 2026'])
    expect(spaced.slept.filter((ms) => ms === 100)).toHaveLength(HOST_EXIT_WAIT_MS / 100)
    const prefix = deps(null, { platform: 'darwin', home, rows: async () => [unixRow({ args: `/opt/harness-pty serve --home ${home} copy` })] })
    expect((await endPtyHosts(prefix.deps))[0]!.how).toBe('left')
    expect(prefix.ended).toEqual([])
  })

  it('ends a protocol 1 host, which has no shutdown, once its panes are gone, without waiting for it first', async () => {
    const h = host(['%1'], { protocol: 1 })
    const t = deps(h, { discover: () => [rec(100, 1)] })
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 1, panes: 1, how: 'ended' }])
    expect(h.calls).toEqual(['inventory', 'kill %1', 'close'])
    expect(t.ended).toEqual(['100 w:1'])
    expect(t.slept).toEqual([PANE_GRACE_MS])
  })

  it('ends a host that refuses to shut down at once, saying why', async () => {
    const h = host(['%1'], { refuseShutdown: true })
    const t = deps(h, { terminate: async () => 'mismatch' })
    expect(await endPtyHosts(t.deps)).toEqual(left('it would not shut down (host still has panes (1)); pid 100 changed while it was being ended', 1))
    expect(t.slept).not.toContain(100)
  })

  it('keeps an inventory that failed as the reason', async () => {
    const h = host([], { protocol: 1, inventoryFails: true })
    const t = deps(h, { discover: () => [rec(100, 1)], terminate: async () => 'mismatch' })
    expect((await endPtyHosts(t.deps))[0]!.detail).toBe('its panes could not be listed (the table is busy); pid 100 changed while it was being ended')
  })

  it('ends a host that agreed to shut down but did not exit', async () => {
    const h = host([], { exitsOnShutdown: false })
    const t = deps(h)
    expect(await endPtyHosts(t.deps)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
    expect(t.slept.filter((ms) => ms === 100)).toHaveLength(HOST_EXIT_WAIT_MS / 100)
    expect(t.ended).toEqual(['100 w:1'])
    const kept = deps(host([], { exitsOnShutdown: false }), { terminate: async () => 'mismatch' })
    expect((await endPtyHosts(kept.deps))[0]!.detail).toBe('it agreed to shut down but did not exit; pid 100 changed while it was being ended')
  })
})

describe('endPtyHosts, several instances', () => {
  it('ends a legacy and two versioned hosts of one protocol in one home', async () => {
    const instances = new Map([[101, 'p2'], [102, 'p2-1.0.0'], [103, 'p2-1.1.0']])
    const up = new Set(instances.keys())
    const reached: string[] = []
    const shut: number[] = []
    const t = deps(null, {
      discover: () => [...instances].map(([pid, instance]) => rec(pid, 2, WRITTEN, instance)),
      alive: (pid) => up.has(pid),
      reach: async (instance) => {
        reached.push(instance)
        const pid = [...instances].find(([, name]) => name === instance)![0]
        const h = host([])
        const call = h.client.call
        h.client.call = (async (op: { op: string }) => { if (op.op === 'shutdown') { up.delete(pid); shut.push(pid) } return call(op as never) }) as typeof call
        return { client: h.client }
      },
    })
    expect(await endPtyHosts(t.deps)).toEqual([101, 102, 103].map((pid) => ({ pid, protocol: 2, panes: 0, how: 'shut down' })))
    expect(reached).toEqual(['p2', 'p2-1.0.0', 'p2-1.1.0'])
    expect(shut).toEqual([101, 102, 103])
  })
})

describe('ptyHostsDeps', () => {
  it('lists every instance with its own record time, legacy and versioned', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pty-hosts-'))
    try {
      mkdirSync(path.join(home, 'run'))
      const names = ['p2', 'p2-1.0.0', 'p2-1.1.0']
      names.forEach((instance, i) => {
        const file = path.join(home, 'run', instance === 'p2' ? 'pty-host-2.json' : `pty-host-${instance}.json`)
        writeFileSync(file, JSON.stringify(discovery(100 + i, 2, instance)))
        const at = new Date(WRITTEN - (i + 1) * 60_000)
        utimesSync(file, at, at)
      })
      const found = ptyHostsDeps(home).discover()
      expect(found.map((r) => r.discovery.instance).sort()).toEqual([...names].sort())
      for (const r of found) expect(r.written).toBe(WRITTEN - (names.indexOf(r.discovery.instance) + 1) * 60_000)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("takes each record's time as it reads the record, so a host that removes its record while it exits is still judged", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pty-hosts-'))
    try {
      mkdirSync(path.join(home, 'run'))
      const file = path.join(home, 'run', 'pty-host-2.json')
      writeFileSync(file, JSON.stringify(discovery(100)))
      const written = Date.now() - 60_000
      utimesSync(file, new Date(written), new Date(written))
      const real = ptyHostsDeps(home)
      expect(real.home).toBe(home)
      const recorded = real.discover()
      expect(recorded).toEqual([{ discovery: discovery(100), written: statSync(file).mtimeMs }])
      // A host that agreed to shut down removes its record first, then exits; this one does not exit.
      const h = host([], { exitsOnShutdown: false })
      const call = h.client.call
      h.client.call = (async (op: { op: string }) => { if (op.op === 'shutdown') rmSync(file); return call(op as never) }) as typeof call
      const ended: string[] = []
      const t = {
        ...real,
        discover: () => recorded,
        reach: async () => ({ client: h.client }),
        alive: () => h.alive(),
        dead: async () => false,
        rows: async () => [{ pid: 100, parentPid: 1, executable: '/opt/harness-pty', startMarker: filetime(written - 5_000), args: `/opt/harness-pty serve --home ${home}` }],
        terminate: async (pid: number, marker: string) => { ended.push(`${pid} ${marker}`); h.kill(); return 'ended' as const },
        sleep: async () => {},
      }
      expect(await endPtyHosts(t)).toEqual([{ pid: 100, protocol: 2, panes: 0, how: 'ended' }])
      expect(ended).toEqual([`100 ${filetime(written - 5_000)}`])
      expect(real.discover()).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
