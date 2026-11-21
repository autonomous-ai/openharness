import { afterEach, expect, it, vi } from 'vitest'
import { transferCloudPresentation } from './transfer.js'
import { cloudHarnessIn } from '../lib/cloudAgents.js'
import { emptyOwnerCore } from '../testing/cloudOwners.js'
import { emptySessionFingerprint, SESSION_OWNER_CHUNK_BYTES, type OwnerCard } from '../lib/sessionOwnerWire.js'

const row = () => cloudHarnessIn({ agentId: 'cloud_a', agent: 'fo', name: 'Agent', state: 'working', activity: null,
  repository: null, branch: null, links: [], messages: 0, createdAt: '0', updatedAt: '0' })!
const within = async <T>(value: T | Promise<T>): Promise<T> => value
const fingerprint = emptySessionFingerprint()
afterEach(() => vi.restoreAllMocks())

it.each(['expired', 'disconnected'] as const)('sends nothing after an %s capture', async reason => {
  const core = emptyOwnerCore(), begin = vi.spyOn(core, 'begin')
  await expect(transferCloudPresentation(core, [row()], [], fingerprint, fingerprint, within,
    () => reason !== 'disconnected', reason === 'expired' ? 0 : 10_000)).rejects.toThrow('CLOUD_PUBLICATION_UNAVAILABLE')
  expect(begin).not.toHaveBeenCalled()
})

it('preserves an explicit begin refusal and never appends or cancels another owner stage', async () => {
  const core = emptyOwnerCore(), append = vi.spyOn(core, 'append'), cancel = vi.spyOn(core, 'cancel')
  core.begin = () => ({ ok: false, error: 'SESSION_OWNER_BUSY' })
  expect(await transferCloudPresentation(core, [row()], [], fingerprint, fingerprint, within, () => true, 10_000))
    .toEqual({ ok: false, error: 'SESSION_OWNER_BUSY' })
  expect(append).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
})

it.each(['row too large', 'card without row'] as const)('cancels its admitted stage after %s without committing a prefix', async reason => {
  const core = emptyOwnerCore(), cancel = vi.spyOn(core, 'cancel'), end = vi.spyOn(core, 'end')
  const input = row(), cards: OwnerCard[] = reason === 'card without row'
    ? [{ type: 'commander_event', agentId: 'cloud_absent', dbSessionId: 'cloud_absent', payload: {} }] : []
  if (reason === 'row too large') input.createdAt = '0' + ' '.repeat(SESSION_OWNER_CHUNK_BYTES)
  const result = await transferCloudPresentation(core, [input], cards, fingerprint, fingerprint, within, () => true, 10_000)
  expect(result).toEqual({ ok: false, error: reason === 'row too large' ? 'SESSION_OWNER_LIMIT' : 'SESSION_OWNER_INVALID' })
  expect(end).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce()
})
