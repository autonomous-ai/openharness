import { describe, expect, it } from 'vitest'
import { SHARED_TAB_FRAME_MAX, sealedFrameBytes } from '../lib/e2ee/tabSession.js'
import { LIMITS, type Message } from './model.js'
import type { Roster } from './roster.js'
import { carries, checkHandedOver, cleanText, fitsRequest, RateCounter, REQUEST_ID_LENGTH, statusCode, WIRE_NAME_MAX, wireMessage } from './tabDelivery.js'

const TAB = 'a'.repeat(24)
const KEY = 'A'.repeat(43) + '='
const at = '2026-10-15T00:00:00.000Z'
/** Alice's tab: her lead on her mac, Bob's api and db on his mini, Carol's web. */
const roster: Roster = {
  sharedTabId: TAB, version: 4, name: 'app', leader: null, invites: [],
  owner: { accountId: 'u-alice', email: 'alice@x.io', machineId: 'alice-mac', machinePublicKey: KEY },
  members: [{ accountId: 'u-bob', email: 'bob@y.io', name: 'Bo‮b', acceptedAt: at }, { accountId: 'u-carol', email: 'carol@z.io', name: '', acceptedAt: at }],
  harnesses: [
    { accountId: 'u-alice', machineId: 'alice-mac', machinePublicKey: KEY, agentId: 'lead', name: 'lead', engine: 'codex' },
    { accountId: 'u-bob', machineId: 'bob-mini', machinePublicKey: KEY, agentId: 'api', name: 'api', engine: 'claude' },
    { accountId: 'u-bob', machineId: 'bob-mini', machinePublicKey: KEY, agentId: 'db', name: 'db', engine: 'claude' },
    { accountId: 'u-carol', machineId: 'carol-pc', machinePublicKey: KEY, agentId: 'web', name: 'web', engine: 'claude' },
  ],
}
const message = (over: Partial<Message> = {}, from: Partial<Message['from']> = {}): Message => ({
  id: 'm0000001', tabId: TAB, text: 'hello', at: 5,
  from: { machineId: 'alice-mac', agentId: 'lead', name: 'lead', engine: 'codex', machine: 'alice-studio', ...from },
  to: [{ machineId: 'bob-mini', agentId: 'api', name: 'api' }], ...over,
})
/** Bob's mini receives from Alice's mac, as the relay stamped it. */
const ctx = { sharedTabId: TAB, from: { machineId: 'alice-mac', userId: 'u-alice' } }
/** The machines' names as the receiving computer knows them (service.ts `machineName`), whatever a sender wrote. */
const MACHINES: Record<string, string> = { 'bob-mini': 'mi\u001bni', 'alice-mac': 'alice-studio', 'carol-pc': '' }
/** A receiving machine of an account: every harness of its own in the tab asked for here, unless `consented` says. */
const at_ = (accountId: string, machineId: string, consented: (agentId: string) => boolean = () => true) =>
  ({ accountId, machineId, consented, machineName: (id: string) => MACHINES[id] })
const bob = at_('u-bob', 'bob-mini')

describe('checkHandedOver: a message another account\'s machine hands over through a shared tab', () => {
  it('takes a message from a listed harness of the stamped account to listed harnesses of this account on this machine', () => {
    const checked = checkHandedOver(roster, ctx, message({ to: [{ machineId: 'bob-mini', agentId: 'api', name: 'api' }, { machineId: 'carol-pc', agentId: 'web', name: 'web' }] }), bob)
    expect(checked).toEqual({ ok: true, message: expect.objectContaining({ id: 'm0000001', from: expect.objectContaining({ accountId: 'u-alice', account: 'alice' }) }) })
  })

  it('refuses a sender on another machine than the one the relay stamped', () => {
    expect(checkHandedOver(roster, { ...ctx, from: { machineId: 'carol-pc', userId: 'u-alice' } }, message(), bob)).toEqual({ refused: expect.stringContaining('machine') })
  })

  it('refuses a sender the roster does not list (a forged `from`)', () => {
    expect(checkHandedOver(roster, ctx, message({}, { agentId: 'ghost' }), bob)).toEqual({ refused: expect.stringContaining('not in the shared tab') })
  })

  it('refuses a sender the roster lists under another account than the one the relay stamped', () => {
    // Carol's machine relabelled as Alice's harness: the roster lists `web` as Carol's, the relay says Alice sent it.
    const forged = message({}, { machineId: 'carol-pc', agentId: 'web' })
    expect(checkHandedOver(roster, { ...ctx, from: { machineId: 'carol-pc', userId: 'u-alice' } }, forged, bob)).toEqual({ refused: expect.stringContaining('another account') })
  })

  it('refuses a frame from this account itself, whose machines hand messages over through their own relay', () => {
    const own = message({}, { machineId: 'bob-mini', agentId: 'db' })
    expect(checkHandedOver(roster, { ...ctx, from: { machineId: 'bob-mini', userId: 'u-bob' } }, own, at_('u-bob', 'bob-laptop'))).toEqual({ refused: expect.stringContaining('this account') })
  })

  it('refuses a message that names another tab than the one it came through, or a roster of another tab', () => {
    expect(checkHandedOver(roster, ctx, message({ tabId: 'b'.repeat(24) }), bob)).toEqual({ refused: expect.stringContaining('another tab') })
    expect(checkHandedOver(roster, { ...ctx, sharedTabId: 'b'.repeat(24) }, message({ tabId: 'b'.repeat(24) }), bob)).toEqual({ refused: expect.stringContaining('another tab') })
  })

  it('refuses a recipient on this machine the roster does not list under this account, and a message with none here', () => {
    expect(checkHandedOver(roster, ctx, message({ to: [{ machineId: 'bob-mini', agentId: 'secret', name: 'secret' }] }), bob)).toEqual({ refused: expect.stringContaining('recipient') })
    // An unshared harness of Bob's that the owner listed under Carol's account (review of B1): not Bob's in this tab.
    const listedAsCarol = { ...roster, harnesses: [...roster.harnesses, { accountId: 'u-carol', machineId: 'bob-mini', machinePublicKey: KEY, agentId: 'private', name: 'private', engine: 'claude' }] }
    expect(checkHandedOver(listedAsCarol, ctx, message({ to: [{ machineId: 'bob-mini', agentId: 'private', name: 'private' }] }), bob)).toEqual({ refused: expect.stringContaining('recipient') })
    // Every recipient here must be listed: one listed beside one that is not is still refused.
    expect(checkHandedOver(roster, ctx, message({ to: [{ machineId: 'bob-mini', agentId: 'api', name: 'api' }, { machineId: 'bob-mini', agentId: 'secret', name: 's' }] }), bob)).toEqual({ refused: expect.stringContaining('recipient') })
    expect(checkHandedOver(roster, ctx, message({ to: [{ machineId: 'carol-pc', agentId: 'web', name: 'web' }] }), bob)).toEqual({ refused: expect.stringContaining('no harness on this computer') })
  })

  it('overwrites the account the sender wrote with the stamped account and the roster\'s name for it, never merging the two', () => {
    // From Bob, as Carol's computer receives it: the member's name in the roster, its control characters taken out.
    const fromBob = message({ to: [{ machineId: 'carol-pc', agentId: 'web', name: 'w\u001b[2Jeb' }] }, {
      machineId: 'bob-mini', agentId: 'api', name: 'a\u0007pi', engine: 'cl‮aude', machine: 'mi\u001bni', accountId: 'u-alice', account: 'Alice' })
    const checked = checkHandedOver(roster, { ...ctx, from: { machineId: 'bob-mini', userId: 'u-bob' } }, fromBob, at_('u-carol', 'carol-pc'))
    expect(checked).toEqual({ ok: true, message: { ...fromBob, to: [{ machineId: 'carol-pc', agentId: 'web', name: 'w[2Jeb' }],
      from: { machineId: 'bob-mini', agentId: 'api', name: 'api', engine: 'claude', machine: 'mini', accountId: 'u-bob', account: 'Bob' } } })
    // A sender that wrote no account at all gets one too: it cannot hide it. The owner, named by its address.
    const bare = checkHandedOver(roster, ctx, message(), bob) as { message: Message }
    expect(bare.message.from).toMatchObject({ accountId: 'u-alice', account: 'alice' })
    // Carol's member entry has no name: her address's label. A machine this computer has no name for shows `?`.
    const fromCarol = checkHandedOver(roster, { ...ctx, from: { machineId: 'carol-pc', userId: 'u-carol' } },
      message({}, { machineId: 'carol-pc', agentId: 'web', name: '‮', machine: '' }), bob) as { message: Message }
    expect(fromCarol.message.from).toMatchObject({ accountId: 'u-carol', account: 'carol', name: 'web', machine: '?' })
    const unnamed = { ...roster, harnesses: roster.harnesses.map((h) => (h.agentId === 'web' ? { ...h, name: '‮', engine: '' } : h)) }
    expect((checkHandedOver(unnamed, { ...ctx, from: { machineId: 'carol-pc', userId: 'u-carol' } },
      message({}, { machineId: 'carol-pc', agentId: 'web' }), bob) as { message: Message }).message.from).toMatchObject({ name: '?', engine: '?' })
  })

  it('heads a message with the name and engine the roster gives its sender and the machine name this computer knows, not what it claims', () => {
    // Bob's api calls itself the tab's lead, on Alice's machine, in Codex: shown as what the roster and this computer say.
    const posing = message({ to: [{ machineId: 'carol-pc', agentId: 'web', name: 'web' }] }, { machineId: 'bob-mini', agentId: 'api', name: 'lead', engine: 'codex', machine: 'alice-studio' })
    const checked = checkHandedOver(roster, { ...ctx, from: { machineId: 'bob-mini', userId: 'u-bob' } }, posing, at_('u-carol', 'carol-pc')) as { message: Message }
    expect(checked.message.from).toEqual({ machineId: 'bob-mini', agentId: 'api', name: 'api', engine: 'claude', machine: 'mini', accountId: 'u-bob', account: 'Bob' })
  })

  it('in another account\'s tab, takes a message only for harnesses this machine asked to put in it, and says NOT_IN_TAB otherwise', () => {
    // Bob took his db out while Alice's computer was away: her roster still lists it, his machine no longer consents.
    const asked = at_('u-bob', 'bob-mini', (agentId) => agentId === 'api')
    expect(checkHandedOver(roster, ctx, message(), asked)).toMatchObject({ ok: true })
    const toDb = message({ to: [{ machineId: 'bob-mini', agentId: 'db', name: 'db' }] })
    expect(checkHandedOver(roster, ctx, toDb, asked)).toEqual({ refused: expect.stringContaining('not put in the shared tab from here'), code: 'NOT_IN_TAB' })
    // One asked for beside one that is not: refused whole, as an unlisted recipient is.
    expect(checkHandedOver(roster, ctx, message({ to: [{ machineId: 'bob-mini', agentId: 'api', name: 'api' }, { machineId: 'bob-mini', agentId: 'db', name: 'db' }] }), asked))
      .toMatchObject({ code: 'NOT_IN_TAB' })
    // The owner's own tab needs no asking: Alice's machine takes Bob's message to her lead with no consent recorded.
    const fromBob = message({ to: [{ machineId: 'alice-mac', agentId: 'lead', name: 'lead' }] }, { machineId: 'bob-mini', agentId: 'api' })
    expect(checkHandedOver(roster, { ...ctx, from: { machineId: 'bob-mini', userId: 'u-bob' } }, fromBob, at_('u-alice', 'alice-mac', () => false))).toMatchObject({ ok: true })
  })
})

describe('the sender\'s side', () => {
  it('carries a message when the roster lists the sender under this account and every recipient on that machine under another', () => {
    expect(carries(roster, message(), 'bob-mini', 'u-alice')).toBe(true)
    expect(carries(roster, message({ to: [{ machineId: 'bob-mini', agentId: 'api', name: 'api' }, { machineId: 'bob-mini', agentId: 'db', name: 'db' }] }), 'bob-mini', 'u-alice')).toBe(true)
    // Bob's db left the tab; the sender is no longer in it; the sender is listed, but under another account.
    expect(carries(roster, message({ to: [{ machineId: 'bob-mini', agentId: 'gone', name: 'gone' }] }), 'bob-mini', 'u-alice')).toBe(false)
    expect(carries(roster, message({}, { agentId: 'cut' }), 'bob-mini', 'u-alice')).toBe(false)
    expect(carries(roster, message(), 'bob-mini', 'u-carol')).toBe(false)
    // A recipient this account's own: never carried through the tab.
    expect(carries(roster, message({ to: [{ machineId: 'bob-mini', agentId: 'db', name: 'db' }] }, { machineId: 'bob-mini', agentId: 'api' }), 'bob-mini', 'u-bob')).toBe(false)
    // Bob to Alice: carried the other way too.
    expect(carries(roster, message({ to: [{ machineId: 'alice-mac', agentId: 'lead', name: 'lead' }] }, { machineId: 'bob-mini', agentId: 'api' }), 'alice-mac', 'u-bob')).toBe(true)
  })

  it('puts on the wire the shared tab\'s id, no account of the sender\'s, and names cleaned and cut short', () => {
    const long = 'n'.repeat(300)
    const wire = wireMessage(message({ tabId: 'desk-tab', to: [{ machineId: 'bob-mini', agentId: 'api', name: `\u001b[2J${long}` }, { machineId: 'bob-mini', agentId: 'db', name: '‮' }] },
      { name: `le\u0007ad${long}`, engine: 'co\u001bdex', machine: '‮', accountId: 'u-alice', account: 'Alice' }), TAB)
    expect(wire).toEqual({ id: 'm0000001', tabId: TAB, text: 'hello', at: 5,
      from: { machineId: 'alice-mac', agentId: 'lead', name: `lead${long}`.slice(0, 200), engine: 'codex', machine: '?' },
      to: [{ machineId: 'bob-mini', agentId: 'api', name: `[2J${long}`.slice(0, WIRE_NAME_MAX) }, { machineId: 'bob-mini', agentId: 'db', name: '?' }] })
    expect(wireMessage(message({ fyi: true }), TAB).fyi).toBe(true)
  })

  it('measures a request as the relay carries it: a worst-case message with eight long names does not fit, a plain one does', () => {
    const plain = wireMessage(message({ text: 'x'.repeat(LIMITS.text) }), TAB)
    expect(fitsRequest({ action: 'deliver', message: plain })).toBe(true)
    // Every character one JSON writes as six bytes, to eight recipients with the longest ids and escaped names (review of A7).
    const worst = wireMessage(message({ text: '\u0001'.repeat(LIMITS.text), to: Array.from({ length: 8 }, (_, i) => (
      { machineId: '\u0001'.repeat(127) + i, agentId: '\u0001'.repeat(160), name: '"'.repeat(200) })) }), TAB)
    expect(fitsRequest({ action: 'deliver', message: worst })).toBe(false)
    // The measure is the frame's, with a request id as long as any.
    const payload = { action: 'deliver', message: plain }
    expect(fitsRequest(payload)).toBe(sealedFrameBytes({ kind: 'agent_messages', rid: 'f'.repeat(REQUEST_ID_LENGTH), ...payload }) <= SHARED_TAB_FRAME_MAX)
  })

  it('shows another account\'s words cleaned and cut short, and takes only a code that looks like one', () => {
    expect(cleanText('re\u001b[2Jfused‮', 9)).toBe('re[2Jfuse')
    expect(cleanText(42, 9)).toBe('')
    expect(statusCode('NOT_IN_TAB')).toBe('NOT_IN_TAB')
    for (const bad of ['not_in_tab', 'X'.repeat(33), '\u001bA', 7, undefined]) expect(statusCode(bad)).toBeUndefined()
  })
})

describe('RateCounter', () => {
  it('takes up to the limit within the window, keeps keys apart, and takes again once the oldest leaves the window', () => {
    const c = new RateCounter()
    for (let i = 0; i < 3; i++) expect(c.take('tab', 3, 1000, i)).toBe(true)
    expect(c.room('tab', 3, 1000, 10)).toBe(false)
    expect(c.take('tab', 3, 1000, 10)).toBe(false)
    expect(c.take('other', 3, 1000, 10)).toBe(true)
    // A refusal takes nothing: at 1000 the first has left, and exactly one more fits.
    expect(c.take('tab', 3, 1000, 1000)).toBe(true)
    expect(c.take('tab', 3, 1000, 1000)).toBe(false)
    expect(c.room('tab', 3, 1000, 5000)).toBe(true)
  })
})
