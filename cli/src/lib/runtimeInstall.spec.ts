import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

let root = ''
let runtimeDir = ''
let binDir = ''
let cliDir = ''

async function load() {
  vi.resetModules()
  process.env.ADAPTER_RUNTIME_DIR = runtimeDir
  process.env.HARNESS_BIN_DIR = binDir
  process.env.ADAPTER_CLI_DIR = cliDir
  process.env.ADAPTER_RUNTIME_METADATA_URL = 'https://example.test/runtime/metadata.json'
  process.env.ADAPTER_GRID_RUNTIME_METADATA_URL = 'https://example.test/runtime/grid/metadata.json'
  delete process.env.HARNESS_GRID_BIN
  return import('./runtimeInstall.js')
}

/** A real gzipped tarball laid out the way every managed runtime ships — `<name>-<version>-<key>/bin/<name>`
 *  (nodejs.org's own shape, which tmux and grid copy) — with a runnable binary inside. */
function buildArchive(version: string, key: string, name: string = 'node', script: string = '#!/bin/sh\nexit 0\n'): { bytes: Buffer; root: string } {
  const archiveRoot = `${name}-${version}-${key}`
  const source = join(root, 'src', archiveRoot)
  rmSync(source, { recursive: true, force: true })
  mkdirSync(join(source, archiveRoot, 'bin'), { recursive: true })
  writeFileSync(join(source, archiveRoot, 'bin', name), script, { mode: 0o755 })
  const archive = join(root, `${archiveRoot}.tar.gz`)
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', source, archiveRoot])
  return { bytes: readFileSync(archive), root: archiveRoot }
}

/** A manifest of the shape every managed runtime publishes: `{ <name>: { <platform>: entry } }`. */
function manifestFor(name: string, key: string, version: string, bytes: Buffer, root: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    [name]: {
      [key]: {
        version,
        url: `https://example.test/runtime/${name}/${root}.tar.gz`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        archiveRoot: root,
        ...overrides,
      },
    },
  }
}

/** A grid already laid down under the runtime dir, the way an earlier ensure leaves it. */
function installedGrid(version: string, key: string, current: boolean): string {
  const dir = join(runtimeDir, `grid-${version}-${key}`, 'bin')
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'grid')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  if (current) writeFileSync(join(runtimeDir, 'current-grid'), `${bin}\n`)
  return bin
}

function currentPlatformKey(): string {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
}

/** Serves the manifest and the archive; any other URL is a test bug. */
function stubFetch(manifest: unknown, archive?: Buffer): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('metadata.json')) {
      return { ok: true, json: async () => manifest } as unknown as Response
    }
    if (archive && url.endsWith('.tar.gz')) {
      return { ok: true, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) } as unknown as Response
    }
    return { ok: false, status: 404 } as unknown as Response
  })
}

describe('ensureManagedRuntime', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-runtime-install-'))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(cliDir, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_METADATA_URL', 'ADAPTER_GRID_RUNTIME_METADATA_URL', 'HARNESS_GRID_BIN']) {
      delete process.env[key]
    }
  })

  it('does nothing, and fetches nothing, when a runtime is already installed', async () => {
    const node = join(runtimeDir, 'node-v22', 'bin', 'node')
    mkdirSync(join(runtimeDir, 'node-v22', 'bin'), { recursive: true })
    writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(runtimeDir, 'current-node'), `${node}\n`)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { ensureManagedRuntime } = await load()

    expect(await ensureManagedRuntime()).toBe(node)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('downloads, verifies and unpacks a runtime, then records it', async () => {
    const key = currentPlatformKey()
    const { bytes, root: archiveRoot } = buildArchive('v22.23.2', key)
    stubFetch({
      node: {
        [key]: {
          version: 'v22.23.2',
          url: 'https://example.test/runtime/node.tar.gz',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          archiveRoot,
        },
      },
    }, bytes)

    const { ensureManagedRuntime } = await load()
    const node = await ensureManagedRuntime()

    expect(node).toBe(join(runtimeDir, `node-v22.23.2-${key}`, 'bin', 'node'))
    expect(existsSync(node!)).toBe(true)
    expect(readFileSync(join(runtimeDir, 'current-node'), 'utf8').trim()).toBe(node)
    // Staging never survives, whatever happened.
    expect(readdirSync(runtimeDir).filter((n) => n.startsWith('.node-staging-'))).toEqual([])
  })

  it('keeps the event loop it shares with every session turning while a new runtime answers --version', async () => {
    // The core asks this on every start and, for grid, every ten minutes while it runs. Asked
    // synchronously, a slow first run — a onefile grid unpacking itself takes most of a minute —
    // held up every client, heartbeat and transcript for as long as it took.
    const key = currentPlatformKey()
    const { bytes, root: archiveRoot } = buildArchive('v22.23.4', key, 'node', '#!/bin/sh\nsleep 1\nexit 0\n')
    stubFetch(manifestFor('node', key, 'v22.23.4', bytes, archiveRoot), bytes)
    const { ensureManagedRuntime } = await load()

    let ticks = 0
    const ticker = setInterval(() => { ticks += 1 }, 20)
    try {
      expect(await ensureManagedRuntime()).toBe(join(runtimeDir, `node-v22.23.4-${key}`, 'bin', 'node'))
    } finally { clearInterval(ticker) }
    // A second of --version is fifty ticks of 20 ms; held synchronously it is none.
    expect(ticks).toBeGreaterThan(10)
  })

  it('keeps what it has when the archive does not unpack, and leaves no staging behind', async () => {
    const key = currentPlatformKey()
    const bytes = Buffer.from('not a gzipped tarball')
    stubFetch(manifestFor('node', key, 'v22.23.5', bytes, `node-v22.23.5-${key}`), bytes)
    const { ensureManagedRuntime } = await load()

    expect(await ensureManagedRuntime()).toBeNull()
    expect(existsSync(join(runtimeDir, 'current-node'))).toBe(false)
    expect(readdirSync(runtimeDir).filter((n) => n.startsWith('.node-staging-'))).toEqual([])
  })

  it('downloads a runtime with no deadline, only a silence of five minutes: a slow link must be able to finish it', async () => {
    // The bundle's own limits (a quarter of an hour in all) would cut a runtime of tens of MB off on a
    // slow link, and every daemon runs on it (lib/selfUpdate.ts RUNTIME_DOWNLOAD_LIMITS).
    const key = currentPlatformKey()
    const { bytes, root: archiveRoot } = buildArchive('v22.23.3', key)
    stubFetch({ node: { [key]: { version: 'v22.23.3', url: 'https://example.test/runtime/node.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, archiveRoot } } }, bytes)
    const limits: unknown[] = []
    vi.doMock('./selfUpdate.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./selfUpdate.js')>()
      return { ...actual, downloadVerified: (ref: Parameters<typeof actual.downloadVerified>[0], given?: Parameters<typeof actual.downloadVerified>[1]) => { limits.push(given); return actual.downloadVerified(ref, given) } }
    })
    try {
      const { ensureManagedRuntime } = await load()
      expect(await ensureManagedRuntime()).toBe(join(runtimeDir, `node-v22.23.3-${key}`, 'bin', 'node'))
      expect(limits).toEqual([{ idleMs: 300_000, deadlineMs: Number.POSITIVE_INFINITY }])
    } finally { vi.doUnmock('./selfUpdate.js') }
  })

  it('refuses an archive whose bytes do not match the manifest', async () => {
    const key = currentPlatformKey()
    const { bytes, root: archiveRoot } = buildArchive('v22.23.2', key)
    stubFetch({
      node: {
        [key]: {
          version: 'v22.23.2',
          url: 'https://example.test/runtime/node.tar.gz',
          sha256: 'a'.repeat(64),
          size: bytes.length,
          archiveRoot,
        },
      },
    }, bytes)

    const { ensureManagedRuntime } = await load()

    expect(await ensureManagedRuntime()).toBeNull()
    expect(existsSync(join(runtimeDir, 'current-node'))).toBe(false)
  })

  // Served as a fully valid, correctly-hashed archive — so the ONLY thing that can reject it is the
  // scheme check. Anything less and this passes for the wrong reason.
  it('refuses a plaintext archive URL even when the bytes are otherwise valid', async () => {
    const key = currentPlatformKey()
    const { bytes, root: archiveRoot } = buildArchive('v22.23.2', key)
    stubFetch({
      node: {
        [key]: {
          version: 'v22.23.2',
          url: 'http://example.test/runtime/node.tar.gz',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          archiveRoot,
        },
      },
    }, bytes)

    const { ensureManagedRuntime } = await load()

    expect(await ensureManagedRuntime()).toBeNull()
    expect(existsSync(join(runtimeDir, 'current-node'))).toBe(false)
  })

  // A daemon must not fail to start because a download failed; it keeps the interpreter it has.
  it('returns null instead of throwing when the manifest is unreachable', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ENOTFOUND') })

    const { ensureManagedRuntime } = await load()

    await expect(ensureManagedRuntime()).resolves.toBeNull()
  })
})

/**
 * The managed grid follows the PIN, where the managed Node stops at "one is installed": the harness
 * manifest names the grid version this daemon can drive, and a pin that moved must reach a machine
 * that already has an older one. Everything else — the archive shape, the staging, the pointer —
 * is the runtime convention Node and tmux already use.
 */
describe('finishesCleanly', () => {
  it('says whether a child exits 0, without holding up the event loop while it runs', async () => {
    const { finishesCleanly } = await import('./runtimeInstall.js')
    let ticks = 0
    const ticker = setInterval(() => { ticks += 1 }, 20)
    try {
      expect(await finishesCleanly('/bin/sh', ['-c', 'sleep 0.6; exit 0'], 10_000)).toBe(true)
    } finally { clearInterval(ticker) }
    expect(ticks).toBeGreaterThan(5)
    expect(await finishesCleanly('/bin/sh', ['-c', 'exit 3'], 10_000)).toBe(false)
    // Neither a missing executable nor one spawn refuses outright is an exception for its caller.
    expect(await finishesCleanly(join(tmpdir(), 'no-such-runtime-binary'), [], 10_000)).toBe(false)
    expect(await finishesCleanly('/bin/sh\0', [], 10_000)).toBe(false)
  })

  it('gives up on a child at its deadline, and SIGKILLs one that ignores the SIGTERM', async () => {
    const { finishesCleanly } = await import('./runtimeInstall.js')
    let started = performance.now()
    // A child that exits 0 after its deadline is still a no: the deadline is the answer.
    expect(await finishesCleanly('/bin/sh', ['-c', 'sleep 30'], 200)).toBe(false)
    expect(performance.now() - started).toBeLessThan(10_000)
    started = performance.now()
    expect(await finishesCleanly('/bin/sh', ['-c', 'trap "" TERM; exec sleep 30'], 200)).toBe(false)
    const took = performance.now() - started
    // The SIGTERM is ignored; the SIGKILL two seconds on is not.
    expect(took).toBeGreaterThan(2_000)
    expect(took).toBeLessThan(15_000)
  }, 30_000)
})

describe('ensureManagedGrid', () => {
  const key = currentPlatformKey()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-grid-install-'))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    for (const dir of [runtimeDir, binDir, cliDir]) mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // 0555 directories cannot be emptied as they are; give them back before the sweep.
    for (const entry of readdirSync(runtimeDir)) {
      try { chmodSync(join(runtimeDir, entry, 'bin'), 0o755) } catch { /* not a runtime dir */ }
    }
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_METADATA_URL', 'ADAPTER_GRID_RUNTIME_METADATA_URL', 'HARNESS_GRID_BIN']) {
      delete process.env[key]
    }
  })

  it('downloads, verifies and unpacks the pinned grid from its own manifest, records it, and lays it down read-only', async () => {
    const { bytes, root: archiveRoot } = buildArchive('0.3.47', key, 'grid')
    stubFetch(manifestFor('grid', key, '0.3.47', bytes, archiveRoot), bytes)

    const { ensureManagedGrid } = await load()
    const grid = await ensureManagedGrid()

    expect(grid).toBe(join(runtimeDir, `grid-0.3.47-${key}`, 'bin', 'grid'))
    expect(readFileSync(join(runtimeDir, 'current-grid'), 'utf8').trim()).toBe(grid)
    // `grid update` replaces the binary with os.replace — a rename INTO this directory. A directory
    // it cannot write to is what makes that fail loudly instead of overwriting the pin.
    expect(statSync(grid!).mode & 0o777).toBe(0o555)
    expect(statSync(dirname(grid!)).mode & 0o777).toBe(0o555)
    expect(readdirSync(runtimeDir).filter((n) => n.startsWith('.grid-staging-'))).toEqual([])
  })

  it('fetches only the manifest when the installed grid IS the pin', async () => {
    const installed = installedGrid('0.3.47', key, true)
    const { bytes, root: archiveRoot } = buildArchive('0.3.47', key, 'grid')
    const urls: string[] = []
    stubFetch(manifestFor('grid', key, '0.3.47', bytes, archiveRoot), bytes)
    const served = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL) => { urls.push(String(input)); return served(input) })

    const { ensureManagedGrid } = await load()

    expect(await ensureManagedGrid()).toBe(installed)
    expect(urls).toEqual(['https://example.test/runtime/grid/metadata.json'])
  })

  it('follows a pin that moved: installs the new version, keeps the one it replaces, drops older ones', async () => {
    installedGrid('0.3.45', key, false)
    const previous = installedGrid('0.3.46', key, true)
    const { bytes, root: archiveRoot } = buildArchive('0.3.47', key, 'grid')
    stubFetch(manifestFor('grid', key, '0.3.47', bytes, archiveRoot), bytes)

    const { ensureManagedGrid } = await load()
    const grid = await ensureManagedGrid()

    expect(grid).toBe(join(runtimeDir, `grid-0.3.47-${key}`, 'bin', 'grid'))
    expect(readFileSync(join(runtimeDir, 'current-grid'), 'utf8').trim()).toBe(grid)
    // A pane launched before the move has the OLD directory on its PATH for as long as it lives;
    // deleting it would take `grid` away from an agent mid-conversation. One version back stays.
    expect(existsSync(previous)).toBe(true)
    expect(existsSync(join(runtimeDir, `grid-0.3.45-${key}`))).toBe(false)
  })

  it('tries a pin that does not run on this computer ONCE, and remembers', async () => {
    const installed = installedGrid('0.3.46', key, true)
    const { bytes, root: archiveRoot } = buildArchive('0.3.47', key, 'grid')
    // The archive's grid records every run, then refuses — a wrong-arch build, say.
    const runs = join(root, 'runs')
    const source = join(root, 'src', archiveRoot, archiveRoot, 'bin', 'grid')
    writeFileSync(source, `#!/bin/sh\necho ran >> '${runs}'\nexit 1\n`, { mode: 0o755 })
    execFileSync('/usr/bin/tar', ['-czf', join(root, `${archiveRoot}.tar.gz`), '-C', join(root, 'src', archiveRoot), archiveRoot])
    const rebuilt = readFileSync(join(root, `${archiveRoot}.tar.gz`))
    stubFetch(manifestFor('grid', key, '0.3.47', rebuilt, archiveRoot), rebuilt)
    void bytes

    const { ensureManagedGrid } = await load()

    // The pointer stays on the grid that works, and the one that does not is marked.
    expect(await ensureManagedGrid()).toBe(installed)
    expect(readFileSync(join(runtimeDir, 'current-grid'), 'utf8').trim()).toBe(installed)
    expect(existsSync(join(runtimeDir, `grid-0.3.47-${key}`, '.unrunnable'))).toBe(true)
    // Every daemon start asks again; a start must not pay a download and a hung exec for a pin this
    // computer has already refused. One manifest fetch, no second run.
    expect(await ensureManagedGrid()).toBe(installed)
    expect(readFileSync(runs, 'utf8')).toBe('ran\n')
  })

  it('refuses a manifest that pins a grid older than the floor this daemon can drive', async () => {
    const installed = installedGrid('0.3.47', key, true)
    const { bytes, root: archiveRoot } = buildArchive('0.3.35', key, 'grid')
    stubFetch(manifestFor('grid', key, '0.3.35', bytes, archiveRoot), bytes)

    const { ensureManagedGrid } = await load()

    expect(await ensureManagedGrid()).toBe(installed)
    expect(existsSync(join(runtimeDir, `grid-0.3.35-${key}`))).toBe(false)
    expect(readFileSync(join(runtimeDir, 'current-grid'), 'utf8').trim()).toBe(installed)
  })

  it('leaves a developer\'s HARNESS_GRID_BIN alone: nothing fetched, nothing laid down', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { ensureManagedGrid } = await load()
    process.env.HARNESS_GRID_BIN = '/somewhere/else/grid'

    expect(await ensureManagedGrid()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(existsSync(join(runtimeDir, 'current-grid'))).toBe(false)
  })

  it('clears the staging a process that is gone left behind, and leaves a running one\'s', async () => {
    // A core that exited mid-unpack (an update's handoff) left its staging, archive and partial tree.
    const gone = spawnSync('/usr/bin/true').pid!
    const left = join(runtimeDir, `.grid-staging-${gone}-1790000000000`)
    const running = join(runtimeDir, `.grid-staging-${process.pid}-1790000000001`)
    const other = join(runtimeDir, `.node-staging-${gone}-1790000000002`)
    for (const dir of [left, running, other]) {
      mkdirSync(join(dir, 'grid-0.3.47', 'bin'), { recursive: true })
      writeFileSync(join(dir, 'grid.tar.gz'), 'partial')
    }
    stubFetch(null)
    const { ensureManagedGrid } = await load()
    await ensureManagedGrid()
    expect(existsSync(left)).toBe(false)
    expect(existsSync(running)).toBe(true)
    // Each runtime sweeps its own.
    expect(existsSync(other)).toBe(true)
  })

  it('keeps the grid it has when the manifest is unreachable, and has nothing when it has nothing', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ENOTFOUND') })
    const { ensureManagedGrid } = await load()

    await expect(ensureManagedGrid()).resolves.toBeNull()

    const installed = installedGrid('0.3.47', key, true)
    await expect(ensureManagedGrid()).resolves.toBe(installed)
  })

  it('refuses an archive whose bytes do not match the manifest, and keeps the pointer where it was', async () => {
    const installed = installedGrid('0.3.46', key, true)
    const { bytes, root: archiveRoot } = buildArchive('0.3.47', key, 'grid')
    stubFetch(manifestFor('grid', key, '0.3.47', bytes, archiveRoot, { sha256: 'a'.repeat(64) }), bytes)

    const { ensureManagedGrid } = await load()

    expect(await ensureManagedGrid()).toBe(installed)
    expect(readFileSync(join(runtimeDir, 'current-grid'), 'utf8').trim()).toBe(installed)
    expect(existsSync(join(runtimeDir, `grid-0.3.47-${key}`))).toBe(false)
  })
})

describe('startGridPinRecheck', () => {
  const key = currentPlatformKey()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-grid-recheck-'))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    for (const dir of [runtimeDir, binDir, cliDir]) mkdirSync(dir, { recursive: true })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    for (const entry of readdirSync(runtimeDir)) {
      try { chmodSync(join(runtimeDir, entry, 'bin'), 0o755) } catch { /* not a runtime dir */ }
    }
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_METADATA_URL', 'ADAPTER_GRID_RUNTIME_METADATA_URL', 'HARNESS_GRID_BIN']) {
      delete process.env[key]
    }
  })

  /** A snapshot of everything under the runtime dir: names, sizes and times. */
  const tree = (): string[] => readdirSync(runtimeDir, { recursive: true, withFileTypes: true })
    .map((entry) => { const path = join(entry.parentPath, entry.name); const st = statSync(path); return `${path}:${st.size}:${st.mtimeMs}` })
    .sort()

  it('re-reads the pin every ten minutes, writes nothing while it matches, and a moved pin reaches the next grid call', async () => {
    const installed = installedGrid('0.3.47', key, true)
    const old = buildArchive('0.3.47', key, 'grid')
    stubFetch(manifestFor('grid', key, '0.3.47', old.bytes, old.root), old.bytes)
    const { ensureManagedGrid, startGridPinRecheck, GRID_PIN_RECHECK_MS } = await load()
    const { gridBinaryPath } = await import('./gridExec.js')
    let last: Promise<unknown> = Promise.resolve()
    const ensure = vi.fn(() => (last = ensureManagedGrid()))
    // The check, and the bookkeeping that frees the next one.
    const checked = async (): Promise<void> => { await last; await new Promise((resolve) => setImmediate(resolve)) }
    const stop = startGridPinRecheck({ ensure })
    const before = tree()

    expect(GRID_PIN_RECHECK_MS).toBe(10 * 60_000)
    vi.advanceTimersByTime(GRID_PIN_RECHECK_MS - 1)
    expect(ensure).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await checked()
    expect(ensure).toHaveBeenCalledOnce()
    expect(tree()).toEqual(before)
    expect(gridBinaryPath({})).toBe(installed)

    const next = buildArchive('0.3.49', key, 'grid')
    stubFetch(manifestFor('grid', key, '0.3.49', next.bytes, next.root), next.bytes)
    vi.advanceTimersByTime(GRID_PIN_RECHECK_MS)
    await checked()
    expect(gridBinaryPath({})).toBe(join(runtimeDir, `grid-0.3.49-${key}`, 'bin', 'grid'))
    stop()
    vi.advanceTimersByTime(GRID_PIN_RECHECK_MS * 3)
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('runs one check at a time: a slow one is not stacked on', async () => {
    const { startGridPinRecheck, GRID_PIN_RECHECK_MS } = await load()
    let release: () => void = () => {}
    const ensure = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const stop = startGridPinRecheck({ ensure })

    vi.advanceTimersByTime(GRID_PIN_RECHECK_MS * 3)
    expect(ensure).toHaveBeenCalledOnce()
    release()
    await new Promise((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(GRID_PIN_RECHECK_MS)
    expect(ensure).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('ensureLauncher', () => {
  const NODE = '/opt/harness/runtime/node-v22/bin/node'

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-launcher-'))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    for (const dir of [runtimeDir, binDir, cliDir]) mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_METADATA_URL']) {
      delete process.env[key]
    }
  })

  const launcherPath = () => join(binDir, 'harness')
  const cliPath = () => join(cliDir, 'cli.js')

  it('repairs the bare-node launcher install-cli.sh used to write', async () => {
    writeFileSync(launcherPath(), `#!/bin/sh\nexec node "${cliPath()}" "$@"\n`, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(readFileSync(launcherPath(), 'utf8')).toBe(`#!/bin/sh\nexec '${NODE}' '${cliPath()}' "$@"\n`)
  })

  it('repairs an absolute system-Node launcher from the public installer', async () => {
    writeFileSync(launcherPath(), `#!/bin/sh\nexec '/opt/homebrew/bin/node' '${cliPath()}' "$@"\n`, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(readFileSync(launcherPath(), 'utf8')).toContain(`exec '${NODE}'`)
    expect(readFileSync(launcherPath(), 'utf8')).not.toContain('homebrew')
  })

  // The pin is the promise that no release reaches this computer on its own. Repairing the
  // interpreter must not quietly revoke it.
  it('fixes a dev-pinned launcher without disarming the pin', async () => {
    const pinned = [
      '#!/bin/sh',
      '# Local dev install, PINNED with --no-updates (see scripts/install-cli.sh).',
      '# Self-update is off: no release will ever reach this computer on its own, not even a newer one.',
      'ADAPTER_UPDATE_DISABLE=true',
      'export ADAPTER_UPDATE_DISABLE',
      `exec node "${cliPath()}" "$@"`,
      '',
    ].join('\n')
    writeFileSync(launcherPath(), pinned, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    const out = readFileSync(launcherPath(), 'utf8')
    expect(out).toContain('ADAPTER_UPDATE_DISABLE=true')
    expect(out).toContain('export ADAPTER_UPDATE_DISABLE')
    expect(out).toContain('# Local dev install, PINNED with --no-updates (see scripts/install-cli.sh).')
    expect(out).toContain(`exec '${NODE}' '${cliPath()}' "$@"`)
    expect(out).not.toContain('exec node')
  })

  it('leaves a launcher that already points at the right Node untouched', async () => {
    const correct = `#!/bin/sh\nexec '${NODE}' '${cliPath()}' "$@"\n`
    writeFileSync(launcherPath(), correct, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(readFileSync(launcherPath(), 'utf8')).toBe(correct)
  })

  it('never touches a script it did not write', async () => {
    const foreign = '#!/bin/sh\nexec /usr/local/bin/somebody-elses-tool "$@"\n'
    writeFileSync(launcherPath(), foreign, { mode: 0o755 })

    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(readFileSync(launcherPath(), 'utf8')).toBe(foreign)
  })

  it('does not create a launcher where none exists', async () => {
    const { ensureLauncher } = await load()
    ensureLauncher(NODE)

    expect(existsSync(launcherPath())).toBe(false)
  })
})

describe('hn launcher migration', () => {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const cliPath = () => join(cliDir, 'cli.js')
  const harnessPath = () => join(binDir, 'harness')
  const hnPath = () => join(binDir, 'hn')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harness launcher's "))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    for (const dir of [runtimeDir, binDir, cliDir]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(cliDir, 'package.json'), '{"type":"module"}')
    writeFileSync(cliPath(), 'console.log(JSON.stringify({args:process.argv.slice(2),pin:process.env.ADAPTER_UPDATE_DISABLE}))')
    writeFileSync(harnessPath(), `#!/bin/sh\nexport ADAPTER_UPDATE_DISABLE=true\nexec ${quote(process.execPath)} ${quote(cliPath())} "$@"\n`, { mode: 0o755 })
  })

  afterEach(() => {
    chmodSync(binDir, 0o755)
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_METADATA_URL', 'ADAPTER_GRID_RUNTIME_METADATA_URL']) delete process.env[key]
  })

  it('upgrades an old install with a working hn command, preserving quoted arguments and its update pin', async () => {
    const { ensureHnLauncher } = await load()
    expect(ensureHnLauncher(cliPath())).toBe(true)
    const args = ['-L', 'hn-upgrade-unit', '--port', '19448', '--version', 'a b', "a'b", '$(false)']
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: root, PORT: '19448', HN_SOCKET_NAME: 'hn-upgrade-unit' }
    for (const key of ['TMUX', 'TMUX_PANE', 'HN_SOCKET']) delete childEnv[key]
    const result = JSON.parse(execFileSync(hnPath(), args, { env: childEnv, encoding: 'utf8' }))
    expect(result).toEqual({ args: ['tui', ...args], pin: 'true' })
    const inode = statSync(hnPath()).ino
    expect(ensureHnLauncher(cliPath())).toBe(false)
    expect(statSync(hnPath()).ino).toBe(inode)
    expect(readdirSync(binDir).sort()).toEqual(['harness', 'hn'])
  })

  it.each(['file', 'symlink', 'dangling symlink'])('preserves an existing hn %s', async (kind) => {
    const target = join(root, 'other-hn')
    if (kind !== 'dangling symlink') writeFileSync(target, 'another program')
    if (kind === 'file') writeFileSync(hnPath(), 'another program')
    else symlinkSync(target, hnPath())
    const { ensureHnLauncher } = await load()
    expect(ensureHnLauncher(cliPath())).toBe(false)
    if (kind === 'file') expect(readFileSync(hnPath(), 'utf8')).toBe('another program')
    else expect(readlinkSync(hnPath())).toBe(target)
    if (kind !== 'dangling symlink') expect(readFileSync(target, 'utf8')).toBe('another program')
    else expect(existsSync(target)).toBe(false)
  })

  it('does not migrate an installed copy while running a checkout or update canary', async () => {
    const { ensureHnLauncher } = await load()
    for (const other of [join(root, 'checkout', 'dist', 'cli.js'), join(cliDir, '.canary-test', 'cli.js')]) {
      mkdirSync(dirname(other), { recursive: true })
      writeFileSync(other, readFileSync(cliPath()))
      expect(ensureHnLauncher(other)).toBe(false)
      expect(existsSync(hnPath())).toBe(false)
    }
  })

  it('recognizes the installed bundle through a symlink', async () => {
    const alias = join(root, 'cli-link.js')
    symlinkSync(cliPath(), alias)
    const { ensureHnLauncher } = await load()
    expect(ensureHnLauncher(alias)).toBe(true)
  })

  it.each(['missing', 'foreign', 'not executable'])('leaves a %s harness launcher alone', async (kind) => {
    if (kind === 'missing') rmSync(harnessPath())
    else if (kind === 'foreign') writeFileSync(harnessPath(), '#!/bin/sh\nexec another-command "$@"\n')
    else chmodSync(harnessPath(), 0o644)
    const { ensureHnLauncher } = await load()
    expect(ensureHnLauncher(cliPath())).toBe(false)
    expect(existsSync(hnPath())).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('tolerates an unwritable bin directory', async () => {
    const { ensureHnLauncher } = await load()
    chmodSync(binDir, 0o555)
    expect(ensureHnLauncher(cliPath())).toBe(false)
    expect(existsSync(hnPath())).toBe(false)
  })
})
