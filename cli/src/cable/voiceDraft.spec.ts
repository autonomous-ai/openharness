import { describe, expect, it, vi } from 'vitest'
import { VoiceDraft, type DraftState } from './voiceDraft.js'

function setup(text = 'Keep the public API.') {
  const drafts = new VoiceDraft()
  const submit = vi.fn(async (_text: string) => ({ ok: true as const }))
  const page = drafts.create({ agentId: 'original-agent', name: 'Parser', text, submit })
  return { drafts, submit, page }
}

describe('voice draft ownership and receipts', () => {
  it('sends the exact transcript only after explicit Send, with one receipt', async () => {
    const { drafts, page, submit } = setup('One.\n\n  Two.  ')
    expect(submit).not.toHaveBeenCalled()
    const [a, b] = await Promise.all([drafts.command(page.id, page.revision, 'send'), drafts.command(page.id, page.revision, 'send')])
    expect(a).toEqual(b); expect(a.sent).toBe(true)
    expect(submit).toHaveBeenCalledExactlyOnceWith('One.\n\n  Two.  ')
    expect(await drafts.command(page.id, 0, 'state')).toEqual(a)
  })
  it('pages over UTF-8 without losing whitespace or splitting characters', async () => {
    const text = ('Café déjà vu.\n\n  Keep this spacing! ').repeat(100)
    const { drafts, submit, page } = setup(text)
    let p = page, joined = ''
    for (;;) {
      expect(Buffer.byteLength(p.text!, 'utf8')).toBeLessThanOrEqual(480)
      expect(p.text).not.toContain('\ufffd'); joined += p.text
      if (p.position === p.total) break
      p = await drafts.command(p.id, p.revision, 'move', 1)
    }
    expect(joined).toBe(text)
    await drafts.command(p.id, p.revision, 'send')
    expect(submit).toHaveBeenCalledExactlyOnceWith(text)
  })
  it('replaces only the pinned part, appends, and undoes exactly one edit', async () => {
    const { drafts, page, submit } = setup('first '.repeat(100)+'last')
    const suffix = ('first '.repeat(100)+'last').slice(page.text!.length)
    const edited = drafts.edit(drafts.pin(page.id, page.revision, 'replace')!, 'A replacement.')
    expect(edited.canUndo).toBe(true)
    const appended = drafts.edit(drafts.pin(edited.id, edited.revision, 'append')!, 'And tests.')
    const undone = await drafts.command(appended.id, appended.revision, 'undo')
    expect(undone.canUndo).toBe(false)
    await drafts.command(undone.id, undone.revision, 'send')
    expect(submit).toHaveBeenCalledExactlyOnceWith('A replacement. '+suffix)
  })
  it('refuses a late edit after the reading cursor moved', async () => {
    const { drafts, page } = setup('part '.repeat(300))
    const pin = drafts.pin(page.id, page.revision, 'replace')!
    const next = await drafts.command(page.id, page.revision, 'move', 1)
    expect(drafts.edit(pin, 'Wrong part').ok).toBe(false)
    expect((await drafts.command(page.id, next.revision, 'state')).text).toBe(next.text)
  })
  it('never retries an uncertain send and blocks discard while delivery is pending', async () => {
    let reject!: (e: Error) => void
    const submit = vi.fn(() => new Promise<{ok:true}>((_resolve, r) => { reject = r }))
    const drafts = new VoiceDraft(), p = drafts.create({ agentId: 'a', name: 'A', text: 'Once.', submit })
    const sending = drafts.command(p.id, p.revision, 'send'); await Promise.resolve()
    expect((await drafts.command(p.id, p.revision, 'discard')).active).toBe(true)
    expect(drafts.pin(p.id, p.revision, 'replace')).toBeUndefined()
    reject(new Error('timeout'))
    const receipt = await sending
    expect(receipt).toMatchObject({ active: true, locked: true, ok: false })
    expect(await drafts.command(p.id, p.revision, 'send')).toEqual(receipt)
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await drafts.command(p.id, p.revision, 'discard')).active).toBe(false)
  })
  it('locks a refused send without consuming its pinned context', async () => {
    const drafts = new VoiceDraft(), submit = vi.fn(async () => ({ ok: false as const, error: 'Offline' }))
    const p = drafts.create({ agentId: 'a', name: 'A', text: 'Read this.', carryId: 'quote', context: 'From B', submit })
    expect(await drafts.command(p.id, p.revision, 'send')).toMatchObject({ ok: false, active: true, locked: true, context: 'From B' })
    await drafts.command(p.id, p.revision, 'send'); expect(submit).toHaveBeenCalledTimes(1)
  })
  it('can recover a successful receipt after a lost reply', async () => {
    const { drafts, page, submit } = setup()
    await drafts.command(page.id, page.revision, 'send')
    expect(await drafts.command(page.id, page.revision, 'state')).toMatchObject({ active: false, sent: true })
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('discards with no submission and invalidates the recording pin', async () => {
    const { drafts, page, submit } = setup(), pin = drafts.pin(page.id, page.revision, 'replace')!
    await drafts.command(page.id, page.revision, 'discard')
    expect(drafts.edit(pin, 'late words').ok).toBe(false); expect(submit).not.toHaveBeenCalled()
  })
  it('cancels unseen creation without deleting an edited or submitted draft', async () => {
    const a = setup(); a.drafts.cancelCreation(a.page.id)
    expect((await a.drafts.command(a.page.id, 1, 'state')).active).toBe(false)
    const b = setup(), p = b.drafts.edit(b.drafts.pin(b.page.id, 1, 'append')!, 'More.')
    b.drafts.cancelCreation(p.id)
    expect((await b.drafts.command(p.id, p.revision, 'state')).active).toBe(true)
    await b.drafts.command(p.id, p.revision, 'send'); b.drafts.cancelCreation(p.id)
    expect((await b.drafts.command(p.id, p.revision, 'state')).sent).toBe(true)
  })
  it('allows unsupported characters to be replaced but never sends hidden characters', async () => {
    const { drafts, page, submit } = setup('Fix “this” please. 🚀')
    expect(page.canSend).toBe(false)
    expect((await drafts.command(page.id, 1, 'send')).ok).toBe(false); expect(submit).not.toHaveBeenCalled()
    const p = drafts.edit(drafts.pin(page.id, 1, 'replace')!, 'Fix this please.')
    expect(p.canSend).toBe(true)
    await drafts.command(p.id, p.revision, 'send'); expect(submit).toHaveBeenCalledExactlyOnceWith('Fix this please.')
  })
  it.each(['', ' '.repeat(10), 'x'.repeat(16001), 'a\tb', 'a\0b', 'a\x1bb'])('rejects invalid text %#', text => {
    expect(setup(text).page.ok).toBe(false)
  })
  it('bounds cumulative edits and preserves the old draft on failure', async () => {
    const { drafts, page } = setup('a'.repeat(15900))
    expect(drafts.edit(drafts.pin(page.id, 1, 'append')!, 'b'.repeat(200)).ok).toBe(false)
    expect((await drafts.command(page.id, 1, 'state')).revision).toBe(1)
  })
  it('does not let a cleared pending receipt describe a new draft', async () => {
    let resolve!: (v:{ok:true}) => void
    const drafts = new VoiceDraft()
    const old = drafts.create({ agentId: 'a', name:'A', text:'Old', submit: () => new Promise(r => {resolve=r}) })
    const result = drafts.command(old.id, 1, 'send'); await Promise.resolve(); drafts.clear()
    const next = drafts.create({ agentId:'b', name:'B', text:'New', submit:async()=>({ok:true}) })
    resolve({ok:true}); const receipt: DraftState = await result
    expect(receipt.id).toBe(old.id)
    expect(await drafts.command(next.id, 1, 'state')).toMatchObject({ text:'New', active:true })
  })
})
