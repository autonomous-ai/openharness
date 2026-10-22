import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpawnLockBusyError } from '../daemonSpawnLock.js'
import { PTY_PROTOCOL } from '../ptyHost/protocol.js'
import { restore as restoreCli, startSelfUpdater } from '../selfUpdate.js'
import { installPreparedPty, rejectedPtyVersions } from './ptyInstall.js'
import { PTY_PAYLOAD_FILES, PtyPayloadRefused, PtyPayloadUnpackFailed, type PreparedPty, type PtyEntry } from './ptyPayload.js'
import {
  installedPtyProtocol, keepStaged, ptyOnProbation, ptyUnjudged, rollBackStaged, startPtyUpdater, sweepPtyLeftovers, takeBackPty,
  type PtyPoller, type PtyUpdaterDeps,
} from './ptyUpdate.js'

let root: string
let ptyRoot: string
let bin: string
const pollers: PtyPoller[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pty-update-'))
  ptyRoot = join(root, 'runtime', 'pty')
  bin = join(root, 'bin')
  // The machine as install.ps1 leaves it: 0.10.0 in use, its two bin files copied out of its folder.
  mkdirSync(join(ptyRoot, '0.10.0'), { recursive: true })
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.10.0', name), `old ${name}`)
  writeFileSync(join(ptyRoot, 'current-pty'), '0.10.0\r\n')
  mkdirSync(bin)
  for (const name of ['harness.exe', 'harness-launch.exe']) writeFileSync(join(bin, name), `old ${name}`)
})
afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const entryOf = (version = '0.11.0', sha = 'a'): PtyEntry => ({ version, url: 'https://cdn.test/pty.zip', sha256: sha.repeat(64), size: 10 })
const pointer = () => readFileSync(join(ptyRoot, 'current-pty'), 'utf8').trim()
const waitTicks = (n: number) => new Promise((resolve) => setTimeout(resolve, 20 * n + 10))

/** A staging folder as preparePtyPayload leaves it; [protocol] above this CLI's makes it a paired payload. */
function stagingFor(version: string, protocol = 2): PreparedPty {
  const staging = join(ptyRoot, `.staging-1-${Math.random().toString(36).slice(2)}`)
  mkdirSync(staging, { recursive: true })
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(staging, name), `new ${name}`)
  return { version, staging, protocol, features: ['seed'], paired: protocol > PTY_PROTOCOL }
}

/** A poller over the temp root, with the lock, the manifest and the download in the test's hands. */
function harness(over: {
  entry?: () => PtyEntry | null
  prepare?: PtyUpdaterDeps['prepare']
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>
  intervalMs?: number
  deps?: Partial<PtyUpdaterDeps>
} = {}) {
  const events: string[] = []
  const lines: string[] = []
  const staged: string[] = []
  let held = false
  const lock = over.withLock ?? (async <T>(fn: () => Promise<T>): Promise<T> => {
    held = true
    try { return await fn() } finally { held = false }
  })
  const poller = startPtyUpdater({
    url: 'https://cdn.test/pty/metadata.json', key: 'win32-x64', rootDir: root, intervalMs: over.intervalMs ?? 20,
    installedCli: () => '1.2.3',
    withLock: lock,
    onStaged: (version) => { events.push(`staged ${version} ${held ? 'locked' : 'unlocked'}`); staged.push(version) },
    deps: {
      fetchEntry: async () => { events.push('fetch'); return over.entry ? over.entry() : entryOf() },
      prepare: over.prepare ?? (async (entry) => { events.push(`prepare ${entry.version} ${held ? 'locked' : 'unlocked'}`); return stagingFor(entry.version) }),
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
      ...over.deps,
    },
  })
  pollers.push(poller)
  return { poller, events, lines, staged }
}

describe('startPtyUpdater', () => {
  it('a newer entry is installed under the lock and onStaged gets its version', async () => {
    const h = harness()
    await vi.waitFor(() => expect(h.staged).toEqual(['0.11.0']), { timeout: 2_000 })
    // Downloaded outside the lock; installed and handed over inside it.
    expect(h.events.filter((e) => !e.startsWith('fetch'))).toEqual(['prepare 0.11.0 unlocked', 'staged 0.11.0 locked'])
    expect(pointer()).toBe('0.11.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
    expect(JSON.parse(readFileSync(join(ptyRoot, 'pty-pending.json'), 'utf8'))).toEqual({ version: '0.11.0', previous: '0.10.0' })
    expect(h.lines).toContain('[update] newer terminal host available: 0.10.0 → 0.11.0')
    expect(h.lines).toContain('[update] staged terminal host 0.11.0 — handing over')
    // Once staged, it stops: the process is restarted onto what it staged.
    const fetched = h.events.filter((e) => e === 'fetch').length
    await waitTicks(3)
    expect(h.events.filter((e) => e === 'fetch').length).toBe(fetched)
  })

  it('a pointer that moved past it while downloading stages nothing', async () => {
    const h = harness({
      prepare: async (entry) => {
        // install.ps1 put a newer host in while this one downloaded.
        writeFileSync(join(ptyRoot, 'current-pty'), '0.12.0')
        return stagingFor(entry.version)
      },
    })
    await vi.waitFor(() => expect(h.lines.some((l) => l.includes('no longer an update'))).toBe(true), { timeout: 2_000 })
    await waitTicks(3)
    expect(h.staged).toEqual([])
    expect(pointer()).toBe('0.12.0')
    expect(existsSync(join(ptyRoot, '0.11.0'))).toBe(false)
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(readdirSync(ptyRoot).filter((n) => n.startsWith('.staging-'))).toEqual([])
    expect(h.lines.filter((l) => l.includes('no longer an update'))).toHaveLength(1)
  })

  it('a refused payload backs off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let sha = 'a'
    const prepared: string[] = []
    const h = harness({
      intervalMs: 1_000,
      entry: () => entryOf('0.11.0', sha),
      prepare: async (entry) => {
        prepared.push(entry.sha256[0])
        if (entry.sha256[0] === 'a') throw new PtyPayloadRefused('digest mismatch: nope')
        return stagingFor(entry.version)
      },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(prepared).toEqual(['a'])
    expect(h.lines).toContain('[update] terminal host 0.11.0 was refused (digest mismatch: nope) — not trying it again for 2 s')
    // Two intervals before it is tried again: the check between downloads nothing.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(prepared).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(prepared).toEqual(['a', 'a'])
    // Said once for the version, whatever the back-off.
    expect(h.lines.filter((l) => l.includes('not trying it again'))).toHaveLength(1)
    // A new entry for it is tried at once.
    sha = 'b'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(prepared).toEqual(['a', 'a', 'b'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.staged).toEqual(['0.11.0'])
  })

  it('a transient failure is retried next check with no back-off', async () => {
    let prepared = 0
    const h = harness({ prepare: async (entry) => { prepared++; if (prepared === 1) throw new Error('ECONNRESET'); return stagingFor(entry.version) } })
    await vi.waitFor(() => expect(h.staged).toEqual(['0.11.0']), { timeout: 2_000 })
    expect(h.lines.some((l) => l.includes('check failed') && l.includes('ECONNRESET'))).toBe(true)
    expect(h.lines.some((l) => l.includes('not trying it again'))).toBe(false)
  })

  it('a payload verified but not unpacked is unpacked again next check from the bytes kept, not downloaded again', async () => {
    const zip = Buffer.from('verified zip')
    const given: Array<Buffer | undefined> = []
    let sha = 'a'
    const h = harness({
      entry: () => entryOf('0.11.0', sha),
      prepare: async (entry, _runtimeDir, verified) => {
        given.push(verified)
        if (given.length === 1) throw new PtyPayloadUnpackFailed(zip, new Error('tar exited 1'))
        if (given.length === 3) throw new PtyPayloadUnpackFailed(Buffer.from('other zip'), new Error('EBUSY'))
        return stagingFor(entry.version)
      },
      withLock: async (fn) => { if (given.length >= 2 && sha === 'a') throw new SpawnLockBusyError(null); return fn() },
    })
    await vi.waitFor(() => expect(given).toHaveLength(2), { timeout: 2_000 })
    expect(given[0]).toBeUndefined()
    expect(given[1]).toBe(zip)
    expect(h.lines).toContain('[update] terminal host 0.11.0 was downloaded but could not be unpacked (tar exited 1) — unpacking it again next check, from the bytes already verified')
    expect(h.lines.some((l) => l.includes('not trying it again'))).toBe(false)
    // Another entry's bytes are never handed to it.
    sha = 'b'
    await vi.waitFor(() => expect(given).toHaveLength(4), { timeout: 2_000 })
    expect(given[2]).toBeUndefined()
    expect(given[3]?.toString()).toBe('other zip')
    await vi.waitFor(() => expect(h.staged).toEqual(['0.11.0']), { timeout: 2_000 })
  })

  it('a busy lock retries the install next tick without downloading again', async () => {
    let busy = 0
    const h = harness({
      withLock: async (fn) => {
        // Busy once, for the install (the start sweep before it gets the lock).
        if (h.events.some((e) => e.startsWith('prepare')) && busy++ === 0) throw new SpawnLockBusyError(null)
        return fn()
      },
    })
    await vi.waitFor(() => expect(h.staged).toEqual(['0.11.0']), { timeout: 2_000 })
    expect(busy).toBe(2)
    expect(h.events.filter((e) => e.startsWith('prepare'))).toHaveLength(1)
    expect(h.lines.filter((l) => l.includes('terminal host 0.11.0 is ready but the daemon spawn lock is'))).toHaveLength(1)
  })

  it('readyToStage installs a prepared payload, and returns null when there is none', async () => {
    // A lock that never lets the poller in on its own: only the CLI's handover (which holds it) installs.
    const h = harness({ withLock: async () => { throw new SpawnLockBusyError(null) } })
    expect(await h.poller.readyToStage()).toBeNull()
    await vi.waitFor(() => expect(h.events).toContain('prepare 0.11.0 unlocked'), { timeout: 2_000 })
    expect(await h.poller.readyToStage()).toEqual({ version: '0.11.0', protocol: 2, paired: false })
    expect(pointer()).toBe('0.11.0')
    // Taken into the CLI's handover: the poller stages nothing more, on its own or for the CLI.
    expect(h.staged).toEqual([])
    expect(await h.poller.readyToStage()).toBeNull()
  })

  it('a payload the manifest withdraws, or moves back from, is never installed by the next CLI stage', async () => {
    for (const after of [null, entryOf('0.10.0'), entryOf('0.11.0', 'b')]) {
      let offered: PtyEntry | null = entryOf()
      // Never in on its own: only the CLI's handover could install it.
      const h = harness({ entry: () => offered, withLock: async () => { throw new SpawnLockBusyError(null) } })
      await vi.waitFor(() => expect(h.events).toContain('prepare 0.11.0 unlocked'), { timeout: 2_000 })
      offered = after
      const fetched = h.events.filter((e) => e === 'fetch').length
      await vi.waitFor(() => expect(h.events.filter((e) => e === 'fetch').length).toBeGreaterThan(fetched), { timeout: 2_000 })
      if (after?.sha256.startsWith('b')) {
        // Replaced by other bytes: the new ones are prepared, never the old.
        await vi.waitFor(() => expect(h.events.filter((e) => e === 'prepare 0.11.0 unlocked')).toHaveLength(2), { timeout: 2_000 })
        h.poller.stop()
        continue
      }
      expect(await h.poller.readyToStage()).toBeNull()
      expect(pointer()).toBe('0.10.0')
      expect(readdirSync(ptyRoot).filter((n) => n.startsWith('.staging-'))).toEqual([])
      h.poller.stop()
    }
  })

  it('readyToStage never holds the CLI up: an install that fails is said and is null', async () => {
    const h = harness({
      withLock: async () => { throw new SpawnLockBusyError(null) },
      deps: { install: () => { throw new Error('EIO: disk gone') } },
    })
    await vi.waitFor(() => expect(h.events).toContain('prepare 0.11.0 unlocked'), { timeout: 2_000 })
    expect(await h.poller.readyToStage()).toBeNull()
    expect(h.lines.some((l) => l.includes('terminal host 0.11.0') && l.includes('EIO: disk gone'))).toBe(true)
  })

  it('a host on probation is nothing to do: no download, no back-off', async () => {
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.10.0', previous: '0.9.0' }))
    const h = harness()
    await waitTicks(4)
    expect(h.events).toEqual([])
    expect(h.staged).toEqual([])
    expect(h.lines.some((l) => l.includes('not trying it again'))).toBe(false)
  })

  it('a machine with no installed host, a dev CLI or a rejected version takes nothing', async () => {
    writeFileSync(join(ptyRoot, 'pty-rejected.json'), JSON.stringify(['0.11.0']))
    const h = harness()
    await waitTicks(4)
    expect(h.events.filter((e) => e !== 'fetch')).toEqual([])
  })

  it('stopped, stages nothing', async () => {
    const h = harness({ prepare: async (entry) => { h.poller.stop(); return stagingFor(entry.version) } })
    await waitTicks(4)
    expect(h.staged).toEqual([])
    expect(pointer()).toBe('0.10.0')
    expect(readdirSync(ptyRoot).filter((n) => n.startsWith('.staging-'))).toEqual([])
  })
})

describe('a host for a CLI build that needs it (the pairing rule)', () => {
  const above = PTY_PROTOCOL + 1

  it('host-3 alone is never installed: not by its own check, nor for a CLI build that does not need it', async () => {
    const h = harness({ prepare: async (entry) => { h.events.push(`prepare ${entry.version}`); return stagingFor(entry.version, above) } })
    await vi.waitFor(() => expect(h.events).toContain('prepare 0.11.0'), { timeout: 2_000 })
    await waitTicks(5)
    expect(h.staged).toEqual([])
    expect(pointer()).toBe('0.10.0')
    expect(h.lines.filter((l) => l === `[update] terminal host 0.11.0 speaks protocol ${above}, above this CLI's ${PTY_PROTOCOL} — it goes in only with a CLI build that needs it`)).toHaveLength(1)
    // Kept, prepared, for the build that needs it: downloaded once.
    expect(h.events.filter((e) => e.startsWith('prepare'))).toHaveLength(1)
    expect(h.poller.readyProtocol()).toBe(above)
    expect(await h.poller.readyToStage()).toBeNull()
    expect(await h.poller.readyToStage(PTY_PROTOCOL)).toBeNull()
    expect(pointer()).toBe('0.10.0')
    expect(await h.poller.readyToStage(above)).toEqual({ version: '0.11.0', protocol: above, paired: true })
    expect(pointer()).toBe('0.11.0')
    expect(h.poller.readyProtocol()).toBeNull()
  })

  it('a host taken back out after its build failed to stage is prepared again once the back-off has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = harness({ intervalMs: 1_000, prepare: async (entry) => { h.events.push(`prepare ${entry.version}`); return stagingFor(entry.version, above) } })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await h.poller.readyToStage(above)).toEqual({ version: '0.11.0', protocol: above, paired: true })
    // The CLI build did not stage: the host goes back out (services/updaterProcess.ts), and the poller is told.
    takeBackPty(root, () => {}, '[update] ')
    expect(pointer()).toBe('0.10.0')
    h.poller.takenBack()
    expect(h.lines).toContain('[update] terminal host 0.11.0 was taken back out with the build it came with — preparing it again in 2 s')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.events.filter((e) => e.startsWith('prepare'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.events.filter((e) => e.startsWith('prepare'))).toHaveLength(2)
    expect(h.poller.readyProtocol()).toBe(above)
    // Taken back again: the back-off doubles, as a refusal's does.
    expect(await h.poller.readyToStage(above)).not.toBeNull()
    takeBackPty(root, () => {}, '[update] ')
    h.poller.takenBack()
    expect(h.lines).toContain('[update] terminal host 0.11.0 was taken back out with the build it came with — preparing it again in 4 s')
    // Nothing to re-arm once stopped, or with nothing installed.
    h.poller.stop()
    h.poller.takenBack()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.events.filter((e) => e.startsWith('prepare'))).toHaveLength(2)
    const fresh = harness({ intervalMs: 1_000 })
    fresh.poller.takenBack()
    expect(fresh.lines.filter((l) => l.includes('taken back'))).toEqual([])
  })

  it('a supported payload says its protocol too, and goes in with any build', async () => {
    const h = harness({ withLock: async () => { throw new SpawnLockBusyError(null) } })
    expect(h.poller.readyProtocol()).toBeNull()
    await vi.waitFor(() => expect(h.events).toContain('prepare 0.11.0 unlocked'), { timeout: 2_000 })
    expect(h.poller.readyProtocol()).toBe(2)
    expect(await h.poller.readyToStage(above)).toEqual({ version: '0.11.0', protocol: 2, paired: false })
  })

  describe('with the CLI updater beside it', () => {
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
    const notify = Buffer.from('export {}\n')
    const oldCli = Buffer.from('console.log("1.0.0")\n')
    /** A CLI build that needs host protocol [needs]: what its `version --json` says, through the canary. */
    const cliNeeding = (needs: number) => Buffer.from(
      `console.log(process.argv.includes('--json') ? JSON.stringify({ version: '9.9.9', ptyProtocol: ${needs} }) : '9.9.9')\n`,
    )
    const stops: Array<() => void> = []
    afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

    /** Both pollers as the updater process runs them: one lock, the host first in the CLI's handover. */
    function both(o: { cli: Buffer; hostProtocol: number }) {
      const events: string[] = []
      const handovers: Array<{ version?: string; ptyVersion?: string }> = []
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.endsWith('/metadata.json')) {
          return new Response(JSON.stringify({ adapter: {
            version: '9.9.9', cli: { url: 'https://updates.test/cli.js', sha256: sha(o.cli) }, notify: { url: 'https://updates.test/notify.mjs', sha256: sha(notify) },
          } }))
        }
        return new Response(url.endsWith('cli.js') ? o.cli : notify)
      })
      vi.spyOn(console, 'log').mockImplementation((line: string) => { events.push(String(line)) })
      vi.spyOn(console, 'error').mockImplementation((line: string) => { events.push(String(line)) })
      const dir = join(root, 'cli')
      mkdirSync(dir)
      writeFileSync(join(dir, 'cli.js'), oldCli)
      const pty = startPtyUpdater({
        url: 'https://cdn.test/pty/metadata.json', key: 'win32-x64', rootDir: root, intervalMs: 20, installedCli: () => '1.0.0',
        withLock: (fn) => fn(),
        onStaged: (ptyVersion) => { handovers.push({ ptyVersion }) },
        deps: {
          fetchEntry: async () => entryOf(),
          prepare: async (entry) => stagingFor(entry.version, o.hostProtocol),
          install: (prepared, rootDir) => { events.push(`install host ${prepared.version}`); return installPreparedPty(prepared, rootDir) },
          log: (line) => events.push(line), error: (line) => events.push(line),
        },
      })
      pollers.push(pty)
      const cli = startSelfUpdater({
        currentVersion: '1.0.0', url: 'https://updates.test/metadata.json', key: 'adapter', dir, intervalMs: 20, platform: 'darwin',
        // The host's own `version`: the installed folder's protocol.
        installedPtyProtocol: () => installedPtyProtocol(root, (binary) => ({ protocol: binary.includes('0.11.0') ? o.hostProtocol : 2 })),
        readyPtyProtocol: () => pty.readyProtocol(),
        beforeStage: (needs) => pty.readyToStage(needs),
        onStaged: (version, ptyVersion) => {
          events.push(`stage cli ${readFileSync(join(dir, 'cli.js')).equals(o.cli) ? 'done' : 'not done'}`)
          handovers.push({ version, ...(ptyVersion ? { ptyVersion } : {}) })
        },
      })
      stops.push(() => cli.stop())
      return { dir, events, handovers }
    }

    it('a protocol-2 updater with host-3 payload and CLI-3 build ready installs both in one handover, host first', async () => {
      const m = both({ cli: cliNeeding(above), hostProtocol: above })
      await vi.waitFor(() => expect(m.handovers).toEqual([{ version: '9.9.9', ptyVersion: '0.11.0' }]), { timeout: 5_000 })
      expect(pointer()).toBe('0.11.0')
      const order = m.events.filter((e) => e.startsWith('install host') || e.startsWith('stage cli'))
      expect(order).toEqual(['install host 0.11.0', 'stage cli done'])

      // One probation for the pair: the new core failed, and the master's rollback puts both back.
      rollBackStaged({
        cliPending: () => existsSync(join(m.dir, 'update-pending.json')),
        restoreCli: () => restoreCli(m.dir, 'darwin'),
        ptyRoot: root, log: () => {},
      })
      expect(pointer()).toBe('0.10.0')
      expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('old harness.exe')
      expect(readFileSync(join(m.dir, 'cli.js'))).toEqual(oldCli)
      expect(rejectedPtyVersions(root)).toEqual(['0.11.0'])
    })

    it('CLI-3 alone waits: with no host payload, or one of another protocol', async () => {
      const m = both({ cli: cliNeeding(above), hostProtocol: 2 })
      const waiting = `[update] 9.9.9 needs pty protocol ${above}; this machine's host speaks 2 — waiting for its payload`
      await vi.waitFor(() => expect(m.events).toContain(waiting), { timeout: 5_000 })
      await waitTicks(5)
      // The protocol-2 host goes in on its own, as any supported one; the CLI build still waits for protocol 3.
      expect(m.handovers).toEqual([{ ptyVersion: '0.11.0' }])
      expect(readFileSync(join(m.dir, 'cli.js'))).toEqual(oldCli)
    })
  })
})

describe('the start sweep', () => {
  it('removes staging folders and aside files under the lock before the first check', async () => {
    mkdirSync(join(ptyRoot, '.staging-9-9'))
    writeFileSync(join(bin, 'harness.exe.old-9-9'), 'stale')
    let held = false
    const order: string[] = []
    const h = harness({
      withLock: async (fn) => { held = true; try { return await fn() } finally { held = false } },
      deps: { sweep: (rootDir, log) => { order.push(`sweep ${held ? 'locked' : 'unlocked'}`); sweepPtyLeftovers(rootDir, log) } },
    })
    await vi.waitFor(() => expect(h.events).toContain('fetch'), { timeout: 2_000 })
    expect(order).toEqual(['sweep locked'])
    expect(existsSync(join(ptyRoot, '.staging-9-9'))).toBe(false)
    expect(existsSync(join(bin, 'harness.exe.old-9-9'))).toBe(false)
  })

  it('puts a missing bin file back from its newest aside file, and sweeps nothing while one stays missing', () => {
    rmSync(join(bin, 'harness.exe'))
    writeFileSync(join(bin, 'harness.exe.old-5-100'), 'older')
    writeFileSync(join(bin, 'harness.exe.old-4-200'), 'newest')
    const lines: string[] = []
    sweepPtyLeftovers(root, (line) => lines.push(line))
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('newest')
    expect(lines).toContain('[update] put bin\\harness.exe back from harness.exe.old-4-200')
    // Back in place: the rest is swept.
    expect(readdirSync(bin).sort()).toEqual(['harness-launch.exe', 'harness.exe'])

    // A path missing whose aside file cannot be put back: nothing is swept, its bytes stay.
    rmSync(join(bin, 'harness.exe'))
    writeFileSync(join(bin, 'harness.exe.old-1-1'), 'aside')
    writeFileSync(join(bin, 'harness-launch.exe.old-1-1'), 'aside')
    const failed: string[] = []
    const fs = { rename: () => { throw Object.assign(new Error('held'), { code: 'EBUSY' }) } }
    sweepPtyLeftovers(root, (line) => failed.push(line), fs)
    expect(existsSync(join(bin, 'harness-launch.exe.old-1-1'))).toBe(true)
    expect(existsSync(join(bin, 'harness.exe.old-1-1'))).toBe(true)
    expect(failed).toEqual(['[update] bin\\harness.exe is missing and harness.exe.old-1-1 could not be put back (held) — nothing is swept until it is'])
  })
})

describe("the master's rollback and keep", () => {
  /** 0.11.0 installed over 0.10.0 and on probation. */
  function onProbation(): void {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `new ${name}`)
    writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0')
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '0.10.0' }))
    for (const name of ['harness.exe', 'harness-launch.exe']) writeFileSync(join(bin, name), `new ${name}`)
  }

  it('rolls back the host on probation, and the CLI only when a CLI build is pending', () => {
    onProbation()
    const calls: string[] = []
    const lines: string[] = []
    rollBackStaged({ cliPending: () => false, restoreCli: () => calls.push('restore cli'), ptyRoot: root, log: (l) => lines.push(l) })
    expect(calls).toEqual([])
    expect(pointer()).toBe('0.10.0')
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('old harness.exe')
    expect(rejectedPtyVersions(root)).toEqual(['0.11.0'])
    expect(lines).toEqual(['[harnessd] terminal host 0.11.0 did not come back healthy — back to 0.10.0'])
    // Nothing on probation now: a second rollback is the CLI's alone.
    rollBackStaged({ cliPending: () => true, restoreCli: () => calls.push('restore cli'), ptyRoot: root, log: (l) => lines.push(l) })
    expect(calls).toEqual(['restore cli'])
    expect(lines).toHaveLength(1)
    // Off Windows there is no host payload, and the CLI is restored as it always was.
    rollBackStaged({ cliPending: () => false, restoreCli: () => calls.push('restore cli'), ptyRoot: null, log: (l) => lines.push(l) })
    expect(calls).toEqual(['restore cli', 'restore cli'])
  })

  it('puts a bin file the restore left missing back from its aside file', () => {
    onProbation()
    const lines: string[] = []
    // The copy back of harness.exe failed and so did its undo: the path is missing, its last bytes aside.
    const restorePty = () => {
      renameSync(join(bin, 'harness.exe'), join(bin, 'harness.exe.old-7-123'))
      return { found: true, pointer: true, restored: ['harness-launch.exe'], kept: [], missing: ['harness.exe'] }
    }
    rollBackStaged({ cliPending: () => false, restoreCli: () => {}, ptyRoot: root, log: (l) => lines.push(l), restorePty })
    expect(readFileSync(join(bin, 'harness.exe'), 'utf8')).toBe('new harness.exe')
    expect(lines).toEqual([
      '[harnessd] terminal host 0.11.0 did not come back healthy — back to 0.10.0',
      '[harnessd] put bin\\harness.exe back from harness.exe.old-7-123',
    ])
  })

  it('says a host it could not keep, whose marker then holds host updates back until a start judges it again', () => {
    onProbation()
    const lines: string[] = []
    keepStaged({ confirmCli: () => {}, ptyRoot: root, log: (l) => lines.push(l), confirmPty: () => { throw new Error('EPERM') } })
    expect(lines).toEqual(['[harnessd] could not keep terminal host 0.11.0 (EPERM) — judged again at the next start'])
    expect(ptyOnProbation(root)).toBe('terminal host 0.11.0')
  })

  it('a corrupt marker is judged at a start and cleared by the rollback, the host in use staying', () => {
    writeFileSync(join(ptyRoot, 'pty-pending.json'), '{ not json')
    expect(ptyOnProbation(root)).toBe('terminal host (unreadable marker)')
    const lines: string[] = []
    rollBackStaged({ cliPending: () => false, restoreCli: () => {}, ptyRoot: root, log: (l) => lines.push(l) })
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(pointer()).toBe('0.10.0')
    expect(lines).toEqual(['[harnessd] removed an unreadable terminal host probation marker — the host in use stays'])
    expect(ptyOnProbation(root)).toBeNull()
  })

  it('rolls back and keeps the host under the spawn lock, taken only while a host is on probation', () => {
    const calls: string[] = []
    const lock = () => { calls.push('lock'); return () => calls.push('release') }
    const restorePty = (rootDir: string) => { calls.push('restore pty'); return { found: false, pointer: false, restored: [], kept: [], missing: [], rootDir } }
    rollBackStaged({ cliPending: () => true, restoreCli: () => calls.push('restore cli'), ptyRoot: root, log: () => {}, lock, restorePty })
    expect(calls).toEqual(['restore cli'])
    onProbation()
    calls.length = 0
    rollBackStaged({ cliPending: () => true, restoreCli: () => calls.push('restore cli'), ptyRoot: root, log: () => {}, lock, restorePty })
    expect(calls).toEqual(['lock', 'restore pty', 'release', 'restore cli'])
    calls.length = 0
    keepStaged({ confirmCli: () => calls.push('confirm cli'), ptyRoot: root, lock, confirmPty: () => calls.push('confirm pty') })
    expect(calls).toEqual(['confirm cli', 'lock', 'confirm pty', 'release'])
    // A lock that stays busy: said, and the host judged all the same, as before the lock.
    const lines: string[] = []
    calls.length = 0
    keepStaged({ confirmCli: () => {}, ptyRoot: root, lock: () => null, log: (l) => lines.push(l), confirmPty: () => calls.push('confirm pty') })
    rollBackStaged({ cliPending: () => false, restoreCli: () => {}, ptyRoot: root, log: (l) => lines.push(l), lock: () => null, restorePty })
    expect(calls).toEqual(['confirm pty', 'restore pty'])
    expect(lines).toEqual([
      '[harnessd] the daemon spawn lock is busy — keeping terminal host 0.11.0 without it',
      '[harnessd] the daemon spawn lock is busy — rolling terminal host 0.11.0 back without it',
    ])
    // A keep with nothing on probation takes no lock.
    calls.length = 0
    rmSync(join(ptyRoot, 'pty-pending.json'))
    keepStaged({ confirmCli: () => {}, ptyRoot: root, lock, confirmPty: () => calls.push('confirm pty') })
    expect(calls).toEqual(['confirm pty'])
  })

  it('keeps both', () => {
    onProbation()
    const calls: string[] = []
    keepStaged({ confirmCli: () => calls.push('confirm cli'), ptyRoot: root })
    expect(calls).toEqual(['confirm cli'])
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(pointer()).toBe('0.11.0')
  })
})

describe('takeBackPty', () => {
  /** A paired 0.11.0 installed over 0.10.0, as `readyToStage` leaves it, and rejected nowhere yet. */
  function pairedIn(): void {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `new ${name}`)
    writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0')
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '0.10.0' }))
  }

  it('puts the previous host back, takes back the rejection the restore records, and says so', () => {
    pairedIn()
    const lines: string[] = []
    takeBackPty(root, (l) => lines.push(l), '[update] ')
    expect(pointer()).toBe('0.10.0')
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(rejectedPtyVersions(root)).toEqual([])
    expect(lines).toEqual(['[update] terminal host 0.11.0 taken back out with the build it came with — back to 0.10.0'])
  })

  it('says the host stays when the version before it is no longer there to go back to', () => {
    pairedIn()
    rmSync(join(ptyRoot, '0.10.0'), { recursive: true })
    const lines: string[] = []
    takeBackPty(root, (l) => lines.push(l), '  ', '  ✗ ')
    expect(pointer()).toBe('0.11.0')
    expect(lines).toEqual(['  ✗ terminal host 0.11.0 could not be taken back out: 0.10.0 is no longer there to go back to — it stays'])
  })

  it('on a failure, says the marker stays for the next master, which may keep it', () => {
    pairedIn()
    // The rejection the restore records first cannot be written: a folder stands where it goes.
    mkdirSync(join(ptyRoot, 'pty-rejected.json'))
    const lines: string[] = []
    takeBackPty(root, (l) => lines.push(l), '  ', '  ✗ ')
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^ {2}✗ could not take terminal host 0\.11\.0 back out \(.+\) — it stays on probation: the next master takes it back out, or judges it and may keep it$/)
  })
})

describe("a master's start: a host this build cannot speak on probation (ptyUnjudged)", () => {
  function onProbation(): void {
    mkdirSync(join(ptyRoot, '0.11.0'))
    for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(ptyRoot, '0.11.0', name), `new ${name}`)
    writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0')
    writeFileSync(join(ptyRoot, 'pty-pending.json'), JSON.stringify({ version: '0.11.0', previous: '0.10.0' }))
  }
  const speaks = (protocol: number | null) => () => protocol

  it('takes back a host of a protocol it does not support, with no CLI build pending, instead of judging it', () => {
    onProbation()
    const lines: string[] = []
    const calls: string[] = []
    const lock = () => { calls.push('lock'); return () => calls.push('release') }
    expect(ptyUnjudged(root, { cliPending: false, log: (l) => lines.push(l), protocol: speaks(PTY_PROTOCOL + 1), lock })).toBeNull()
    expect(calls).toEqual(['lock', 'release'])
    expect(pointer()).toBe('0.10.0')
    expect(rejectedPtyVersions(root)).toEqual([])
    expect(lines).toEqual([
      `[harnessd] terminal host 0.11.0 is on probation with no CLI build, and speaks protocol ${PTY_PROTOCOL + 1}, which this build does not — taking it back out rather than judging it`,
      '[harnessd] terminal host 0.11.0 taken back out with the build it came with — back to 0.10.0',
    ])
  })

  it('judges it as before when it speaks a supported protocol, a CLI build is pending, its protocol cannot be read, or the take-back fails', () => {
    onProbation()
    const lines: string[] = []
    expect(ptyUnjudged(root, { cliPending: false, log: (l) => lines.push(l), protocol: speaks(PTY_PROTOCOL), lock: () => () => {} })).toBe('terminal host 0.11.0')
    expect(ptyUnjudged(root, { cliPending: true, log: (l) => lines.push(l), protocol: speaks(PTY_PROTOCOL + 1), lock: () => () => {} })).toBe('terminal host 0.11.0')
    expect(ptyUnjudged(root, { cliPending: false, log: (l) => lines.push(l), protocol: speaks(null), lock: () => () => {} })).toBe('terminal host 0.11.0')
    expect(lines).toEqual([])
    mkdirSync(join(ptyRoot, 'pty-rejected.json'))
    expect(ptyUnjudged(root, { cliPending: false, log: (l) => lines.push(l), protocol: speaks(PTY_PROTOCOL + 1), lock: () => null })).toBe('terminal host 0.11.0')
    expect(lines[0]).toBe('[harnessd] the daemon spawn lock is busy — taking terminal host 0.11.0 back out without it')
    expect(lines.at(-1)).toMatch(/could not take terminal host 0\.11\.0 back out/)
    expect(pointer()).toBe('0.11.0')
  })

  it('takes no lock and reads nothing with no host on probation', () => {
    const calls: string[] = []
    expect(ptyUnjudged(root, { cliPending: false, log: () => {}, protocol: () => { calls.push('protocol'); return 3 }, lock: () => { calls.push('lock'); return null } })).toBeNull()
    expect(calls).toEqual([])
    writeFileSync(join(ptyRoot, 'pty-pending.json'), '{ not json')
    expect(ptyUnjudged(root, { cliPending: false, log: () => {}, protocol: () => { calls.push('protocol'); return 3 } , lock: () => { calls.push('lock'); return () => {} } })).toBe('terminal host (unreadable marker)')
    expect(calls).toEqual([])
  })
})

describe('installedPtyProtocol', () => {
  it('is the protocol of the host current-pty names, or null when there is none to read', () => {
    const asked: string[] = []
    const version = (binary: string) => { asked.push(binary); return binary.includes('0.10.0') ? { protocol: 2 } : null }
    expect(installedPtyProtocol(root, version)).toBe(2)
    expect(asked).toEqual([join(ptyRoot, '0.10.0', 'harness-pty.exe')])
    writeFileSync(join(ptyRoot, 'current-pty'), '0.11.0')
    expect(installedPtyProtocol(root, version)).toBeNull()
    rmSync(join(ptyRoot, 'current-pty'))
    expect(installedPtyProtocol(root, version)).toBeNull()
  })
})
