import { createHash } from 'node:crypto'
import { cloudPresentationFingerprint as cloudFingerprint } from './cards.js'
import { expect, it } from 'vitest'
import { cloudHarnessIn, type CloudHarness } from '../lib/cloudAgents.js'
import { emptyPresentation, prepareCloudCards } from './cards.js'

const createCloudCards = () => {
  let accepted = emptyPresentation()
  return (rows: readonly CloudHarness[], reconnect = false) => {
    const prepared = prepareCloudCards(rows, reconnect ? emptyPresentation() : accepted)
    accepted = prepared.next
    return prepared.cards
  }
}

const row = (over: Partial<CloudHarness> = {}): CloudHarness => ({
  agentId: 'cloud_a', agent: 'fo', name: 'Fixture', state: 'working', activity: null,
  repository: null, branch: null, links: [], messages: 1,
  createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', ...over,
})

it('restores busy tiles on reconnect without replaying finished notifications', () => {
  const cards = createCloudCards()
  const working = row({ activity: 'Reading' })
  const initial = cards([working])
  expect(initial).toEqual([{ type: 'commander_event', agentId: 'cloud_a', dbSessionId: 'cloud_a',
    payload: { kind: 'processing', text: 'Reading' } }])
  expect(cards([working])).toEqual([])
  expect(cards([working], true)).toEqual(initial)
  const done = row({ state: 'idle', said: 'Finished', card: { recap: 'Finished', text: 'Result' } })
  expect(cards([done])).toMatchObject([{ payload: { kind: 'summary', notification: { id: 'cloud_a:1', kind: 'done' } } }])
  expect(cards([done], true)).toEqual([])
  expect(cards([done])).toEqual([])
})

it('drops removed owners and treats returning answers as history', () => {
  const cards = createCloudCards()
  const done = row({ state: 'idle', said: 'Old answer', card: { recap: 'Old', text: 'Answer' } })
  expect(cards([done])).toEqual([])
  expect(cards([])).toEqual([])
  expect(cards([done])).toEqual([])
  expect(cards([row({ state: 'stopped', said: 'New answer' })])).toEqual([])
  expect(cards([row({ state: 'starting' })])).toMatchObject([{ payload: { kind: 'processing' } }])
  expect(cards([row({ state: 'failed', activity: 'Stopped' })])).toMatchObject([{ payload: { kind: 'error', text: 'Stopped' } }])
})


it('prepares a candidate without mutating the accepted transition checkpoint', () => {
  const working = prepareCloudCards([row()]).next
  const before = structuredClone(working)
  const finished = row({ state: 'idle', said: 'Finished', card: { recap: 'Finished', text: 'Result' } })
  const first = prepareCloudCards([finished], working)
  expect(working).toEqual(before)
  expect(prepareCloudCards([finished], working)).toEqual(first)
  expect(prepareCloudCards([finished], first.next).cards).toEqual([])
})

it.each<[string, CloudHarness[]]>([
  ['empty', []],
  ['absent optional fields', [row()]],
  ['explicit null fields', [row({ said: null, card: null, providerStatus: { status: null, detail: null } })]],
  ['multiple owners', [row(), row({ agentId: 'cloud_b', agent: 'devin-cloud', name: 'Second' })]],
  ['reversed owners', [row({ agentId: 'cloud_b', agent: 'cursor-cloud', name: 'Second' }), row()]],
  ['escaped and multibyte text', [row({ name: 'A "quoted" \\ name\nđ\uD800', activity: 'Working\0\uDC00😀',
    repository: 'owner/đ', branch: 'fix/😀', said: '\0\n\\"\uD800\uDC00đ😀',
    card: { recap: 'Done \uD800', text: '\0\n\\"\uDC00đ😀' },
    links: [{ label: 'Link\0😀', url: 'https://example.test/\uD800' }] })]],
  ['maximum normalized fields', [row({ name: 'N'.repeat(120), activity: '\0'.repeat(200),
    repository: 'R'.repeat(200), branch: 'B'.repeat(200), said: '\0'.repeat(4000),
    card: { recap: '\0'.repeat(2000), text: '\uD800'.repeat(2000) },
    providerStatus: { status: '\0'.repeat(200), detail: '😀'.repeat(100) },
    links: Array.from({ length: 8 }, () => ({ label: 'L'.repeat(80), url: `https://${'\0'.repeat(2040)}` })) })]],
])('preserves exact image and singleton hash bytes for %s', (_name, values) => {
  const rows = values.map(value => cloudHarnessIn(value)!)
  const prepared = prepareCloudCards(rows)
  expect(prepared.next.fingerprint).toBe(cloudFingerprint(rows))
  expect(prepared.next.owners.map(owner => owner.fingerprint)).toEqual(rows.map(value => createHash('sha256').update(JSON.stringify([value])).digest('hex')))
  expect(prepared).toHaveProperty('imageBytes', Buffer.byteLength(JSON.stringify(rows)))
  const imageBytes = Buffer.byteLength(JSON.stringify(rows))
  expect(Buffer.byteLength(JSON.stringify({ harnesses: [], cards: prepared.cards })) - 2 + imageBytes)
    .toBe(Buffer.byteLength(JSON.stringify({ harnesses: rows, cards: prepared.cards })))
})

it.each(['failed', 'needs_input'] as const)('preserves the full %s completion card and its payload bytes', state => {
  const before = prepareCloudCards([row()]).next
  const finished = cloudHarnessIn(row({ state, said: 'Finished', card: { recap: '\0'.repeat(2000), text: '\uD800'.repeat(2000) } }))!
  const prepared = prepareCloudCards([finished], before)
  expect(prepared.cards).toEqual([{ type: 'commander_event', agentId: 'cloud_a', dbSessionId: 'cloud_a', name: 'Fixture',
    payload: { kind: 'summary', ...finished.card, ...(state === 'failed' ? { failed: true } : {}),
      notification: state === 'needs_input' ? null : { id: 'cloud_a:1', kind: 'done' } } }])
  expect(prepared.next.fingerprint).toBe(cloudFingerprint([finished]))
  expect(Buffer.byteLength(JSON.stringify({ harnesses: [], cards: prepared.cards })) - 2 + prepared.imageBytes)
    .toBe(Buffer.byteLength(JSON.stringify({ harnesses: [finished], cards: prepared.cards })))
})

it('preserves the fallback error card when a failed turn has no activity or answer', () => {
  const prepared = prepareCloudCards([row({ state: 'failed' })], prepareCloudCards([row()]).next)
  expect(prepared.cards).toEqual([{ type: 'commander_event', agentId: 'cloud_a', dbSessionId: 'cloud_a',
    payload: { kind: 'error', text: 'It stopped with an error.' } }])
})
