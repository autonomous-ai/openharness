import { describe, expect, it, vi } from 'vitest'
import { draftOwner, VoiceDraft, VoiceDraftArchives, type DraftOwner, type DraftState } from './voiceDraft.js'

const OWNER: DraftOwner = { mac: '28:84:85:90:5F:78', machineId: 'original-computer' }
const OTHER: DraftOwner = { ...OWNER, mac: '28:84:85:90:5F:79' }
const TTL = 30 * 60_000
function fixture(text = 'Original words.', clock = { now: 100 }) {
  const drafts = new VoiceDraft(() => clock.now)
  const submit = vi.fn(async () => ({ ok: true as const })), cancel = vi.fn()
  const page = drafts.create({ agentId: 'original-agent', name: 'Original', text,
    owner: OWNER, intent: 'goal', carryId: 'source-quote', context: 'With text from Source', submit, cancel })
  const command = (p: DraftState, op = 'state', delta = 0, owner: DraftOwner | undefined = OWNER) =>
    drafts.command(p.id, p.revision, op, delta, owner)
  return { drafts, submit, cancel, page, command, clock }
}

describe('detached voice message recovery', () => {
  it('retains all 16,000 UTF-8 bytes and whitespace as immutable read-only pages', async () => {
    const words = '  Tiếng Việt. Cafe\u0301.\n\n'.repeat(350)
    const text = words + 'z'.repeat(16_000 - Buffer.byteLength(words))
    const f = fixture(text); expect(f.page.ok).toBe(true)
    f.drafts.detach()
    let p = await f.command(f.page), joined = ''
    expect(p.revision).toBe(f.page.revision + 1)
    for (;;) {
      expect(p).toMatchObject({ active: true, agentId: 'original-agent', context: 'With text from Source',
        carryId: 'source-quote', locked: true, canSend: false, canUndo: false })
      expect(Buffer.byteLength(p.text!)).toBeLessThanOrEqual(480)
      expect(p.text).not.toContain('\ufffd'); joined += p.text
      expect(f.drafts.pin(p.id, p.revision, 'append')).toBeUndefined()
      if (p.position === p.total) break
      p = await f.command(p, 'move', 1)
    }
    expect(joined).toBe(text)
    for (const op of ['send', 'undo', 'append', 'replace']) expect((await f.command(p, op)).ok).toBe(false)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledOnce()
  })

  it('coexists with a fresh live draft and never leaks that draft through an old-id error', async () => {
    const f = fixture('older '.repeat(300)); f.drafts.detach()
    const next = f.drafts.create({ agentId: 'new-agent', name: 'New', text: 'Private new words',
      owner: OTHER, submit: f.submit })
    expect(next.ok).toBe(true)
    expect(await f.command(f.page, 'state', 0, OTHER)).toMatchObject({ active: false })
    expect(await f.drafts.command(f.page.id, 1, 'state')).toMatchObject({ active: false })
    expect(await f.command({ ...f.page, id: 'unknown' })).toMatchObject({ active: false })
    const p = await f.command(f.page)
    const stale = await f.command(f.page, 'move', 1)
    expect(stale).toMatchObject({ ok: false, active: true, id: f.page.id, revision: p.revision, position: 1 })
    expect(stale.text).not.toContain('Private')
    const moved = await f.command(p, 'move', 1)
    expect(moved.position).toBe(2)
    expect(await f.command(p, 'move', 1)).toMatchObject({ ok: false, position: 2, revision: moved.revision })
    expect(await f.drafts.command(next.id, next.revision, 'state', 0, OTHER)).toMatchObject({ text: 'Private new words' })
  })

  it('state refreshes revision while moves retain the existing boundary increment rule', async () => {
    const f = fixture(); f.drafts.detach()
    const p = await f.command({ ...f.page, revision: -10 })
    const atEnd = await f.command(p, 'move', 1)
    expect(atEnd).toMatchObject({ position: 1, total: 1, revision: p.revision + 1 })
    expect(await f.command(f.page)).toMatchObject({ revision: atEnd.revision })
  })

  it('expires against a fixed monotonic deadline, including idle expiry and wall-clock jumps', async () => {
    const f = fixture(); f.drafts.detach()
    const wall = vi.spyOn(Date, 'now').mockReturnValue(-9_000_000)
    try {
      f.clock.now += TTL - 1
      expect((await f.command(f.page)).active).toBe(true)
      wall.mockReturnValue(9_000_000_000_000)
      f.clock.now++
      f.drafts.expire()
      expect((await f.command(f.page)).active).toBe(false)
    } finally { wall.mockRestore() }
  })

  it('replaces the old archive at the next detach and never persists across a new instance', async () => {
    const f = fixture(); f.drafts.detach()
    const next = f.drafts.create({ agentId: 'next', name: 'Next', text: 'Next words', owner: OWNER, submit: f.submit })
    f.drafts.detach()
    expect((await f.command(f.page)).active).toBe(false)
    expect((await f.command(next)).text).toBe('Next words')
    expect((await new VoiceDraft().command(next.id, next.revision, 'state', 0, OWNER)).active).toBe(false)
    f.drafts.forgetAll()
    expect((await f.command(next)).active).toBe(false)
  })

  it('never archives an explicit discard or a creation abort', async () => {
    const a = fixture(); await a.command(a.page, 'discard'); a.drafts.detach()
    expect((await a.command(a.page)).active).toBe(false)
    const b = fixture(); b.drafts.cancelCreation(b.page.id); b.drafts.detach()
    expect((await b.command(b.page)).active).toBe(false)
  })

  it('cancels a claimed send before its microtask with definite no-input, without retry', async () => {
    const f = fixture(), pending = f.command(f.page, 'send')
    f.drafts.detach(); await pending
    const archived = await f.command(f.page)
    expect(archived.error).toContain('was not sent')
    await f.command(archived, 'send')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each(['submitted', 'rejected', 'uncertain', 'legacy'] as const)(
    'keeps a late %s receipt only in its original read-only archive', async outcome => {
      let settle!: (receipt: { ok: true; outcome?: 'submitted' } | { ok: false; error: string; outcome: 'rejected' | 'uncertain' }) => void
      const f = fixture()
      f.drafts.clear()
      const submit = vi.fn(() => new Promise<Parameters<typeof settle>[0]>(resolve => { settle = resolve }))
      const old = f.drafts.create({ agentId: 'old', name: 'Old', text: 'All old words', owner: OWNER, submit })
      const sending = f.command(old, 'send'); await Promise.resolve()
      f.drafts.detach()
      expect((await f.command(old)).error).toContain('Check the terminal')
      const fresh = f.drafts.create({ agentId: 'new', name: 'New', text: 'Fresh words', owner: OTHER, submit: f.submit })
      settle(outcome === 'submitted' ? { ok: true, outcome } : outcome === 'legacy' ? { ok: true }
        : { ok: false, outcome, error: 'original failure' })
      await sending
      const archived = await f.command(old)
      expect(archived).toMatchObject({ active: true, locked: true, canSend: false, text: 'All old words' })
      expect(archived.sent === true).toBe(outcome === 'submitted' || outcome === 'legacy')
      expect(archived.error).toContain(outcome === 'submitted' ? 'Submitted' : outcome === 'rejected' ? 'was not sent'
        : outcome === 'legacy' ? 'Passed to Harness' : 'Check the terminal')
      expect(await f.drafts.command(fresh.id, 1, 'state', 0, OTHER)).toMatchObject({ text: 'Fresh words', canSend: true, locked: false })
      await f.command(archived, 'send'); expect(submit).toHaveBeenCalledOnce()
    })

  it.each(['discard', 'expire', 'replace'] as const)('a pending receipt cannot resurrect an archive after %s', async action => {
    let settle!: (r: { ok: true; outcome: 'submitted' }) => void
    const f = fixture(); f.drafts.clear()
    const old = f.drafts.create({ agentId: 'a', name: 'A', text: 'Old', owner: OWNER,
      submit: () => new Promise(resolve => { settle = resolve }) })
    const pending = f.command(old, 'send'); await Promise.resolve(); f.drafts.detach()
    if (action === 'discard') await f.command(await f.command(old), 'discard')
    if (action === 'expire') { f.clock.now += TTL; f.drafts.expire() }
    if (action === 'replace') { f.drafts.create({ agentId: 'b', name: 'B', text: 'New', owner: OWNER, submit: f.submit }); f.drafts.detach() }
    settle({ ok: true, outcome: 'submitted' }); await pending
    expect((await f.command(old)).active).toBe(false)
  })

  it('keeps the conservative display send gate and requires complete explicit ownership', async () => {
    const f = fixture('Tiếng Việt.'); expect(f.page.canSend).toBe(false)
    expect((await f.command(f.page, 'send')).ok).toBe(false)
    expect(draftOwner(OWNER.mac, OWNER.machineId)).toEqual(OWNER)
    for (const mac of ['', 'aa:bb', `${OWNER.mac}extra`]) expect(draftOwner(mac, OWNER.machineId)).toBeUndefined()
    for (const machine of ['', 'a'.repeat(48), 'bad\nidentity']) expect(draftOwner(OWNER.mac, machine)).toBeUndefined()
    f.drafts.clear()
    const noOwner = f.drafts.create({ agentId: 'a', name: 'A', text: 'No stable peer', submit: f.submit })
    f.drafts.detach(); expect((await f.command(noOwner)).active).toBe(false)
  })

  it('bounds a shared fleet to four latest owner archives and evicts by detach order, not reads', async () => {
    const store = new VoiceDraftArchives(), records: Array<{ page: DraftState; owner: DraftOwner }> = []
    for (let n = 0; n < 4; n++) {
      const owner = { ...OWNER, mac: `28:84:85:90:5F:0${n}` }
      const drafts = new VoiceDraft(undefined, store)
      const page = drafts.create({ agentId: `agent-${n}`, name: 'Name', text: 'x'.repeat(16_000), owner, submit: async () => ({ ok: true }) })
      drafts.detach(); records.push({ page, owner })
    }
    const reader = new VoiceDraft(undefined, store)
    expect((await reader.command(records[0].page.id, 1, 'state', 0, records[0].owner)).active).toBe(true)
    const fifth = new VoiceDraft(undefined, store)
    fifth.create({ agentId: 'fifth', name: 'Name', text: 'y'.repeat(16_000), owner: OTHER, submit: async () => ({ ok: true }) })
    fifth.detach()
    expect((await reader.command(records[0].page.id, 1, 'state', 0, records[0].owner)).active).toBe(false)
    for (const { page, owner } of records.slice(1)) expect((await reader.command(page.id, 1, 'state', 0, owner)).active).toBe(true)
    store.clear()
    expect((await reader.command(records[1].page.id, 1, 'state', 0, records[1].owner)).active).toBe(false)
  })

  it('does not retain oversized metadata in the bounded fleet store', async () => {
    const drafts = new VoiceDraft()
    const page = drafts.create({ agentId: 'a', name: 'n'.repeat(2048), text: 'Words', owner: OWNER, submit: async () => ({ ok: true }) })
    drafts.detach()
    expect((await drafts.command(page.id, 1, 'state', 0, OWNER)).active).toBe(false)
  })
})
