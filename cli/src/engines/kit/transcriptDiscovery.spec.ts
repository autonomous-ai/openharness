import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TranscriptDiscovery } from './transcriptDiscovery.js'
import { locateTranscript, transcriptGroups } from './sessionLocation.js'
import { CURSOR_TRANSCRIPT } from '../cursor/contract.js'
vi.mock('./sessionLocation.js', () => ({ locateTranscript: vi.fn(), transcriptGroups: vi.fn(async () => ['p']) }))
const id = 'aaaaaaaa-1111-4222-8333-444444444444'
const runs: TranscriptDiscovery[] = []
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
const fresh = () => {
  const found = vi.fn()
  const discovery = new TranscriptDiscovery('/fixture', CURSOR_TRANSCRIPT, found, () => true, 10)
  runs.push(discovery)
  return { discovery, found }
}
afterEach(async () => { for (const run of runs.splice(0)) await run.stop(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers() })

it.each(['remove', 'stop'] as const)('revokes an initial lookup when %s happens before its answer', async action => {
  let answer!: (path: string | null) => void
  vi.mocked(locateTranscript).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
  const { discovery, found } = fresh()
  await discovery.start()
  const adding = discovery.add(id)
  if (action === 'remove') discovery.remove(id); else await discovery.stop()
  answer('/fixture/old.jsonl'); await adding
  expect(found).not.toHaveBeenCalled()
  expect(discovery.isPolling).toBe(false)
})

it('cannot publish a removed lookup through a replacement candidate with the same id', async () => {
  let old!: (path: string | null) => void
  vi.mocked(locateTranscript).mockReturnValueOnce(new Promise(resolve => { old = resolve }))
    .mockResolvedValueOnce('/fixture/new.jsonl')
  const { discovery, found } = fresh()
  const adding = discovery.add(id)
  discovery.remove(id)
  await discovery.add(id)
  old('/fixture/old.jsonl'); await adding
  expect(found).toHaveBeenCalledExactlyOnceWith(id, '/fixture/new.jsonl')
})

it('revokes a sweep after stop and a new start, even if the same session is pending again', async () => {
  vi.useFakeTimers()
  let old!: (path: string | null) => void
  vi.mocked(transcriptGroups).mockResolvedValue(['p'])
  vi.mocked(locateTranscript).mockResolvedValueOnce(null)
    .mockReturnValueOnce(new Promise(resolve => { old = resolve })).mockResolvedValue(null)
  const { discovery, found } = fresh()
  await discovery.start(); await discovery.add(id)
  await vi.advanceTimersByTimeAsync(10)
  expect(locateTranscript).toHaveBeenCalledTimes(2)
  await discovery.stop(); await discovery.start(); await discovery.add(id)
  old('/fixture/old.jsonl'); await vi.advanceTimersByTimeAsync(0)
  expect(found).not.toHaveBeenCalled()
  vi.mocked(locateTranscript).mockResolvedValue('/fixture/new.jsonl')
  await vi.advanceTimersByTimeAsync(10)
  expect(found).toHaveBeenCalledExactlyOnceWith(id, '/fixture/new.jsonl')
  expect(discovery.isPolling).toBe(false)
})


it('retries an initial native read failure instead of leaving the candidate marked looking', async () => {
  vi.useFakeTimers()
  vi.mocked(transcriptGroups).mockResolvedValue(['p'])
  vi.mocked(locateTranscript).mockRejectedValueOnce(new Error('unreadable candidate')).mockResolvedValue('/fixture/recovered.jsonl')
  const { discovery, found } = fresh()
  await discovery.start(); await expect(discovery.add(id)).resolves.toBeUndefined()
  expect(found).not.toHaveBeenCalled(); expect(discovery.isPolling).toBe(true)
  await vi.advanceTimersByTimeAsync(10)
  expect(found).toHaveBeenCalledExactlyOnceWith(id, '/fixture/recovered.jsonl')
  expect(discovery.isPolling).toBe(false)
})
it('holds only the failed sweep candidate and still publishes its sibling', async () => {
  vi.useFakeTimers()
  const sibling = 'bbbbbbbb-1111-4222-8333-444444444444'
  vi.mocked(transcriptGroups).mockResolvedValue(['p'])
  vi.mocked(locateTranscript).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('read unavailable')).mockResolvedValueOnce('/fixture/sibling.jsonl')
    .mockResolvedValue('/fixture/recovered.jsonl')
  const { discovery, found } = fresh()
  await discovery.start(); await discovery.add(id); await discovery.add(sibling)
  await vi.advanceTimersByTimeAsync(10)
  expect(found).toHaveBeenCalledExactlyOnceWith(sibling, '/fixture/sibling.jsonl')
  await vi.advanceTimersByTimeAsync(10)
  expect(found).toHaveBeenLastCalledWith(id, '/fixture/recovered.jsonl')
  expect(discovery.isPolling).toBe(false)
})
it('retains pending work across a failed group listing and reports a repeated hold once', async () => {
  vi.useFakeTimers()
  vi.mocked(locateTranscript).mockResolvedValueOnce(null).mockResolvedValue('/fixture/recovered.jsonl')
  vi.mocked(transcriptGroups).mockRejectedValueOnce('directory unavailable').mockRejectedValueOnce('directory unavailable').mockResolvedValue(['p'])
  const { discovery, found } = fresh()
  await discovery.start(); await discovery.add(id)
  await vi.advanceTimersByTimeAsync(20)
  expect(found).not.toHaveBeenCalled(); expect(console.error).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(10)
  expect(found).toHaveBeenCalledExactlyOnceWith(id, '/fixture/recovered.jsonl')
})
it.each(['remove', 'stop', 'replace'] as const)('does not revive a rejected lookup after %s', async action => {
  vi.useFakeTimers()
  let reject!: (error: Error) => void
  vi.mocked(locateTranscript).mockReturnValueOnce(new Promise((_, no) => { reject = no })).mockResolvedValue('/fixture/new.jsonl')
  const { discovery, found } = fresh()
  await discovery.start(); const adding = discovery.add(id)
  if (action === 'remove') discovery.remove(id)
  else if (action === 'stop') await discovery.stop()
  else await discovery.add(id)
  reject(new Error('old lookup failed')); await adding
  await vi.advanceTimersByTimeAsync(20)
  expect(found).toHaveBeenCalledTimes(action === 'replace' ? 1 : 0)
  expect(console.error).not.toHaveBeenCalled(); expect(discovery.isPolling).toBe(false)
})
it('retains a transcript whose publication throws, then retries it', async () => {
  vi.useFakeTimers()
  vi.mocked(transcriptGroups).mockResolvedValue(['p'])
  vi.mocked(locateTranscript).mockResolvedValue('/fixture/found.jsonl')
  const { discovery, found } = fresh()
  found.mockImplementationOnce(() => { throw new Error('publication unavailable') })
  await discovery.start(); await discovery.add(id)
  expect(discovery.isPolling).toBe(true)
  await vi.advanceTimersByTimeAsync(10)
  expect(found).toHaveBeenCalledTimes(2); expect(discovery.isPolling).toBe(false)
})
