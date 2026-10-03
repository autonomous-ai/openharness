import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryControl } from './control.js'
import type { CodingMemoryRuntime } from './runtime.js'
import type { CallerVerdict } from '../pair/learn/approval.js'
import { isOwnerProcess } from './ownerProcess.js'

let owner: string | null, now: number, control: MemoryControl
let runtime: Pick<CodingMemoryRuntime, 'ownerKey' | 'libraryStatus' | 'libraryPage' | 'libraryProjects' | 'libraryActivity' | 'libraryNotebooks' | 'libraryNotebook' | 'libraryDetail' | 'libraryPreview' | 'libraryApply'>
let verify: ReturnType<typeof vi.fn<(id: string) => Promise<CallerVerdict>>>
const command = { kind: 'forget' as const, id: 'memory', revision: 1 }
const preview = { command, version: { generation: 1, knowledge: 1, preferences: 'hash' }, effects: { deletedIds: ['memory'] } }
beforeEach(() => {
  owner = 'owner'; now = 1_000
  runtime = { ownerKey: () => owner,
    libraryStatus: vi.fn(async () => ({ runtime: { state: 'ready' as const }, preferences: { learn: true, recall: true }, queue: {} as never })),
    libraryPage: vi.fn(async () => ({ items: [], nextCursor: null, version: preview.version })),
    libraryProjects: vi.fn(async () => ({ items: [], nextBefore: null })),
    libraryActivity: vi.fn(async () => ({ sessions: [], selectedAgentId: null, items: [], version: preview.version })),
    libraryNotebooks: vi.fn(async () => ({ items: [], nextCursor: null, version: preview.version })),
    libraryNotebook: vi.fn(async () => null),
    libraryDetail: vi.fn(async () => null), libraryPreview: vi.fn(async () => structuredClone(preview)),
    libraryApply: vi.fn(async () => ({ deletedIds: ['memory'], alreadyDeliveredContent: 'not_erased' as const })),
  }
  verify = vi.fn(async () => ({ ok: true, pid: 300 }))
  control = new MemoryControl({ runtime: () => runtime, verify, now: () => now })
})
const request = (payload: Record<string, unknown>, conn = 'connection') => control.local({ verb: 'memory', ...payload }, conn)

it('requires a verified owner process even for reads and refuses agent tokens and body-supplied authority', async () => {
  expect(await request({ action: 'list', token: 'pair-token' })).toMatchObject({ error: 'PERSON_ONLY' })
  expect(await request({ action: 'projects', token: 'pair-token' })).toMatchObject({ error: 'PERSON_ONLY' })
  expect(await request({ action: 'preview', command: { kind: 'narrow', id: 'memory', revision: 1, projectId: 'project' }, token: 'pair-token' }))
    .toMatchObject({ error: 'PERSON_ONLY' })
  expect(verify).not.toHaveBeenCalled()
  expect(await request({ action: 'list', profileId: 'owner' })).toMatchObject({ error: 'INVALID_INPUT' })
  verify.mockResolvedValue({ ok: false, error: 'INSIDE_HARNESS', detail: 'agent' })
  expect(await request({ action: 'list' })).toMatchObject({ error: 'INSIDE_HARNESS' })
  verify.mockResolvedValue({ ok: false, error: 'UNVERIFIED', detail: 'unknown process' })
  expect(await request({ action: 'status' })).toMatchObject({ error: 'UNVERIFIED' })
  expect(runtime.libraryPage).not.toHaveBeenCalled()
  expect(runtime.libraryStatus).not.toHaveBeenCalled()
})

it('routes bounded project search through the verified current owner', async () => {
  expect(await request({ action: 'projects', query: { search: 'editor', limit: 10, before: 100 } })).toMatchObject({ ok: true, items: [] })
  expect(runtime.libraryProjects).toHaveBeenCalledExactlyOnceWith('owner', { search: 'editor', limit: 10, before: 100 })
  expect(await request({ action: 'projects', query: { limit: 500 } })).toMatchObject({ error: 'INVALID_INPUT' })
})

it('keeps activity owner-only and derives native receiver identity from the host', async () => {
  expect(await request({ action: 'activity', token: 'agent' })).toMatchObject({ error: 'PERSON_ONLY' })
  expect(await request({ action: 'activity', query: { sessionId: 'claimed-native' } })).toMatchObject({ error: 'INVALID_INPUT' })
  expect(await request({ action: 'activity', query: { agentId: 'open-agent' } })).toMatchObject({ ok: true, items: [] })
  expect(runtime.libraryActivity).toHaveBeenCalledExactlyOnceWith('owner', { agentId: 'open-agent' })
})

it('keeps notebook browsing owner-only and bounded, including direct page requests', async () => {
  for (const payload of [{ action: 'notebooks' }, { action: 'notebook', id: 'notebook:one' }]) {
    expect(await request({ ...payload, token: 'agent' })).toMatchObject({ error: 'PERSON_ONLY' })
    expect(await request({ ...payload, owner: 'other' })).toMatchObject({ error: 'INVALID_INPUT' })
    verify.mockResolvedValueOnce({ ok: false, error: 'INSIDE_HARNESS', detail: 'agent' })
    expect(await request(payload)).toMatchObject({ error: 'INSIDE_HARNESS' })
  }
  expect(runtime.libraryNotebooks).not.toHaveBeenCalled()
  expect(runtime.libraryNotebook).not.toHaveBeenCalled()
  expect(await request({ action: 'notebooks', query: { limit: 200 } })).toMatchObject({ error: 'INVALID_INPUT' })
  expect(await request({ action: 'notebooks', query: { limit: 12 } })).toMatchObject({ ok: true, items: [] })
  expect(runtime.libraryNotebooks).toHaveBeenCalledExactlyOnceWith('owner', { limit: 12 })
  expect(await request({ action: 'notebook', id: 'notebook:one' })).toMatchObject({ error: 'NOT_FOUND' })
  expect(runtime.libraryNotebook).toHaveBeenCalledExactlyOnceWith('owner', 'notebook:one')
})

it('requires the same owner capability for per-recall feedback and accepts no agent or rating authority', async () => {
  const feedback = { kind: 'feedback', id: 'memory', revision: 1, receiptId: 'receipt', value: 'helpful', expected: 0 }
  expect(await request({ action: 'preview', command: feedback, token: 'agent' })).toMatchObject({ error: 'PERSON_ONLY' })
  expect(await request({ action: 'preview', command: { ...feedback, confirmed: true } })).toMatchObject({ error: 'INVALID_INPUT' })
  expect(await request({ action: 'preview', command: { ...feedback, value: 'verified_used' } })).toMatchObject({ error: 'INVALID_INPUT' })
  verify.mockResolvedValue({ ok: false, error: 'INSIDE_HARNESS', detail: 'agent' })
  expect(await request({ action: 'preview', command: feedback })).toMatchObject({ error: 'INSIDE_HARNESS' })
  expect(runtime.libraryPreview).not.toHaveBeenCalled()
  verify.mockResolvedValue({ ok: true, pid: 300 })
  expect(await request({ action: 'preview', command: feedback })).toMatchObject({ ok: true })
  expect(runtime.libraryPreview).toHaveBeenCalledExactlyOnceWith('owner', feedback)
})

it('binds a one-use capability to the exact owner, process, connection and server-held command', async () => {
  const prepared = await request({ action: 'preview', command })
  expect(prepared).toMatchObject({ ok: true, preview, capability: expect.any(String) })
  expect(await request({ action: 'apply', capability: prepared.capability, command: { ...command, id: 'different' } })).toMatchObject({ error: 'INVALID_INPUT' })
  expect(await request({ action: 'apply', capability: prepared.capability, confirmed: true })).toMatchObject({ error: 'INVALID_INPUT' })
  expect(await request({ action: 'apply', capability: prepared.capability })).toMatchObject({ ok: true, deletedIds: ['memory'] })
  expect(runtime.libraryApply).toHaveBeenCalledWith('owner', preview)
  expect(await request({ action: 'apply', capability: prepared.capability })).toMatchObject({ error: 'PREVIEW_REQUIRED' })
})

it.each(['connection', 'pid', 'owner', 'expired'])('rejects a %s change between preview and apply', async mode => {
  const prepared = await request({ action: 'preview', command })
  if (mode === 'pid') verify.mockResolvedValue({ ok: true, pid: 301 })
  if (mode === 'owner') owner = 'replacement'
  if (mode === 'expired') now += 120_001
  expect(await request({ action: 'apply', capability: prepared.capability }, mode === 'connection' ? 'other' : 'connection')).toMatchObject({ error: 'PREVIEW_REQUIRED' })
  expect(runtime.libraryApply).not.toHaveBeenCalled()
})

it('does not use a newly signed-in owner when identity changes during process verification', async () => {
  verify.mockImplementation(async () => { owner = 'replacement'; return { ok: true, pid: 300 } })
  expect(await request({ action: 'list' })).toMatchObject({ error: 'OWNER_CHANGED' })
  expect(runtime.libraryPage).not.toHaveBeenCalled()
})

it('bounds pending previews and evicts the oldest unused capability', async () => {
  const first = await request({ action: 'preview', command })
  for (let index = 0; index < 32; index++) await request({ action: 'preview', command })
  expect(await request({ action: 'apply', capability: first.capability })).toMatchObject({ error: 'PREVIEW_REQUIRED' })
})

it('verifies the process belongs to the daemon OS user and fails closed on ambiguous output', async () => {
  expect(await isOwnerProcess(300, 501, async () => ' 501\n')).toBe(true)
  for (const output of ['502', '501\n502', 'uid 501', '', null]) expect(await isOwnerProcess(300, 501, async () => output)).toBe(false)
  expect(await isOwnerProcess(300, 501, async () => { throw Error('ps unavailable') })).toBe(false)
  expect(await isOwnerProcess(-2, 501, async () => '501')).toBe(false)
})
