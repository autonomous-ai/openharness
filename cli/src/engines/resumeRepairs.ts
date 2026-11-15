/** Codex's private staging inventory. Only core may publish these preparations. */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homeRoots } from '../lib/engineHomes.js'
import { readPrivateStateFile, secureStateDirectory, syncStateDirectory } from '../lib/secureState.js'
import { launchContract } from './launches.js'
import { NativeFiles } from './kit/nativeFiles.js'
import { verifyNativePathFacts, type NativePathFact } from './kit/nativePaths.js'
import { locateRepairHistory, repairHistory } from './kit/resumeRepair.js'
import { REPAIR_LIMITS, ResumePreparationError, type ResumeSource } from './facets/resumeRepair.js'
import { repairDirectory, repairFile, repairPath, repairToken, RESUME_REPAIR_WAIT_MS,
  type RepairAnswer, type RepairPreparation } from './worker/resumeRepairProtocol.js'
import { record } from './worker/protocol.js'

type Receipt = { version: 1; token: string; stage: string; route: NativePathFact[]; key: string | null; expires: number; owner: number }
const contract = launchContract('codex')!.resumeRepair!
const roots = (source: ResumeSource) => (source.codexHome ? [source.codexHome] : homeRoots(contract.sessions.home.setting))
  .map(home => join(home, contract.sessions.folder))
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const safeDirectory = (path: string): string => {
  const info = lstatSync(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && ((info.mode & 0o077n) !== 0n
    || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) throw new Error('RESUME_REPAIR_CLEANUP_FAILED')
  return repairFile(info).key
}
function receiptValid(value: unknown): value is Receipt {
  if (!record(value) || Object.keys(value).length !== 7 || value.version !== 1 || !repairToken(value.token)
    || !repairPath(value.stage) || basename(value.stage) !== `.harness-resume-${value.token}`
    || !(value.key === null || typeof value.key === 'string' && value.key.length <= 256)
    || !Number.isSafeInteger(value.expires) || !Number.isSafeInteger(value.owner) || (value.owner as number) <= 0 || (value.owner as number) > 2 ** 31 - 1
    || !Array.isArray(value.route) || !value.route.length || value.route.length > 256) return false
  const stage = value.stage
  return value.route.every(fact => record(fact) && repairPath(fact.path) && typeof fact.identity === 'string' && fact.identity.length <= 256
    && (fact.alias === undefined || record(fact.alias) && repairPath(fact.alias.target) && typeof fact.alias.version === 'string' && fact.alias.version.length <= 256))
    && value.route.some(fact => fact.path === dirname(stage))
}

export function createResumeRepairWorker(deps: { directory: string; log?: (name: string) => void; ownerAlive?: (pid: number) => boolean }) {
  const log = deps.log ?? ((name: string) => console.warn(`[resume] ${name}`))
  const slots: Array<Receipt | 'invalid' | null> = [null, null]
  const recovering = new Set<number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const used = new Map<string, number>()
  const slotPath = (index: number) => join(deps.directory, `${index}.json`)
  const ownerAlive = deps.ownerAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  })
  secureStateDirectory(deps.directory)
  // Overwriting one of two fixed receipts can tear on a crash; an invalid receipt keeps that slot reserved.
  // Unlike replacing it with an untracked temporary, this cannot orphan an unbounded number of staging files.
  const owns = (index: number, receipt: Receipt): void => {
    const saved = JSON.parse(readPrivateStateFile(slotPath(index), 128 * 1024))
    if (!receiptValid(saved) || saved.token !== receipt.token || saved.owner !== receipt.owner || saved.stage !== receipt.stage) throw new Error('RESUME_REPAIR_CLEANUP_FAILED')
  }
  const save = (index: number, receipt: Receipt, initial = false): void => {
    if (!initial) owns(index, receipt)
    const fd = openSync(slotPath(index), constants.O_WRONLY | constants.O_NOFOLLOW
      | (initial ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC), 0o600)
    try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd) } finally { closeSync(fd) }
    syncStateDirectory(deps.directory)
  }
  const clean = (index: number, expected = slots[index]): boolean => {
    if (slots[index] !== expected) return true
    const receipt = slots[index]
    if (!receipt) return true
    if (receipt === 'invalid') { log('RESUME_REPAIR_CLEANUP_FAILED'); return false }
    if (recovering.has(index) && ownerAlive(receipt.owner)) { log('RESUME_REPAIR_CLEANUP_FAILED'); return false }
    clearTimeout(timers.get(receipt.token)); timers.delete(receipt.token)
    try {
      owns(index, receipt)
      verifyNativePathFacts(receipt.route)
      let key: string | null
      try { key = safeDirectory(receipt.stage) } catch (error) { if (!missing(error)) throw error; key = null }
      if (key !== null) {
        if (key !== receipt.key) throw new Error('RESUME_REPAIR_CLEANUP_FAILED')
        // Never follow a substituted directory, enumerate arbitrary entries, or touch published names.
        for (const name of ['backup', 'history']) {
          verifyNativePathFacts(receipt.route)
          if (safeDirectory(receipt.stage) !== key) throw new Error('RESUME_REPAIR_CLEANUP_FAILED')
          rmSync(join(receipt.stage, name), { force: true })
        }
        if (safeDirectory(receipt.stage) !== key) throw new Error('RESUME_REPAIR_CLEANUP_FAILED')
        rmdirSync(receipt.stage)
      }
      owns(index, receipt)
      rmSync(slotPath(index)); syncStateDirectory(deps.directory)
      slots[index] = null
      recovering.delete(index)
      return true
    } catch { log('RESUME_REPAIR_CLEANUP_FAILED'); return false }
  }
  for (let index = 0; index < slots.length; index++) {
    try {
      const value: unknown = JSON.parse(readPrivateStateFile(slotPath(index), 128 * 1024))
      slots[index] = receiptValid(value) ? value : 'invalid'
      recovering.add(index)
    } catch (error) { if (!missing(error)) slots[index] = 'invalid' }
    clean(index)
  }
  const refused = (error: unknown): RepairAnswer => error instanceof ResumePreparationError
    ? { refused: error.kind } : { repairedItems: 0, unrepaired: 'unavailable' }
  return {
    locate(source: ResumeSource): { file: string | null } | RepairAnswer {
      try { return { file: locateRepairHistory(contract, source.sessionId, source.transcriptPath, roots(source))?.file ?? null } }
      catch (error) { return refused(error) }
    },
    async prepare(ask: RepairPreparation): Promise<RepairAnswer> {
      if (ask.expires <= Date.now() || ask.expires > Date.now() + RESUME_REPAIR_WAIT_MS) return { repairedItems: 0, unrepaired: 'timed_out' }
      // A token is single use, including a duplicate while its first caller still awaits disk I/O.
      for (const [token, expires] of used) if (expires <= Date.now()) used.delete(token)
      // A handover can overlap the old worker's exit. Recheck only its two known slots on demand, never poll.
      for (const index of recovering) clean(index)
      if (used.has(ask.token) || used.size >= 128) return { repairedItems: 0, unrepaired: 'busy' }
      const index = slots.indexOf(null)
      if (index < 0) return { repairedItems: 0, unrepaired: recovering.size || slots.includes('invalid') ? 'cleanup_failed' : 'busy' }
      used.set(ask.token, ask.expires)
      let receipt: Receipt | undefined
      let ready = false
      try {
        const files = new NativeFiles(), parent = files.locate(dirname(ask.file))!
        if (!parent.info.isDirectory()) throw new Error('RESUME_REPAIR_UNAVAILABLE')
        receipt = { version: 1, token: ask.token, stage: repairDirectory(join(parent.path, basename(ask.file)), ask.token),
          route: files.paths.snapshot(), key: null, expires: ask.expires, owner: process.pid }
        slots[index] = receipt
        save(index, receipt, true)
        verifyNativePathFacts(receipt.route)
        mkdirSync(receipt.stage, { mode: 0o700 })
        receipt.key = safeDirectory(receipt.stage)
        save(index, receipt)
        const current = () => slots[index] === receipt && Date.now() < ask.expires
        const answer = await repairHistory(contract, ask.source.sessionId, ask.file, roots(ask.source), current,
          { ...REPAIR_LIMITS, deadlineMs: Math.min(REPAIR_LIMITS.deadlineMs, ask.expires - Date.now()) }, { directory: receipt.stage, original: ask.original })
        if (!current()) return { repairedItems: 0, unrepaired: 'cancelled' }
        if ('directoryKey' in answer && answer.directoryKey === receipt.key) {
          ready = true
          const timer = setTimeout(() => { clean(index, receipt!) }, Math.max(1, ask.expires - Date.now()))
          timer.unref(); timers.set(receipt.token, timer)
        }
        return answer
      } catch (error) { return refused(error) }
      finally { if (!ready && receipt) clean(index, receipt) }
    },
    release(token: string): boolean {
      const index = slots.findIndex(slot => slot && slot !== 'invalid' && slot.token === token)
      return index < 0 || clean(index)
    },
  }
}

export type ResumeRepairWorker = ReturnType<typeof createResumeRepairWorker>
