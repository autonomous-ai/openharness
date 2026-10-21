/**
 * Delivery of a promoted PTY payload (six files in one zip): decide whether one is wanted, download and
 * verify it, unpack it beside the live install and prove it runs. Nothing here calls a Windows API, so it
 * is tested on every OS; only the default unzip tool differs by platform.
 */
import { execFile } from 'child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SUPPORTED_PTY_PROTOCOLS } from '../ptyHost/protocol.js'
import {
  DigestMismatchError, MANIFEST_LIMITS, downloadVerified, fetchWithin, isLocalDevBuild, semverGt,
  type FileRef, type TransferLimits,
} from '../selfUpdate.js'

/** The files a payload carries, and the only ones it may carry. */
export const PTY_PAYLOAD_FILES: readonly string[] = [
  'harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe',
]

/** Each canary run must answer within this; a hung binary must not hold the updater. */
const CANARY_TIMEOUT_MS = 5_000

export interface PtyEntry { version: string; url: string; sha256: string; size: number }

/** The payload manifest sits beside the CLI one, so both follow the same override of the update URL. */
export function ptyManifestUrl(cliManifestUrl: string): string {
  const tail = 'cli/metadata.json'
  if (!cliManifestUrl.endsWith(`/${tail}`)) throw new Error(`not a CLI manifest url: ${cliManifestUrl}`)
  return `${cliManifestUrl.slice(0, -tail.length)}pty/metadata.json`
}

export function ptyPlatformKey(arch: string = process.arch): 'win32-x64' | 'win32-arm64' | null {
  if (arch === 'x64') return 'win32-x64'
  if (arch === 'arm64') return 'win32-arm64'
  return null
}

/** Fetch the manifest and return this platform's entry, or null when it is absent or malformed. The same
 *  checks the CLI manifest gets: an https url, a sha256 hex digest and a positive integer size. */
export async function fetchPtyEntry(url: string, key: string, limits: TransferLimits = MANIFEST_LIMITS): Promise<PtyEntry | null> {
  const res = await fetchWithin(url, limits)
  if (!res.ok) return null
  const json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
  const e = json?.[key] as Partial<PtyEntry> | undefined
  if (!e || typeof e.version !== 'string' || !e.version) return null
  if (typeof e.url !== 'string' || !/^https:\/\//.test(e.url)) return null
  if (typeof e.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(e.sha256)) return null
  if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size <= 0) return null
  return { version: e.version, url: e.url, sha256: e.sha256, size: e.size }
}

/** A machine with no installed host takes any entry; a dev CLI never updates, as for the CLI itself. */
export function ptyUpdateWanted(entry: PtyEntry, installed: { pty: string | null; cli: string }, rejected: readonly string[]): boolean {
  if (isLocalDevBuild(installed.cli)) return false
  if (rejected.includes(entry.version)) return false
  return installed.pty === null || semverGt(entry.version, installed.pty)
}

export interface PreparedPty { version: string; staging: string; protocol: number; features: string[] }

export class PtyPayloadRefused extends Error {
  constructor(readonly reason: string) { super(`pty payload refused: ${reason}`) }
}

export interface PreparePtyDeps {
  download: (ref: FileRef) => Promise<Buffer>
  unzip: (zip: Buffer, dest: string) => Promise<void>
  /** Run `<binary> version` and return its one parsed JSON line. */
  probe: (binary: string) => Promise<unknown>
}

/** `tar.exe` is the bsdtar Windows ships (install.ps1's Expand-HarnessZip falls back to it too); `unzip`
 *  stands in elsewhere so the tests can run. The zip goes through a file inside `dest`, removed after. */
async function unzipWithTool(zip: Buffer, dest: string): Promise<void> {
  const file = join(dest, '.payload.zip')
  writeFileSync(file, zip)
  const [cmd, args] = process.platform === 'win32'
    ? ['tar.exe', ['-xf', file, '-C', dest]] as const
    : ['unzip', ['-q', '-o', file, '-d', dest]] as const
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(cmd, [...args], { windowsHide: true, timeout: 60_000 }, (err) => (err ? reject(err) : resolve()))
    })
  } finally {
    rmSync(file, { force: true })
  }
}

/** The line a binary prints for `version`, parsed. Argument array, never a shell. */
export function probeVersionLine(binary: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['version'], { timeout: CANARY_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err)
      try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? '')) } catch (e) { reject(e) }
    })
  })
}

const DEFAULT_DEPS: PreparePtyDeps = { download: (ref) => downloadVerified(ref), unzip: unzipWithTool, probe: probeVersionLine }

/** A probe that never answers must not stall the updater, whatever the injected probe does. */
async function canary(probe: PreparePtyDeps['probe'], binary: string): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${CANARY_TIMEOUT_MS} ms`)), CANARY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([probe(binary), hung])
  } catch (e) {
    throw new PtyPayloadRefused(`${binary.split(/[\\/]/).pop()} version failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Download, verify, unpack and canary a payload. On any failure the staging folder is removed. */
export async function preparePtyPayload(entry: PtyEntry, runtimeDir: string, deps: Partial<PreparePtyDeps> = {}): Promise<PreparedPty> {
  const d = { ...DEFAULT_DEPS, ...deps }
  const staging = join(runtimeDir, 'pty', `.staging-${process.pid}-${Date.now()}`)
  try {
    let zip: Buffer
    try {
      zip = await d.download({ url: entry.url, sha256: entry.sha256, size: entry.size })
    } catch (e) {
      if (e instanceof DigestMismatchError) throw new PtyPayloadRefused(`digest mismatch: ${e.message}`)
      throw e
    }
    mkdirSync(staging, { recursive: true })
    await d.unzip(zip, staging)
    const found = readdirSync(staging).sort()
    const want = [...PTY_PAYLOAD_FILES].sort()
    if (found.length !== want.length || found.some((f, i) => f !== want[i])) {
      throw new PtyPayloadRefused(`payload holds [${found.join(', ')}], expected [${want.join(', ')}]`)
    }
    const host = await canary(d.probe, join(staging, 'harness-pty.exe'))
    if (!host || typeof host !== 'object') throw new PtyPayloadRefused('harness-pty version is not a JSON object')
    const h = host as { version?: unknown; protocol?: unknown; features?: unknown }
    if (h.version !== entry.version) throw new PtyPayloadRefused(`harness-pty reports version ${String(h.version)}, expected ${entry.version}`)
    if (typeof h.protocol !== 'number' || !SUPPORTED_PTY_PROTOCOLS.includes(h.protocol)) {
      throw new PtyPayloadRefused(`harness-pty speaks unsupported protocol ${String(h.protocol)}`)
    }
    if (!Array.isArray(h.features) || !h.features.every((f) => typeof f === 'string')) {
      throw new PtyPayloadRefused('harness-pty reports no features array')
    }
    const serial = await canary(d.probe, join(staging, 'harness-serial.exe'))
    const sv = (serial as { version?: unknown } | null)?.version
    if (sv !== entry.version) throw new PtyPayloadRefused(`harness-serial reports version ${String(sv)}, expected ${entry.version}`)
    return { version: entry.version, staging, protocol: h.protocol, features: h.features as string[] }
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    if (e instanceof PtyPayloadRefused) throw e
    throw new PtyPayloadRefused(e instanceof Error ? e.message : String(e))
  }
}
