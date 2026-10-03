/** The managed hn binary. Replace its pathname atomically; running clients keep their old inode. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { withSpawnLock } from '../lib/daemonSpawnLock.js'
import { semverGt } from '../lib/selfUpdate.js'
import { installedTuiPath } from './paths.js'
import { isManagedHnLauncher } from './launcher.js'
export { installedTuiPath } from './paths.js'

export const TUI_MANIFEST_URL = process.env.HARNESS_TUI_MANIFEST_URL
  || 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/tui/metadata.json'
const run = promisify(execFile)
const releaseVersion = /^\d+\.\d+\.\d+$/
type Log = (line: string) => void
type Release = { version: string; url: string; sha256: string; size?: number }

/** `darwin-arm64`, `linux-x64`, … — the key a release publishes each build under. */
export function platformKey(platform = process.platform, arch = process.arch): string | null {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  return os && cpu ? `${os}-${cpu}` : null
}

async function binaryVersion(binary: string, signal?: AbortSignal): Promise<string | null> {
  const result = await run(binary, ['--version'], { timeout: 5_000, maxBuffer: 4096, signal, env: { ...process.env, HN_AS_TMUX: '0' } })
  // A prerelease, development label or unrelated program is not a managed release.
  return /^hn (\d+\.\d+\.\d+)(?: \(tmux [^\r\n]+\))?$/.exec(result.stdout.trim())?.[1] ?? null
}

async function managedVersion(signal?: AbortSignal): Promise<string | null> {
  if (process.env.HARNESS_TUI_BIN) return null
  try {
    // Never replace a custom binary symlink. A managed launcher with a missing binary is repaired below.
    if (!lstatSync(installedTuiPath()).isFile()) return null
    return await binaryVersion(installedTuiPath(), signal)
  } catch (error) {
    signal?.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return isManagedHnLauncher() ? '0.0.0' : null
    throw error
  }
}

function downloadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
  } catch { return false }
}

async function publishedRelease(key: string, signal?: AbortSignal): Promise<Release> {
  const response = await fetch(TUI_MANIFEST_URL, { signal: timeoutSignal(20_000, signal) })
  if (!response.ok) throw new Error(`Could not fetch the hn release manifest (${response.status}).`)
  const meta = await response.json() as { version?: unknown; builds?: Record<string, Partial<Release>> } | null
  const build = meta?.builds?.[key]
  if (typeof meta?.version !== 'string' || !releaseVersion.test(meta.version)
    || !downloadUrl(build?.url) || typeof build?.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(build.sha256)
    || (build.size !== undefined && (!Number.isSafeInteger(build.size) || build.size <= 0))) {
    throw new Error(`No valid hn release for ${key} in the manifest.`)
  }
  return { version: meta.version, url: build.url, sha256: build.sha256, size: build.size }
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

// Serialize this process too: the shared daemon spawn lock is intentionally re-entrant. Other CLI
// processes take that lock only for the final version check and rename, never for the download.
let pending: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = pending.then(fn, fn)
  pending = next.catch(() => {})
  return next
}

async function replaceTui(force: boolean, log: Log, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const key = platformKey()
  if (!key) {
    if (force) throw new Error(`No harness tui build for ${process.platform}/${process.arch}.`)
    return false
  }
  const current = force ? null : await managedVersion(signal)
  if (!force && current === null) return false
  const release = await publishedRelease(key, signal)
  if (current && !semverGt(release.version, current)) return false
  log(`  Downloading hn ${release.version} for ${key}…`)
  const response = await fetch(release.url, { signal: timeoutSignal(120_000, signal) })
  if (!response.ok) throw new Error(`hn download failed (${response.status}).`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== release.sha256.toLowerCase()
    || (release.size !== undefined && bytes.length !== release.size)) {
    throw new Error('The hn download does not match its published checksum or size; nothing was installed.')
  }
  signal?.throwIfAborted()
  const target = installedTuiPath()
  mkdirSync(dirname(target), { recursive: true })
  const staging = mkdtempSync(join(dirname(target), '.hn-update-'))
  const binary = join(staging, 'harness-tui')
  try {
    writeFileSync(binary, bytes, { mode: 0o755 })
    chmodSync(binary, 0o755)
    if (await binaryVersion(binary, signal) !== release.version) {
      throw new Error('The hn download failed its version check; nothing was installed.')
    }
    return await withSpawnLock('update', async () => {
      // A newer release or an explicit override may have landed while downloading. Check again
      // under the same lock used by `harness update` and `harness tui --install`.
      if (!force) {
        const latest = await managedVersion(signal)
        if (latest === null || !semverGt(release.version, latest)) return false
      }
      signal?.throwIfAborted()
      renameSync(binary, target)
      log(`  ✓ Installed hn ${release.version}; reopen hn to use it.`)
      return true
    }, force ? {} : { waitMs: 0 })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Explicit install (also the first launch): allowed to replace an older, newer or broken binary. */
export async function installTui(log: Log): Promise<string> {
  await serialized(() => replaceTui(true, log))
  return installedTuiPath()
}

/** Upgrade an existing managed release only. No downgrades, overrides or process restarts. */
export function updateTui(log: Log = () => {}, signal?: AbortSignal): Promise<boolean> {
  return serialized(() => replaceTui(false, log, signal))
}
