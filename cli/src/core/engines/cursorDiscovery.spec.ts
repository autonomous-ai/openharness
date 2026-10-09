import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCursorDiscovery, type CursorDiscovery } from './cursorDiscovery.js'
import { inspectTranscriptPath } from '../../lib/registry.js'

vi.mock('../../engines/inProcess.js', () => ({ engineNow: () => { throw new Error('optional engine unavailable') } }))
vi.mock('../../lib/registry.js', () => ({ inspectTranscriptPath: vi.fn(() => true) }))
const root = mkdtempSync(join(tmpdir(), 'core-cursor-discovery-'))
let discovery: CursorDiscovery

afterEach(async () => { await discovery?.stop(); rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })

it('uses the declared data layout and registry validation without loading an engine', async () => {
  const id = 'aaaaaaaa-1111-4222-8333-444444444444'
  const path = join(root, 'projects', 'p', 'agent-transcripts', id, `${id}.jsonl`)
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '{}\n')
  const found = vi.fn()
  discovery = createCursorDiscovery(root, found)
  await discovery.start()
  await discovery.add(id)
  expect(found).toHaveBeenCalledExactlyOnceWith(id, path)
  expect(inspectTranscriptPath).toHaveBeenCalledTimes(2)
  expect(inspectTranscriptPath).toHaveBeenLastCalledWith('cursor', path)
  discovery.remove(id)
})
