import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { platform } from 'node:os'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import { env } from '../config/env.js'
import { psEnv } from './childLocale.js'

declare const __DARWIN_PROCESS_IMAGES__: string | undefined

export interface ProcessImageArtifact {
  schema: 1
  sha256: string
  size: number
  base64: string
}

export interface NativeProcessImage {
  path: string
  startMarker: string
}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
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

function artifactBytes(artifact: ProcessImageArtifact): Buffer {
  if (artifact.schema !== 1 || !/^[0-9a-f]{64}$/.test(artifact.sha256)
    || !Number.isInteger(artifact.size) || artifact.size < 32 || artifact.size > MAX_ARTIFACT_BYTES
    || typeof artifact.base64 !== 'string' || artifact.base64.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4) {
    throw new Error('Invalid native process-image artifact')
  }
  const bytes = Buffer.from(artifact.base64, 'base64')
  if (bytes.length !== artifact.size || bytes.toString('base64') !== artifact.base64
    || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error('Native process-image artifact checksum mismatch')
  }
  return bytes
}

async function privateDirectory(path: string, recursive = false): Promise<void> {
  try { await mkdir(path, { recursive, mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o022) !== 0) throw new Error('Unsafe native helper directory')
}

async function verifyFile(path: string, artifact: ProcessImageArtifact): Promise<boolean> {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0
      || (info.mode & 0o100) === 0 || info.size !== artifact.size) return false
    const bytes = await file.readFile()
    return createHash('sha256').update(bytes).digest('hex') === artifact.sha256
  } catch { return false }
  finally { await file?.close() }
}

/** Extract only bytes pinned by the CLI bundle, never a network download or a
 * path supplied by terminal output. Creation is atomic across multiple daemons.
 * This is an optional optimization: callers preserve their ordinary reader on
 * every failure. No account state, sessions or existing files are replaced. */
export async function prepareProcessImageHelper(
  artifact: ProcessImageArtifact, runtimeDirectory: string,
): Promise<string | null> {
  let temporary: string | undefined
  try {
    const bytes = artifactBytes(artifact)
    await privateDirectory(runtimeDirectory, true)
    const directory = join(runtimeDirectory, 'process-images')
    await privateDirectory(directory)
    const target = join(directory, artifact.sha256)
    if (await verifyFile(target, artifact)) return target
    try { await lstat(target); return null }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // A bad existing target stays untouched and cannot be executed. link()
    // below is create-only, so concurrent writers cannot replace one another.
    temporary = join(directory, `.${artifact.sha256}-${randomUUID()}`)
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o500)
    try { await file.writeFile(bytes) }
    finally { await file.close() }
    try { await link(temporary, target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return await verifyFile(target, artifact) ? target : null
  } catch { return null }
  finally { if (temporary) await unlink(temporary).catch(() => {}) }
}

/** Keep complete, uniquely identified records only. A timeout may leave usable
 * records before a truncated line, exactly as with the ordinary image reader. */
export function parseNativeProcessImages(
  stdout: string, requested: ReadonlySet<number>,
): Map<number, NativeProcessImage> {
  const images = new Map<number, NativeProcessImage>()
  const lines = stdout.slice(0, stdout.lastIndexOf('\n') + 1).split('\n')
  try {
    const header = JSON.parse(lines.shift() ?? '')
    if (header?.schema !== 1 || header?.mode !== 'paths') return images
  } catch { return images }
  const seen = new Set<number>()
  for (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || !validPid(row.pid) || !requested.has(row.pid)) continue
    if (seen.has(row.pid)) { images.delete(row.pid); continue }
    seen.add(row.pid)
    if (row.unavailable === true || typeof row.imageHex !== 'string'
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
  return images
}

async function bundledHelper(): Promise<{ path: string; key: string } | null> {
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
  if ((retryAfter.get(key) ?? 0) > performance.now()) return null
  let helper = prepared.get(key)
  if (!helper) {
    helper = prepareProcessImageHelper(artifact, env.ADAPTER_RUNTIME_DIR)
      .then(path => {
        if (!path) {
          prepared.delete(key)
          retryAfter.set(key, performance.now() + 60_000)
        }
        return path
      })
    prepared.set(key, helper)
  }
  const path = await helper
  return path ? { path, key } : null
}

/** A fresh kernel query on every call. Only the immutable executable's
 * preparation is shared; no PID, image or completed process result is cached. */
export async function nativeProcessImages(
  pids: readonly number[], timeout: number,
): Promise<Map<number, NativeProcessImage>> {
  const empty = new Map<number, NativeProcessImage>()
  if (platform() !== 'darwin' || !pids.length || pids.length > MAX_PIDS
    || !pids.every(validPid) || !Number.isFinite(timeout) || timeout <= 0) return empty
  const deadline = performance.now() + timeout
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // A slow cache filesystem must not block discovery or start a late helper.
    const helper = await Promise.race([bundledHelper(), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeout)
    })])
    const remaining = Math.floor(deadline - performance.now())
    if (!helper || remaining <= 0) return empty
    return await new Promise(resolve => {
      execFile(helper.path, ['--paths', ...new Set(pids).values()].map(String),
        { timeout: remaining, maxBuffer: 4 * 1024 * 1024, env: psEnv() }, (error, stdout) => {
          const images = parseNativeProcessImages(stdout ?? '', new Set(pids))
          if (error && !images.size) {
            // A missing/blocked helper must not become a failed spawn every
            // reconcile. Retry preparation later; ordinary discovery continues.
            prepared.delete(helper.key)
            retryAfter.set(helper.key, performance.now() + 60_000)
          }
          resolve(images)
        })
    })
  } catch { return empty }
  finally { if (timer) clearTimeout(timer) }
}
