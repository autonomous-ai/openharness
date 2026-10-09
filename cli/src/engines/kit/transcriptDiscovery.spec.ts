import { afterEach, expect, it, vi } from 'vitest'
import { TranscriptDiscovery } from './transcriptDiscovery.js'
import { locateTranscript, transcriptGroups } from './sessionLocation.js'
import { CURSOR_TRANSCRIPT } from '../cursor/contract.js'
vi.mock('./sessionLocation.js', () => ({ locateTranscript: vi.fn(), transcriptGroups: vi.fn(async () => ['p']) }))
const id = 'aaaaaaaa-1111-4222-8333-444444444444'
const runs: TranscriptDiscovery[] = []
const fresh = () => {
  const found = vi.fn()
  const discovery = new TranscriptDiscovery('/fixture', CURSOR_TRANSCRIPT, found, () => true, 10)
  runs.push(discovery)
  return { discovery, found }
}
afterEach(async () => { for (const run of runs.splice(0)) await run.stop(); vi.resetAllMocks(); vi.useRealTimers() })

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
