/** Materialize one cold history on Open, before the unchanged control-identity check.
 * Codex compresses old rollouts while retaining their logical .jsonl path. Treating that path's
 * absence as a lost conversation blocked a retained harness even though search still showed it.
 * Nothing here runs during discovery, and the archive remains available after any failure. */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, createReadStream, createWriteStream, fstatSync, linkSync, lstatSync, openSync, unlinkSync, type BigIntStats } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as zlib from 'node:zlib'
import { sessionStoreOf } from './sessionStoreContracts.js'
import { transcriptEvidence } from './transcriptBindings.js'
import { NativeFiles } from './kit/nativeFiles.js'
import { nativeFileKey, verifyNativePathFacts } from './kit/nativePaths.js'
import { firstLine, nativeSessionMeta } from './kit/nativeHeader.js'
import { IdentityReadUnavailable } from './kit/identityScan.js'
import { nativeUnavailable } from './kit/nativeEvidence.js'
import { completeZstdFrames } from './kit/zstdFrames.js'
import type { AgentEngine } from './types.js'

// All shipped runtimes have Node's streaming zstd decoder. Feature detection keeps older source
// installations usable for plain histories and gives compressed ones an actionable refusal.
const nativeZstd = zlib as typeof zlib & {
  createZstdDecompress?: (options: { params: Record<number, number> }) => Transform
}
const version = (info: BigIntStats) => `${nativeFileKey(info)}:${info.mode}:${info.uid}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const exists = (path: string): boolean => {
  try { lstatSync(path); return true } catch (error) { if (missing(error)) return false; throw error }
}
const defaultLimits = { timeoutMs: 30_000, maxBytes: 4 * 1024 ** 3 }

/** Caller holds the stopped harness's resume reservation, has ruled out its previous writer, and
 * checks this returned path with controlTranscriptEvidence before allocating an engine. */
export async function materializeResumeTranscript(engine: AgentEngine, sessionId: string, path: string,
  profile: string | undefined, current: () => boolean, limits = defaultLimits,
): Promise<string> {
  const store = sessionStoreOf(engine), compression = store?.compression, first = store?.first
  if (!compression || !first) return path
  const plain = path.endsWith(compression.suffix) ? path.slice(0, -compression.suffix.length) : path
  if (!plain.endsWith(store.byId.suffix) || exists(plain) || !exists(plain + compression.suffix)) return plain
  if (!nativeZstd.createZstdDecompress) return nativeUnavailable('opening compressed history requires the current Harness runtime (Node 22.15 or newer)')

  let input: number | undefined, output: number | undefined, temporary: string | undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs)
  timer.unref()
  try {
    // Both paths must belong to the declared home; a dangling leaf alias is never an absent file.
    const destination = transcriptEvidence(engine, plain, profile, true)
    if (!destination.valid) return nativeUnavailable('the compressed conversation destination is outside its session home')
    destination.verify()
    const parent = destination.files.locate(dirname(plain))!
    const target = join(parent.path, basename(plain)), archive = target + compression.suffix
    const source = transcriptEvidence(engine, archive, profile)
    if (!source.valid) return nativeUnavailable('the compressed conversation is outside its session home')
    const location = source.files.file(archive)!
    // Parent aliases are checked above. A leaf alias could borrow a different archive's authority.
    if (location.path !== archive || !lstatSync(archive).isFile()) return nativeUnavailable('the compressed conversation must be a regular file beside its destination')
    source.verify()
    const facts = source.files.paths.snapshot()
    const parentFacts = destination.files.paths.snapshot().filter(fact => fact.path !== target && fact.path !== plain)
    const before = version(location.info)
    input = openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (version(fstatSync(input, { bigint: true })) !== before) return nativeUnavailable('the compressed conversation changed before reading')
    if (!current()) return nativeUnavailable('the resume was cancelled before restoring its conversation')
    const staging = join(parent.path, `.harness-restore-${randomUUID()}.tmp`)
    output = openSync(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    temporary = staging
    const temporaryKey = nativeFileKey(fstatSync(output, { bigint: true }))
    let total = 0, header = Buffer.alloc(0), verified = false
    const inspect = new Transform({ transform(chunk: Buffer, _encoding, done) {
      try {
        if (!current()) return nativeUnavailable('the resume was cancelled while restoring its conversation')
        total += chunk.length
        if (total > limits.maxBytes) return nativeUnavailable('the compressed conversation exceeds the restore size limit')
        if (!verified) {
          header = Buffer.concat([header, chunk.subarray(0, Math.max(0, first.maxBytes + 1 - header.length))])
          const complete = header.subarray(0, header.lastIndexOf(10) + 1)
          if (complete.toString('utf8').trim() || header.length > first.maxBytes) {
            const meta = nativeSessionMeta(firstLine(header, first.maxBytes), first)
            if (meta.id !== sessionId || meta.isSubagent) return nativeUnavailable('the compressed transcript names a different or delegated conversation')
            verified = true
            header = Buffer.alloc(0)
          }
        }
        done(null, chunk)
      } catch (error) { done(error as Error) }
    } })
    // Bound zstd's window to 64 MiB; the file itself is streamed to disk, never buffered in core.
    const decoder = nativeZstd.createZstdDecompress({ params: { 100: 26 } })
    const reader = createReadStream(archive, { fd: input, autoClose: true })
    input = undefined // The streams own their descriptors on success, abort and decoder failure.
    const writer = createWriteStream(temporary, { fd: output, autoClose: true, flush: true })
    output = undefined
    await pipeline(reader, completeZstdFrames(), decoder, inspect, writer, { signal: controller.signal })
    if (!verified) {
      const meta = nativeSessionMeta(firstLine(header, first.maxBytes), first)
      if (meta.id !== sessionId || meta.isSubagent) return nativeUnavailable('the compressed transcript names a different or delegated conversation')
    }
    if (!current()) return nativeUnavailable('the resume was cancelled before publishing its conversation')
    verifyNativePathFacts(facts)
    verifyNativePathFacts(parentFacts)
    // Re-earn the home's evidence after the asynchronous decode; its old work budget has expired.
    const fresh = transcriptEvidence(engine, archive, profile)
    if (!fresh.valid || version(fresh.files.file(archive)!.info) !== before) return nativeUnavailable('the compressed conversation changed during restoration')
    fresh.verify()
    const staged = new NativeFiles(), metadata = staged.header(temporary, first)
    if (nativeFileKey(staged.file(temporary)!.info) !== temporaryKey || metadata.id !== sessionId || metadata.isSubagent) {
      return nativeUnavailable('the restored conversation changed before publication')
    }
    staged.verify(temporary)
    // link is atomic and cannot overwrite a file another reader or Codex has already restored.
    try { linkSync(temporary, target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // The caller earns fresh identity from the winner, which may be foreign or unreadable.
    }
    return plain
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    // Decoder and filesystem errors can contain paths or conversation bytes. Keep them private.
    return nativeUnavailable('the compressed conversation could not be restored completely; its archive has been retained')
  } finally {
    clearTimeout(timer)
    if (input !== undefined) closeSync(input)
    if (output !== undefined) closeSync(output)
    if (temporary !== undefined) unlinkSync(temporary)
  }
}
