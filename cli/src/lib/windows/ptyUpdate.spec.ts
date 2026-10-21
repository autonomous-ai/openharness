import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpawnLockBusyError } from '../daemonSpawnLock.js'
import { rejectedPtyVersions } from './ptyInstall.js'
import { PTY_PAYLOAD_FILES, PtyPayloadRefused, type PreparedPty, type PtyEntry } from './ptyPayload.js'
import { keepStaged, rollBackStaged, startPtyUpdater, sweepPtyLeftovers, type PtyPoller, type PtyUpdaterDeps } from './ptyUpdate.js'

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

/** A staging folder as preparePtyPayload leaves it. */
function stagingFor(version: string): PreparedPty {
  const staging = join(ptyRoot, `.staging-1-${Math.random().toString(36).slice(2)}`)
  mkdirSync(staging, { recursive: true })
  for (const name of PTY_PAYLOAD_FILES) writeFileSync(join(staging, name), `new ${name}`)
  return { version, staging, protocol: 2, features: ['seed'] }
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
    expect(await h.poller.readyToStage()).toBe('0.11.0')
    expect(pointer()).toBe('0.11.0')
    // Taken into the CLI's handover: the poller stages nothing more, on its own or for the CLI.
    expect(h.staged).toEqual([])
    expect(await h.poller.readyToStage()).toBeNull()
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

  it('keeps both', () => {
    onProbation()
    const calls: string[] = []
    keepStaged({ confirmCli: () => calls.push('confirm cli'), ptyRoot: root })
    expect(calls).toEqual(['confirm cli'])
    expect(existsSync(join(ptyRoot, 'pty-pending.json'))).toBe(false)
    expect(pointer()).toBe('0.11.0')
  })
})
