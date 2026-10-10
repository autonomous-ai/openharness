/** Recoverable publication of a bounded preparation. Receipts never authorize guessed completion. */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { NativeFiles } from '../engines/kit/nativeFiles.js'
import { nativeFileKey, verifyNativePathFacts, type NativePathFact } from '../engines/kit/nativePaths.js'
import { HandoffError, handoffBaseName, handoffExcludeText, handoffHash, handoffIntentHash,
  type HandoffOutcome, type PreparedHandoff } from './handoffAuthority.js'
import { readHandoffFile } from './handoffFiles.js'
import { handoffRoute, handoffShape, validateHandoff } from './handoffValidation.js'

const MAX_RECEIPT_BYTES = 20 * 1024 * 1024
const publications = new Map<string, symbol>()
const held = (): never => { throw new HandoffError('HANDOFF_UNAVAILABLE') }
type Stage = { path: string; key: string }
type Receipt = { version: 1; fingerprint: string; prepared: PreparedHandoff;
  outputs: Array<Stage | null>; exclude: Stage | null; destination: NativePathFact[] | null;
  ignore: { key: string; route: NativePathFact[] } | null; committed: boolean }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
function exists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) { if (missing(error)) return false; throw error }
}
function sync(path: string, directory = false): void {
  const files = new NativeFiles(), location = files.locate(path)!
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0))
  try {
    const info = fstatSync(fd, { bigint: true })
    if (nativeFileKey(info) !== nativeFileKey(location.info)
      || (directory ? !info.isDirectory() : !info.isFile())) return held()
    fsyncSync(fd); files.verify()
  } finally { closeSync(fd) }
}
function createFile(path: string, text: string): Stage {
  const route = new NativeFiles(); route.locate(dirname(path))
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const opened = fstatSync(fd, { bigint: true })
    route.verify()
    if (!opened.isFile() || opened.nlink !== 1n || nativeFileKey(lstatSync(path, { bigint: true })) !== nativeFileKey(opened)) return held()
    writeFileSync(fd, text); fsyncSync(fd); route.verify()
    if (nativeFileKey(lstatSync(path, { bigint: true })) !== nativeFileKey(opened)) return held()
    return { path, key: nativeFileKey(opened) }
  }
  finally { closeSync(fd) }
}
function directory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = lstatSync(path)
  if (!info.isDirectory() || (info.mode & 0o022) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()) held()
  // Repeat on recovery: an earlier mkdir may have succeeded while its parent fsync failed.
  sync(path, true); sync(dirname(path), true)
}

/** A durable reservation stores the complete redacted preparation before any project write.
 * Stages are recorded only after their exact bytes are durable. An incomplete unrecorded stage is
 * left untouched, and retry creates a fresh one. No existing public file is adopted without proof. */
export async function publishHandoff(directoryPath: string, candidate: PreparedHandoff,
  verify: (prepared: PreparedHandoff, reserved: boolean) => void,
  checkRequest: () => void,
): Promise<HandoffOutcome> {
  const token = Symbol(), locks: string[] = []
  try {
    verify(candidate, false)
    const id = handoffHash(JSON.stringify([candidate.request.agentId, candidate.request.changeId]))
    const keys = [`project:${candidate.project.fileKey}`, `receipt:${directoryPath}/${id}`]
    if (candidate.git.exclude) {
      const parent = new NativeFiles().locate(dirname(candidate.git.exclude))!
      keys.push(`exclude:${nativeFileKey(parent.info)}:${basename(candidate.git.exclude)}`)
    }
    if (keys.some(key => publications.has(key))) throw new HandoffError('BUSY')
    for (const key of keys) { publications.set(key, token); locks.push(key) }
    const fingerprint = handoffIntentHash(candidate)
    directory(dirname(directoryPath)); directory(directoryPath)
    const receiptFolders = new NativeFiles(); directoryPath = receiptFolders.locate(directoryPath)!.path
    const receiptRoute = receiptFolders.paths.snapshot()
    const receiptPath = join(directoryPath, `${id}.json`)
    let previous = readHandoffFile(receiptPath, MAX_RECEIPT_BYTES, true)
    let receipt: Receipt
    if (previous.text !== null) {
      receipt = JSON.parse(previous.text) as Receipt
      if (!handoffShape(receipt, ['version', 'fingerprint', 'prepared', 'outputs', 'exclude', 'destination', 'ignore', 'committed'])) return held()
      validateHandoff(receipt.prepared)
      if (receipt.version !== 1 || typeof receipt.committed !== 'boolean'
        || !Array.isArray(receipt.outputs) || receipt.outputs.length !== 2
        || receipt.fingerprint !== handoffIntentHash(receipt.prepared)
        || !(receipt.destination === null || handoffRoute(receipt.destination))
        || !(receipt.ignore === null || handoffShape(receipt.ignore, ['key', 'route'])
          && typeof receipt.ignore.key === 'string' && receipt.ignore.key.length <= 128 && handoffRoute(receipt.ignore.route))) return held()
      if (receipt.fingerprint !== fingerprint) throw new HandoffError('CHANGE_CONFLICT')
    } else receipt = { version: 1, fingerprint, prepared: candidate, outputs: [null, null],
      exclude: null, destination: null, ignore: null, committed: false }
    const prepared = receipt.prepared
    // A durable private reservation owns the immutable, verified snapshot, even if publication
    // was interrupted before commit. Current native identity remains mandatory on every retry.
    verify(prepared, previous.text !== null)
    const cwd = prepared.project.path, folder = join(cwd, '.harness', 'handoff')
    const base = handoffBaseName(prepared.request.agentId, prepared.request.changeId)
    const outputs = prepared.documents ? [
      { path: join(folder, `${base}.transcript.md`), text: prepared.documents.transcript },
      { path: join(folder, `${base}.md`), text: prepared.documents.markdown },
    ] : []
    const checkStage = (stage: Stage | null, parent: string): void => {
      if (stage !== null && (!handoffShape(stage, ['path', 'key']) || typeof stage.key !== 'string' || stage.key.length > 128
        || typeof stage.path !== 'string' || dirname(stage.path) !== parent
        || !stage.path.startsWith(join(parent, `.${id}.`)) || !stage.path.endsWith('.stage'))) return held()
    }
    receipt.outputs.forEach(stage => checkStage(stage, folder))
    checkStage(receipt.exclude, prepared.exclude ? dirname(prepared.exclude.path) : '')
    if (!prepared.documents && (receipt.outputs.some(Boolean) || receipt.exclude || receipt.destination || receipt.ignore)) return held()
    const receiptFence = (): void => {
      verifyNativePathFacts(receiptRoute)
      const current = readHandoffFile(receiptPath, MAX_RECEIPT_BYTES, true)
      if (current.key !== previous.key || current.version !== previous.version || current.text !== previous.text) return held()
    }
    const save = (): void => {
      receiptFence()
      const text = JSON.stringify(receipt)
      if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES) return held()
      const temporary = createFile(`${receiptPath}.${randomUUID()}.tmp`, text)
      receiptFence()
      checkRequest()
      if (previous.text === null) linkSync(temporary.path, receiptPath)
      else renameSync(temporary.path, receiptPath)
      sync(directoryPath, true)
      previous = readHandoffFile(receiptPath, MAX_RECEIPT_BYTES, true)
      if (previous.key !== temporary.key || previous.text !== text) return held()
    }
    const exclusionBaseline = (): void => {
      if (!prepared.exclude) return
      const exclusion = prepared.exclude, current = readHandoffFile(exclusion.path, 129 * 1024)
      verifyNativePathFacts(exclusion.route.filter(fact => fact.path !== exclusion.path))
      const completed = receipt.exclude && current.key === receipt.exclude.key && current.text === exclusion.after
      if (!completed && (current.text !== exclusion.before || current.version !== exclusion.version)) return held()
    }
    // Before any output is staged, a fresh preparation can preserve the current exclusion as its
    // new effect baseline. A peer may have completed the shared line after our stage was reserved
    // or renamed. Retire only the old receipt pointer; never delete or adopt an old private stage.
    if (previous.text !== null && !receipt.committed && receipt.outputs.every(stage => stage === null)) {
      let baseline = candidate.exclude
      if (prepared.documents && prepared.git.exclude && !baseline) {
        // The current conversation may be empty; its candidate has no writes. The reserved
        // nonempty snapshot still needs the freshly checked exclusion before it can finish.
        const current = readHandoffFile(prepared.git.exclude, 128 * 1024)
        baseline = { path: current.path, before: current.text, after: handoffExcludeText(current.text),
          version: current.version, route: current.route }
      }
      if (JSON.stringify(prepared.exclude) !== JSON.stringify(baseline)) {
        prepared.exclude = baseline
        receipt.exclude = null
        verify(candidate, false); verify(prepared, true); exclusionBaseline(); save()
      }
    }
    if (previous.text === null) {
      if (outputs.some(output => exists(output.path))) return held()
      exclusionBaseline()
      verify(prepared, false)
      if (!prepared.documents) receipt.committed = true
      save()
    }
    const fence = (): void => {
      verify(prepared, true); receiptFence()
      if (receipt.destination) verifyNativePathFacts(receipt.destination)
    }
    const checkpoint = async (): Promise<void> => { await yieldLoop(); fence() }
    await checkpoint()
    if (!prepared.documents) {
      if (!receipt.committed) return held()
      fence(); sync(receiptPath); sync(directoryPath, true); sync(dirname(directoryPath), true); fence()
      checkRequest()
      return prepared.result
    }
    const ignore = join(folder, '.gitignore')
    const confirmIgnore = (): void => {
      if (!receipt.ignore) return held()
      verifyNativePathFacts(receipt.ignore.route)
      const currentIgnore = readHandoffFile(ignore, 64 * 1024, true)
      if (currentIgnore.key !== receipt.ignore.key || currentIgnore.text !== '*\n') return held()
      sync(ignore)
    }
    const guards = (): void => {
      confirmIgnore()
      if (prepared.exclude) {
        const exclusion = prepared.exclude, current = readHandoffFile(exclusion.path, 129 * 1024)
        verifyNativePathFacts(exclusion.route.filter(fact => fact.path !== exclusion.path))
        if (current.text !== exclusion.after) return held()
        if (receipt.exclude) {
          if (current.key !== receipt.exclude.key) return held()
        } else {
          verifyNativePathFacts(exclusion.route)
          if (exclusion.before !== exclusion.after || current.version !== exclusion.version) return held()
        }
        sync(exclusion.path); sync(dirname(exclusion.path), true)
      }
    }
    const confirmed = (): void => outputs.forEach((output, index) => {
      const current = readHandoffFile(output.path, 8 * 1024 * 1024, true)
      if (!receipt.outputs[index] || current.key !== receipt.outputs[index]!.key || current.text !== output.text) return held()
      sync(output.path); sync(folder, true)
    })
    const durable = async (): Promise<void> => {
      fence(); confirmed(); guards()
      await checkpoint()
      sync(join(cwd, '.harness'), true); sync(cwd, true)
      // A rename-visible committed receipt may still have an unconfirmed directory fsync.
      sync(receiptPath); sync(directoryPath, true); sync(dirname(directoryPath), true)
      fence(); guards(); confirmed()
      checkRequest()
    }
    if (receipt.committed) { await durable(); return prepared.result }
    fence()
    exclusionBaseline()
    directory(join(cwd, '.harness')); directory(folder)
    if (!receipt.destination) {
      const folders = new NativeFiles(); folders.locate(folder)
      receipt.destination = folders.paths.snapshot(); save()
    }
    await checkpoint()
    if (!receipt.ignore) {
      if (!exists(ignore)) {
        const staged = createFile(join(folder, `.${id}.${randomUUID()}.stage`), '*\n')
        fence(); checkRequest(); linkSync(staged.path, ignore)
      }
      const observed = readHandoffFile(ignore, 64 * 1024, true)
      if (!observed.key || observed.text !== '*\n') return held()
      receipt.ignore = { key: observed.key, route: observed.route }; save()
    }
    verifyNativePathFacts(receipt.ignore.route)
    const observedIgnore = readHandoffFile(ignore, 64 * 1024, true)
    if (observedIgnore.key !== receipt.ignore.key || observedIgnore.text !== '*\n') return held()
    sync(ignore); sync(folder, true)
    await checkpoint()
    if (prepared.exclude) {
      const exclusion = prepared.exclude, parent = dirname(exclusion.path)
      const excludeFence = (): void => { fence(); verifyNativePathFacts(exclusion.route.filter(fact => fact.path !== exclusion.path)) }
      excludeFence()
      const current = readHandoffFile(exclusion.path, 129 * 1024)
      if (receipt.exclude && current.key === receipt.exclude.key && current.text === exclusion.after) {
        // This transaction completed the rename before a later write/fsync/reply failed.
        sync(exclusion.path); sync(parent, true)
      } else {
        verifyNativePathFacts(exclusion.route)
        if (current.text !== exclusion.before || current.version !== exclusion.version) return held()
        if (exclusion.before !== exclusion.after) {
          if (!receipt.exclude) {
            receipt.exclude = createFile(join(parent, `.${id}.${randomUUID()}.stage`), exclusion.after)
            sync(parent, true); save()
          }
          const staged = readHandoffFile(receipt.exclude.path, 129 * 1024, true)
          if (staged.key !== receipt.exclude.key || staged.text !== exclusion.after) return held()
          excludeFence(); confirmIgnore(); verifyNativePathFacts(exclusion.route)
          const latest = readHandoffFile(exclusion.path, 129 * 1024)
          if (latest.version !== current.version || latest.text !== current.text) return held()
          checkRequest(); renameSync(receipt.exclude.path, exclusion.path); sync(parent, true)
        }
      }
    }
    for (const [index, output] of outputs.entries()) {
      await checkpoint()
      guards()
      if (exists(output.path)) {
        const current = readHandoffFile(output.path, 8 * 1024 * 1024, true)
        if (!receipt.outputs[index] || current.key !== receipt.outputs[index]!.key || current.text !== output.text) return held()
      } else {
        if (!receipt.outputs[index]) {
          receipt.outputs[index] = createFile(join(folder, `.${id}.${randomUUID()}.stage`), output.text)
          sync(folder, true); save()
        }
        const stage = receipt.outputs[index]!, current = readHandoffFile(stage.path, 8 * 1024 * 1024, true)
        if (current.key !== stage.key || current.text !== output.text) return held()
        fence(); guards(); checkRequest(); linkSync(stage.path, output.path); sync(folder, true)
      }
    }
    await checkpoint()
    confirmed(); guards(); fence(); receipt.committed = true; save(); await durable()
    return prepared.result
  } catch (error) {
    if (error instanceof HandoffError) throw error
    if ((error as { code?: string })?.code === 'IDENTITY_UNAVAILABLE') throw new HandoffError('IDENTITY_UNAVAILABLE')
    return held()
  } finally {
    for (const key of locks) if (publications.get(key) === token) publications.delete(key)
  }
}
