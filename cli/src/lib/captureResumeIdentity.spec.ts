import { beforeEach, expect, it, vi } from 'vitest'
import { captureResumeIdentity } from './captureResumeIdentity.js'
import { engineKeepsTranscriptFile, type RegisteredSession } from './registry.js'
import { controlTranscriptEvidence, savedTranscriptEvidence } from '../engines/transcriptBindings.js'
import { findLiveSession, findResumedTranscript, processSessionEvidence } from './sessionRepair.js'
import { processRows, resumeSessionId } from './tmux.js'
vi.mock('./registry.js', () => ({ engineKeepsTranscriptFile: vi.fn(() => true) }))
vi.mock('../engines/transcriptBindings.js', () => ({ savedTranscriptEvidence: vi.fn(), controlTranscriptEvidence: vi.fn() }))
vi.mock('./sessionRepair.js', () => ({ processSessionEvidence: vi.fn(), findLiveSession: vi.fn(), findResumedTranscript: vi.fn() }))
vi.mock('./tmux.js', () => ({ processRows: vi.fn(), resumeSessionId: vi.fn() }))
vi.mock('./processEvidence.js', async () => {
  const { nativeConversationFixture } = await import('../testing/nativeConversationEvidence.js')
  const { processRows } = await import('./tmux.js')
  return { readProcessEvidence: (...args: Parameters<typeof import('./processEvidence.js')['readProcessEvidence']>) =>
    nativeConversationFixture(async () => [], processRows).processes(...args) }
})
let row: RegisteredSession
beforeEach(() => {
  vi.resetAllMocks()
  row = { engine: 'claude', sessionId: '', cwd: '/work', codexHome: null,
    processIdentity: { pid: 77, executable: '/bin/claude', startMarker: 'Mon Sep 21 01:00:00 2026' } } as RegisteredSession
  vi.mocked(processRows).mockResolvedValue([{ ...row.processIdentity!, args: 'claude', parentPid: 1 }])
  vi.mocked(savedTranscriptEvidence).mockImplementation((_engine, _id, path) => ({ path, fileKey: 'fixture', verify: vi.fn() }))
  vi.mocked(controlTranscriptEvidence).mockImplementation((_engine, _id, path) => ({ path, verify: vi.fn() }))
  vi.mocked(engineKeepsTranscriptFile).mockReturnValue(true)
  vi.mocked(resumeSessionId).mockReturnValue(null)
  vi.mocked(processSessionEvidence).mockResolvedValue({ session: null, verify: vi.fn() })
  vi.mocked(findLiveSession).mockResolvedValue(null)
  vi.mocked(findResumedTranscript).mockResolvedValue(null)
})
it('leaves a shell and a complete binding unchanged', async () => {
  row.engine = 'terminal'; expect(await captureResumeIdentity(row)).toBe(row)
  row.engine = 'codex'; row.sessionId = 'known'; row.transcriptPath = '/history'
  expect(await captureResumeIdentity(row)).toBe(row); expect(processRows).not.toHaveBeenCalled()
})

it('uses a completely proven parent transcript without changing the saved conversation', async () => {
  Object.assign(row, { sessionId: 'parent', transcriptPath: '/child' })
  vi.mocked(savedTranscriptEvidence).mockReturnValue({ path: '/parent', fileKey: 'parent-file', verify: vi.fn() })
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'parent', transcriptPath: '/parent' })
  expect(row.transcriptPath).toBe('/child')
  expect(findResumedTranscript).not.toHaveBeenCalled()
})

it('takes a database-backed engine on its recorded id, with no transcript to check', async () => {
  // opencode/kilo/hermes/devin keep the conversation in SQLite: there is no file, and demanding one
  // is what used to leave their resume with nothing to reopen.
  vi.mocked(engineKeepsTranscriptFile).mockReturnValue(false)
  Object.assign(row, { engine: 'opencode', sessionId: 'known' })
  expect(await captureResumeIdentity(row)).toBe(row)
  expect(findResumedTranscript).not.toHaveBeenCalled()
})

it('captures a database-backed engine id read off the live process', async () => {
  vi.mocked(engineKeepsTranscriptFile).mockReturnValue(false)
  row.engine = 'opencode'
  vi.mocked(findLiveSession).mockResolvedValue({ sessionId: 'live' })
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'live', source: 'stop-repair' })
})
it('captures and preserves the exact Hermes home before stopping its process', async () => {
  vi.mocked(engineKeepsTranscriptFile).mockReturnValue(false)
  Object.assign(row, { engine: 'hermes', hermesHome: '/known-home' })
  vi.mocked(findLiveSession).mockResolvedValue({ sessionId: 'live', hermesHome: '/known-home' })
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'live', hermesHome: '/known-home', source: 'stop-repair' })
  expect(findLiveSession).toHaveBeenCalledWith('hermes', '/work', expect.any(Number), expect.objectContaining({ hermesHome: '/known-home' }))
})
it.each([null, '/stale'])('repairs a known id with missing or invalid path %s', async transcriptPath => {
  Object.assign(row, { sessionId: 'known', transcriptPath, codexHome: '/profile' })
  vi.mocked(savedTranscriptEvidence).mockImplementation((_engine, _id, path) => ({ path: path === '/found' ? path : null, fileKey: 'fixture', verify: vi.fn() }))
  vi.mocked(findResumedTranscript).mockResolvedValue('/found')
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'known', transcriptPath: '/found' })
  expect(findResumedTranscript).toHaveBeenCalledWith('claude', 'known', { codexHome: '/profile' })
})
it.each([null, '/unsafe'])('holds the known id when its file is unavailable: %s', async path => {
  row.sessionId = 'known'; vi.mocked(findResumedTranscript).mockResolvedValue(path)
  vi.mocked(savedTranscriptEvidence).mockReturnValue({ path: null, fileKey: null, verify: vi.fn() })
  await expect(captureResumeIdentity(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(row.sessionId).toBe('known')
})
it('looks up a preallocated Pi session ID in its own project before stopping', async () => {
  Object.assign(row, { engine: 'pi', sessionId: 'preallocated', transcriptPath: null })
  expect(await captureResumeIdentity(row)).toBe(row)
  expect(findResumedTranscript).toHaveBeenCalledWith('pi', 'preallocated', { codexHome: undefined, cwd: '/work' })
  vi.mocked(findResumedTranscript).mockResolvedValue('/first-reply.jsonl')
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'preallocated', transcriptPath: '/first-reply.jsonl' })
})
// Pi keeps its sessions by project folder, and a row restored from an older record can have lost its
// folder. The lookup is asked with no folder rather than a null one, and its refusal ("the Pi conversation
// location is unavailable", sessionRepair) reaches the caller: Stop is then refused (stopAgentService),
// rather than killing an engine whose conversation could never be found again.
it('passes on the lookup\'s refusal for a Pi session whose project folder was not recorded', async () => {
  Object.assign(row, { engine: 'pi', sessionId: 'preallocated', transcriptPath: null, cwd: null })
  vi.mocked(findResumedTranscript).mockRejectedValue(new Error('The Pi conversation location is unavailable.'))
  await expect(captureResumeIdentity(row)).rejects.toThrow('The Pi conversation location is unavailable.')
  expect(findResumedTranscript).toHaveBeenCalledWith('pi', 'preallocated', { codexHome: undefined, cwd: undefined })
})
it.each(['identity', 'cwd', 'unknown', 'gone', 'pid', 'executable', 'start'])('refuses missing or changed process evidence: %s', async mode => {
  if (mode === 'identity') row.processIdentity = null
  if (mode === 'cwd') row.cwd = null
  if (mode === 'unknown') vi.mocked(processRows).mockResolvedValue(null)
  if (mode === 'gone') vi.mocked(processRows).mockResolvedValue([])
  if (mode === 'pid') row.processIdentity!.pid++
  if (mode === 'executable') row.processIdentity!.executable = 'other'
  if (mode === 'start') row.processIdentity!.startMarker = 'later'
  if (['unknown', 'executable', 'start'].includes(mode)) await expect(captureResumeIdentity(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  else expect(await captureResumeIdentity(row)).toBe(row)
  expect(findLiveSession).not.toHaveBeenCalled()
})
it.each(['claude', 'codex'] as const)('captures an explicit %s resume without guessing by directory', async engine => {
  row.engine = engine; vi.mocked(resumeSessionId).mockReturnValue('exact')
  vi.mocked(findResumedTranscript).mockResolvedValue('/exact')
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'exact', transcriptPath: '/exact', source: 'stop-repair' })
  expect(findLiveSession).not.toHaveBeenCalled()
})
it('holds an explicit file-backed resume whose announced conversation is unavailable', async () => {
  vi.mocked(resumeSessionId).mockReturnValue('exact')
  vi.mocked(findResumedTranscript).mockResolvedValue(null)
  await expect(captureResumeIdentity(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(findLiveSession).not.toHaveBeenCalled()
})
it('prefers current Claude native metadata to old resume argv', async () => {
  vi.mocked(resumeSessionId).mockReturnValue('old')
  vi.mocked(processSessionEvidence).mockResolvedValue({ session: { sessionId: 'current', transcriptPath: '/current' }, verify: vi.fn() })
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'current' }); expect(findResumedTranscript).not.toHaveBeenCalled()
  expect(processSessionEvidence).toHaveBeenCalledWith('claude', 77, '/work', Date.parse(row.processIdentity!.startMarker), expect.anything())
})
it('captures a unique fresh session before its first hook arrives', async () => {
  vi.mocked(findLiveSession).mockResolvedValue({ sessionId: 'new', transcriptPath: '/new' })
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'new', transcriptPath: '/new' })
  expect(row.sessionId).toBe('')
  expect(findLiveSession).toHaveBeenCalledWith('claude', '/work', Date.parse(row.processIdentity!.startMarker), expect.objectContaining({ pid: 77, bornOnly: true, codexHome: undefined, expectedProcess: row.processIdentity }))
})
it.each([null, { sessionId: 'missing' }, { sessionId: 'unsafe', transcriptPath: '/unsafe' }])('does not bind ambiguous or unsafe history: %s', async found => {
  vi.mocked(findLiveSession).mockResolvedValue(found)
  vi.mocked(savedTranscriptEvidence).mockReturnValue({ path: null, fileKey: null, verify: vi.fn() })
  if (found) await expect(captureResumeIdentity(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  else expect(await captureResumeIdentity(row)).toBe(row)
})
