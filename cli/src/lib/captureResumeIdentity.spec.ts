import { beforeEach, expect, it, vi } from 'vitest'
import { captureResumeIdentity } from './captureResumeIdentity.js'
import { engineKeepsTranscriptFile, validTranscriptPath, type RegisteredSession } from './registry.js'
import { claudeProcessSession, findLiveSession, findResumedTranscript } from './sessionRepair.js'
import { processRows, resumeSessionId } from './tmux.js'
vi.mock('./registry.js', () => ({ validTranscriptPath: vi.fn(() => true), engineKeepsTranscriptFile: vi.fn(() => true) }))
vi.mock('./sessionRepair.js', () => ({ claudeProcessSession: vi.fn(), findLiveSession: vi.fn(), findResumedTranscript: vi.fn() }))
vi.mock('./tmux.js', () => ({ processRows: vi.fn(), resumeSessionId: vi.fn() }))
let row: RegisteredSession
beforeEach(() => {
  vi.resetAllMocks()
  row = { engine: 'claude', sessionId: '', cwd: '/work', codexHome: null,
    processIdentity: { pid: 77, executable: '/bin/claude', startMarker: 'Mon Sep 21 01:00:00 2026' } } as RegisteredSession
  vi.mocked(processRows).mockResolvedValue([{ ...row.processIdentity!, args: 'claude', parentPid: 1 }])
  vi.mocked(validTranscriptPath).mockReturnValue(true)
  vi.mocked(engineKeepsTranscriptFile).mockReturnValue(true)
  vi.mocked(resumeSessionId).mockReturnValue(null)
  vi.mocked(claudeProcessSession).mockResolvedValue(null)
  vi.mocked(findLiveSession).mockResolvedValue(null)
  vi.mocked(findResumedTranscript).mockResolvedValue(null)
})
it('leaves a shell and a complete binding unchanged', async () => {
  row.engine = 'terminal'; expect(await captureResumeIdentity(row)).toBe(row)
  row.engine = 'codex'; row.sessionId = 'known'; row.transcriptPath = '/history'
  expect(await captureResumeIdentity(row)).toBe(row); expect(processRows).not.toHaveBeenCalled()
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
it.each([null, '/stale'])('repairs a known id with missing or invalid path %s', async transcriptPath => {
  Object.assign(row, { sessionId: 'known', transcriptPath, codexHome: '/profile' })
  vi.mocked(validTranscriptPath).mockImplementation((_, path) => path === '/found')
  vi.mocked(findResumedTranscript).mockResolvedValue('/found')
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'known', transcriptPath: '/found' })
  expect(findResumedTranscript).toHaveBeenCalledWith('claude', 'known', { codexHome: '/profile' })
})
it.each([null, '/unsafe'])('retains the known id when its file is unavailable: %s', async path => {
  row.sessionId = 'known'; vi.mocked(findResumedTranscript).mockResolvedValue(path)
  vi.mocked(validTranscriptPath).mockReturnValue(false); expect(await captureResumeIdentity(row)).toBe(row)
})
it.each(['identity', 'cwd', 'unknown', 'gone', 'pid', 'executable', 'start'])('refuses missing or changed process evidence: %s', async mode => {
  if (mode === 'identity') row.processIdentity = null
  if (mode === 'cwd') row.cwd = null
  if (mode === 'unknown') vi.mocked(processRows).mockResolvedValue(null)
  if (mode === 'gone') vi.mocked(processRows).mockResolvedValue([])
  if (mode === 'pid') row.processIdentity!.pid++
  if (mode === 'executable') row.processIdentity!.executable = 'other'
  if (mode === 'start') row.processIdentity!.startMarker = 'later'
  expect(await captureResumeIdentity(row)).toBe(row); expect(findLiveSession).not.toHaveBeenCalled()
})
it.each(['claude', 'codex'] as const)('captures an explicit %s resume without guessing by directory', async engine => {
  row.engine = engine; vi.mocked(resumeSessionId).mockReturnValue('exact')
  vi.mocked(findResumedTranscript).mockResolvedValue('/exact')
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'exact', transcriptPath: '/exact', source: 'stop-repair' })
  expect(findLiveSession).not.toHaveBeenCalled()
})
it('prefers current Claude native metadata to old resume argv', async () => {
  vi.mocked(resumeSessionId).mockReturnValue('old')
  vi.mocked(claudeProcessSession).mockResolvedValue({ sessionId: 'current', transcriptPath: '/current' })
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'current' }); expect(findResumedTranscript).not.toHaveBeenCalled()
})
it('captures a unique fresh session before its first hook arrives', async () => {
  vi.mocked(findLiveSession).mockResolvedValue({ sessionId: 'new', transcriptPath: '/new' })
  expect(await captureResumeIdentity(row)).toMatchObject({ sessionId: 'new', transcriptPath: '/new' })
  expect(row.sessionId).toBe('')
  expect(findLiveSession).toHaveBeenCalledWith('claude', '/work', Date.parse(row.processIdentity!.startMarker), { pid: 77, bornOnly: true, codexHome: undefined })
})
it.each([null, { sessionId: 'missing' }, { sessionId: 'unsafe', transcriptPath: '/unsafe' }])('does not bind ambiguous or unsafe history: %s', async found => {
  vi.mocked(findLiveSession).mockResolvedValue(found); vi.mocked(validTranscriptPath).mockReturnValue(false)
  expect(await captureResumeIdentity(row)).toBe(row)
})
