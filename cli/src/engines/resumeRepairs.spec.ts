import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexSessionMeta } from '../testing/codexRollout.js'
import { createResumeRepairWorker } from './resumeRepairs.js'
import { repairDirectory, repairFile, RESUME_REPAIR_WAIT_MS, type RepairPreparation } from './worker/resumeRepairProtocol.js'

const id = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d'
const original = codexSessionMeta(id) + JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'relay', content: [] } }) + '\n'
const homes: string[] = []
afterEach(() => { vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'repair-staging-')); homes.push(home)
  mkdirSync(join(home, 'sessions'))
  const file = join(home, 'sessions', `rollout-${id}.jsonl`), directory = join(home, 'inventory')
  writeFileSync(file, original, { mode: 0o600 })
  const source = { engine: 'codex', sessionId: id, transcriptPath: file, codexHome: home }
  const log = vi.fn(), worker = createResumeRepairWorker({ directory, log })
  const ask = (): RepairPreparation => ({ source, file, original: repairFile(lstatSync(file, { bigint: true })), token: randomUUID(), expires: Date.now() + RESUME_REPAIR_WAIT_MS })
  return { home, file, directory, source, log, worker, ask }
}
it('stages exact backup and repaired history without changing the original, and bounds duplicate/parallel work', async () => {
  const t = fixture(), first = t.ask(), second = t.ask()
  expect(t.worker.locate(t.source)).toEqual({ file: t.file })
  expect(await t.worker.prepare(first)).toMatchObject({ repairedItems: 1 })
  expect(readFileSync(t.file, 'utf8')).toBe(original)
  expect(readFileSync(join(repairDirectory(t.file, first.token), 'backup'), 'utf8')).toBe(original)
  expect(readFileSync(join(repairDirectory(t.file, first.token), 'history'), 'utf8')).not.toContain('relay')
  expect(await t.worker.prepare(first)).toEqual({ repairedItems: 0, unrepaired: 'busy' })
  expect(await t.worker.prepare(second)).toMatchObject({ repairedItems: 1 })
  expect(await t.worker.prepare(t.ask())).toEqual({ repairedItems: 0, unrepaired: 'busy' })
  expect(t.worker.release(first.token)).toBe(true)
  expect(t.worker.release(first.token)).toBe(true)
  expect(await t.worker.prepare(first)).toEqual({ repairedItems: 0, unrepaired: 'busy' })
  expect(t.worker.release(second.token)).toBe(true)
  expect(readdirSync(t.directory)).toEqual([])
})

it('recovers at most two recorded private preparations on restart', async () => {
  const t = fixture(), ask = t.ask()
  await t.worker.prepare(ask)
  const replacement = createResumeRepairWorker({ directory: t.directory, log: t.log, ownerAlive: () => false })
  expect(readdirSync(t.directory)).toEqual([])
  expect(readdirSync(join(t.home, 'sessions'))).toEqual([`rollout-${id}.jsonl`])
  expect(readFileSync(t.file, 'utf8')).toBe(original)
  expect(await replacement.prepare(t.ask())).toMatchObject({ repairedItems: 1 })
})

it('an invalid or unidentified receipt keeps its slot reserved and reports the named recovery failure', async () => {
  const t = fixture(), ask = t.ask()
  await t.worker.prepare(ask)
  const receipt = JSON.parse(readFileSync(join(t.directory, '0.json'), 'utf8')); receipt.key = null
  writeFileSync(join(t.directory, '0.json'), JSON.stringify(receipt), { mode: 0o600 })
  writeFileSync(join(t.directory, '1.json'), '{torn', { mode: 0o600 })
  const recovered = createResumeRepairWorker({ directory: t.directory, log: t.log, ownerAlive: () => false })
  expect(t.log).toHaveBeenCalledWith('RESUME_REPAIR_CLEANUP_FAILED')
  expect(t.log).toHaveBeenCalledWith('RESUME_REPAIR_CLEANUP_FAILED · Error')
  expect(await recovered.prepare(t.ask())).toEqual({ repairedItems: 0, unrepaired: 'cleanup_failed' })
  expect(readFileSync(join(repairDirectory(t.file, ask.token), 'backup'), 'utf8')).toBe(original)
  expect(readFileSync(t.file, 'utf8')).toBe(original)
})

it('does not clean a substituted staging directory or unknown entries', async () => {
  const t = fixture(), ask = t.ask()
  await t.worker.prepare(ask)
  writeFileSync(join(repairDirectory(t.file, ask.token), 'someone-else'), 'keep')
  expect(t.worker.release(ask.token)).toBe(false)
  expect(t.log).toHaveBeenCalledWith('RESUME_REPAIR_CLEANUP_FAILED · Error ENOTEMPTY')
  expect(readFileSync(join(repairDirectory(t.file, ask.token), 'someone-else'), 'utf8')).toBe('keep')
})

it('refuses expired work and source changes, and returns existing history refusals without content', async () => {
  const t = fixture(), ask = t.ask()
  expect(await t.worker.prepare({ ...ask, expires: 0 })).toEqual({ repairedItems: 0, unrepaired: 'timed_out' })
  writeFileSync(t.file, original + '\n')
  expect(await t.worker.prepare(ask)).toEqual({ refused: 'changed_during' })
  writeFileSync(t.file, codexSessionMeta(id) + 'personal malformed line\n')
  expect(await t.worker.prepare(t.ask())).toEqual({ refused: 'invalid_json' })
  expect(readdirSync(t.directory)).toEqual([])
})

it('never recovers a still-live worker\'s inventory and rejects deletion through an old receipt token', async () => {
  const t = fixture(), ask = t.ask()
  await t.worker.prepare(ask)
  const alive = createResumeRepairWorker({ directory: t.directory, log: t.log, ownerAlive: () => true })
  expect(t.log).toHaveBeenCalledWith('RESUME_REPAIR_CLEANUP_FAILED')
  expect(readFileSync(join(repairDirectory(t.file, ask.token), 'history'), 'utf8')).not.toContain('relay')
  const receiptPath = join(t.directory, '0.json'), receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  receipt.token = randomUUID(); receipt.stage = repairDirectory(t.file, receipt.token)
  writeFileSync(receiptPath, JSON.stringify(receipt))
  expect(t.worker.release(ask.token)).toBe(false)
  expect(JSON.parse(readFileSync(receiptPath, 'utf8')).token).toBe(receipt.token)
  expect(alive.release(ask.token)).toBe(false)
})

it('expires ready private files when a completion acknowledgement never arrives', async () => {
  const t = fixture()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const ask = t.ask()
  expect(await t.worker.prepare(ask)).toMatchObject({ repairedItems: 1 })
  await vi.advanceTimersByTimeAsync(RESUME_REPAIR_WAIT_MS)
  expect(readdirSync(t.directory)).toEqual([])
  expect(readFileSync(t.file, 'utf8')).toBe(original)
})

it('recovers a handover slot on the next request once its previous worker has exited', async () => {
  const t = fixture(), ask = t.ask()
  await t.worker.prepare(ask)
  let alive = true
  const next = createResumeRepairWorker({ directory: t.directory, log: t.log, ownerAlive: () => alive })
  alive = false
  expect(await next.prepare(t.ask())).toMatchObject({ repairedItems: 1 })
  expect(readdirSync(t.directory)).toEqual(['0.json'])
})
