import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { TextDecoder } from 'node:util'
import { env } from '../config/env.js'
import { psEnv } from './childLocale.js'
import { prepareProcessImageHelper, type ProcessImageArtifact } from './nativeProcessImageArtifact.js'
export { prepareProcessImageHelper, type ProcessImageArtifact } from './nativeProcessImageArtifact.js'

declare const __DARWIN_PROCESS_IMAGES__: string | undefined

export interface NativeProcessImage {
  path: string
  startMarker: string
}

const MAX_PATH_BYTES = 4096
const MAX_PIDS = 4096
const utf8 = new TextDecoder('utf-8', { fatal: true })
const prepared = new Map<string, Promise<string | null>>()
const retryAfter = new Map<string, number>()
let artifactSource: string | undefined
let artifactValue: ProcessImageArtifact | null = null

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff
}

/** Keep complete, unique images and unavailable PIDs. A timeout may leave usable
 * records before a truncated line, exactly as with the ordinary image reader. */
export function parseNativeProcessImages(
  stdout: string, requested: ReadonlySet<number>,
): { images: Map<number, NativeProcessImage>; unavailable: Set<number> } {
  const images = new Map<number, NativeProcessImage>()
  const unavailable = new Set<number>()
  const lines = stdout.slice(0, stdout.lastIndexOf('\n') + 1).split('\n')
  try {
    const header = JSON.parse(lines.shift() ?? '')
    if (header?.schema !== 1 || header?.mode !== 'paths') return { images, unavailable }
  } catch { return { images, unavailable } }
  const seen = new Set<number>()
  for (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || !validPid(row.pid) || !requested.has(row.pid)) continue
    if (seen.has(row.pid)) { images.delete(row.pid); unavailable.delete(row.pid); continue }
    seen.add(row.pid)
    if (row.unavailable === true) { unavailable.add(row.pid); continue }
    if (typeof row.imageHex !== 'string'
      || row.imageHex.length < 2 || row.imageHex.length >= MAX_PATH_BYTES * 2
      || row.imageHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(row.imageHex)
      || typeof row.startMarker !== 'string'
      || !/^\w{3} \w{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(row.startMarker)
      || !Number.isSafeInteger(row.startSeconds) || row.startSeconds <= 0
      || !Number.isInteger(row.startMicros) || row.startMicros < 0 || row.startMicros >= 1_000_000) continue
    try {
      const path = utf8.decode(Buffer.from(row.imageHex, 'hex'))
      if (path.startsWith('/') && !path.includes('\0')) images.set(row.pid, { path, startMarker: row.startMarker })
    } catch { /* Invalid filesystem bytes cannot identify a JS string path. Fall back. */ }
  }
  return { images, unavailable }
}

export async function bundledProcessImageHelper(options: { retryUnavailable?: boolean } = {}): Promise<{ path: string; key: string } | null> {
  const source = typeof __DARWIN_PROCESS_IMAGES__ === 'undefined' ? undefined : __DARWIN_PROCESS_IMAGES__
  if (typeof source !== 'string') return null
  if (source !== artifactSource) {
    artifactSource = source
    artifactValue = null
    try { artifactValue = JSON.parse(artifactSource) } catch { /* Optional asset. */ }
  }
  const artifact = artifactValue
  if (!artifact || typeof artifact.sha256 !== 'string') return null
  const key = `${env.ADAPTER_RUNTIME_DIR}\0${artifact.sha256}`
  // Optional discovery backs off failed probes. Control must confirm recovery on its own
  // deadline: its healthy owner may be unrelated to the failed discovery request.
  if (!options.retryUnavailable && (retryAfter.get(key) ?? 0) > performance.now()) return null
  let helper = prepared.get(key)
  if (!helper) {
    helper = prepareProcessImageHelper(artifact, env.ADAPTER_RUNTIME_DIR)
      .then(path => {
        if (!path) {
          prepared.delete(key)
          retryAfter.set(key, performance.now() + 60_000)
        } else retryAfter.delete(key)
        return path
      })
    prepared.set(key, helper)
  }
  const path = await helper
  return path ? { path, key } : null
}

/** An evicted extracted file can be recreated from pinned bundle bytes. This forgets
 * preparation only; no process result is cached or made available by a spawn failure. */
export function invalidateProcessImageHelper(key: string, delay = 0): void {
  prepared.delete(key)
  if (delay) retryAfter.set(key, performance.now() + delay)
  else retryAfter.delete(key)
}

/** A fresh kernel query on every call. Only the immutable executable's
 * preparation is shared; neither images nor unavailable PID results are cached. */
export async function nativeProcessImages(
  pids: readonly number[], timeout: number,
): Promise<{ images: Map<number, NativeProcessImage>; unavailable: Set<number> }> {
  const empty = { images: new Map<number, NativeProcessImage>(), unavailable: new Set<number>() }
  if (platform() !== 'darwin' || !pids.length || pids.length > MAX_PIDS
    || !pids.every(validPid) || !Number.isFinite(timeout) || timeout <= 0) return empty
  const deadline = performance.now() + timeout
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // A slow cache filesystem must not block discovery or start a late helper.
    const helper = await Promise.race([bundledProcessImageHelper(), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeout)
    })])
    const remaining = Math.floor(deadline - performance.now())
    if (!helper || remaining <= 0) return empty
    return await new Promise(resolve => {
      execFile(helper.path, ['--paths', ...new Set(pids).values()].map(String),
        { timeout: remaining, maxBuffer: 4 * 1024 * 1024, env: psEnv() }, (error, stdout) => {
          const result = parseNativeProcessImages(stdout ?? '', new Set(pids))
          if (error && !result.images.size) {
            // A missing/blocked helper must not become a failed spawn every
            // reconcile. Retry preparation later; ordinary discovery continues.
            invalidateProcessImageHelper(helper.key, 60_000)
          }
          resolve(result)
        })
    })
  } catch { return empty }
  finally { if (timer) clearTimeout(timer) }
}
