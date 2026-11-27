import { expect, it, vi } from 'vitest'
import { engineResumeRepairRequests } from './resumeRepairRequests.js'
import { repairAnswer, repairPreparation, repairSource, RESUME_REPAIR_CAPABILITIES, RESUME_REPAIR_LOCATE,
  RESUME_REPAIR_PREPARE, RESUME_REPAIR_RELEASE, RESUME_REPAIR_WAIT_MS } from './resumeRepairProtocol.js'

const who = { owner: true, local: true }
const source = { engine: 'codex', sessionId: 'session-123', transcriptPath: '/profile/sessions/a.jsonl', codexHome: '/profile' }
const token = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d'
const facts = { key: '1:2', version: 'version', size: 100 }
const preparation = { source, token, file: source.transcriptPath, original: facts, expires: Date.now() + RESUME_REPAIR_WAIT_MS }
const answer = { repairedItems: 1, repairedBytes: 90, directoryKey: '1:3', backup: facts, history: { ...facts, size: 90 } }
function setup() {
  const worker = { locate: vi.fn(() => ({ file: source.transcriptPath })), prepare: vi.fn(async () => answer), release: vi.fn(() => true) }
  const load = vi.fn(async () => worker), recycle = vi.fn(), requests = engineResumeRepairRequests({ load, recycle })
  return { worker, load, recycle, requests }
}
it('advertises capability without loading staging code and serves only typed bounded operations', async () => {
  const t = setup()
  expect(await t.requests[RESUME_REPAIR_CAPABILITIES]({ version: 1 }, who)).toEqual({ version: 1, engine: 'codex', resumeRepair: 1 })
  expect(t.load).not.toHaveBeenCalled()
  expect(await t.requests[RESUME_REPAIR_LOCATE]({ version: 1, source }, who)).toEqual({ version: 1, answer: { file: source.transcriptPath } })
  expect(await t.requests[RESUME_REPAIR_PREPARE]({ version: 1, preparation }, who)).toEqual({ version: 1, answer })
  expect(await t.requests[RESUME_REPAIR_RELEASE]({ version: 1, token }, who)).toEqual({ version: 1, answer: true })
  expect(t.load).toHaveBeenCalledOnce()
})
it('rejects public callers and unexpected request authority before loading files', async () => {
  const t = setup()
  for (const asker of [{ owner: false, local: true }, { owner: true, local: false }, { ...who, connection: 'public' }]) {
    expect(await t.requests[RESUME_REPAIR_PREPARE]({ version: 1, preparation }, asker)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  }
  for (const payload of [{ version: 2, preparation }, { version: 1, preparation, destination: '/elsewhere' },
    { version: 1, preparation: { ...preparation, original: { ...facts, size: Infinity } } },
    { version: 1, preparation: { ...preparation, token: '../escape' } }]) {
    expect(await t.requests[RESUME_REPAIR_PREPARE](payload, who)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  }
  expect(t.load).not.toHaveBeenCalled()
})
it('recycles hung staging and bounds requests without ever publishing', async () => {
  const t = setup(); vi.useFakeTimers()
  try {
    t.worker.prepare.mockImplementation(() => new Promise(() => {}))
    const first = t.requests[RESUME_REPAIR_PREPARE]({ version: 1, preparation }, who)
    const second = t.requests[RESUME_REPAIR_PREPARE]({ version: 1, preparation }, who)
    expect(await t.requests[RESUME_REPAIR_PREPARE]({ version: 1, preparation }, who)).toMatchObject({ error: 'ENGINE_BUSY' })
    await vi.advanceTimersByTimeAsync(RESUME_REPAIR_WAIT_MS)
    expect(await first).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
    expect(await second).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
    expect(t.recycle).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})
it('validates every count, string and result variant across the private boundary', () => {
  expect(repairSource(source)).toBe(true); expect(repairPreparation(preparation)).toBe(true); expect(repairAnswer(answer)).toBe(true)
  for (const invalid of [null, { ...source, engine: 'claude' }, { ...source, sessionId: '' }, { ...source, codexHome: 'x\0y' },
    { ...source, transcriptPath: 'a'.repeat(4097) }, { ...source, extra: true }]) expect(repairSource(invalid)).toBe(false)
  for (const invalid of [null, { ...preparation, expires: NaN }, { ...preparation, extra: true }, { ...preparation, file: '' }]) expect(repairPreparation(invalid)).toBe(false)
  for (const valid of [{ repairedItems: 0 }, { repairedItems: 0, unrepaired: 'cleanup_failed' }, { refused: 'invalid_json' }]) expect(repairAnswer(valid)).toBe(true)
  for (const invalid of [null, {}, { ...answer, repairedBytes: -1 }, { ...answer, repairedItems: 0 }, { ...answer, directoryKey: '' },
    { ...answer, history: facts }, { ...answer, backup: { ...facts, size: 1024 ** 3 + 1 } }, { repairedItems: 0, backupPath: '/x' },
    { repairedItems: 0, unrepaired: 'unknown' }, { refused: 'unknown' }]) expect(repairAnswer(invalid)).toBe(false)
})
