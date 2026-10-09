import { expect, it, vi } from 'vitest'
import { createExternalSessions } from './externalSessions.js'
import { externalReadFailed } from '../lib/sessionSearch/evidence.js'
import { externalProcessGeneration } from '../lib/externalProcessGeneration.js'
import { processView, processTtys, harnessTtys } from '../lib/sessionSearch/externals/support.js'
import type { ExternalProvider, ExternalSession, OwnerClaim, ProcessView } from '../lib/sessionSearch/externals/types.js'
vi.mock('../lib/externalProcessGeneration.js', () => ({ externalProcessGeneration: vi.fn(() => 'ps:1000') }))
vi.mock('../lib/sessionSearch/externals/support.js', async original => ({ ...await original<object>(),
  processView: vi.fn(), processTtys: vi.fn(), harnessTtys: vi.fn() }))

const target = { sessionId: 'conversation', engine: 'claude' as const }
const session: ExternalSession = { ...target, cwd: '/workspace', origin: 'terminal', title: '', mtime: 10, transcriptPath: '/store/conversation.jsonl' }
function fixture() {
  const claim: OwnerClaim = { sessionId: target.sessionId, pid: 7, record: '/store/process.json' }
  const provider: ExternalProvider = { engine: 'claude', scan: vi.fn(async () => [session]), owners: vi.fn(async () => []),
    confirmOwner: vi.fn(async () => ({ current: true, busy: false })) }
  const view: ProcessView = { list: vi.fn(async () => [{ pid: 7, ppid: 1, executable: 'fixture', args: '', generation: 'ps:1000' }]),
    openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map(), alive: () => true }
  const generation = vi.fn((): string | null => 'ps:1000')
  const options = { providers: [provider], generation, title: () => 'Indexed title',
    open: { view: () => view, ttys: vi.fn(async () => new Map([[7, '/dev/fixture-terminal']])), harnessTtys: vi.fn(async (): Promise<Set<string> | null> => new Set()) } }
  return { claim, provider, view, options, generation, reader: createExternalSessions(options) }
}

it.each(['terminal', 'activity'] as const)('rejects same-PID conversation changes during the %s read', async point => {
  const f = fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  vi.mocked(f.provider.owners!).mockResolvedValue([f.claim])
  if (point === 'terminal') f.options.open.ttys.mockImplementation(async () => { await gate; return new Map([[7, '/dev/fixture-terminal']]) })
  else vi.mocked(f.provider.confirmOwner!).mockImplementation(async () => { await gate; return { current: false, busy: false } })
  const answer = f.reader.inspect(target)
  await vi.waitFor(() => expect(point === 'terminal' ? f.options.open.ttys : f.provider.confirmOwner).toHaveBeenCalled())
  vi.mocked(f.provider.owners!).mockResolvedValue([{ ...f.claim, sessionId: 'another-conversation' }])
  finish()
  expect(await answer).toMatchObject({ ok: false, error: 'SEARCH_UNAVAILABLE' })
})

it.each(['record', 'contender', 'app'] as const)('rejects %s owner evidence that changes while terminal evidence is read', async change => {
  const f = fixture()
  vi.mocked(f.provider.owners!).mockResolvedValue([f.claim])
  f.options.open.ttys.mockImplementation(async () => {
    vi.mocked(f.provider.owners!).mockResolvedValue(change === 'record' ? [{ ...f.claim, record: '/other-record' }]
      : change === 'app' ? [{ ...f.claim, app: true }] : [f.claim, { ...f.claim, pid: 8 }])
    return new Map([[7, '/dev/fixture-terminal']])
  })
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false, error: 'SEARCH_UNAVAILABLE' })
})

it('supplies fresh metadata and ownership without a SQLite index, preserving canonical aliases', async () => {
  const f = fixture()
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, session: { title: 'Indexed title' }, owner: null, busy: false })
  vi.mocked(f.provider.scan).mockResolvedValue([{ ...session, aliases: ['old'] }])
  expect(await f.reader.inspect({ ...target, sessionId: 'old' })).toMatchObject({ ok: true, session: { sessionId: 'conversation' } })
  vi.mocked(f.provider.scan).mockResolvedValue([])
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, session: null })
  expect(await f.reader.inspect({})).toMatchObject({ ok: false })
  expect(await f.reader.inspect({ ...target, engine: 'codex' })).toMatchObject({ ok: false })
})

it('never uses last-good catalog data to authorize an unavailable reader', async () => {
  const f = fixture()
  await f.reader.sessions.scan()
  vi.mocked(f.provider.scan).mockImplementation(async () => { externalReadFailed({ code: 'EACCES' }); return [] })
  expect(f.reader.sessions.get('conversation')).toBeDefined()
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false, error: 'SEARCH_UNAVAILABLE' })
  vi.mocked(f.provider.scan).mockRejectedValue(new Error('unloaded'))
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
})

it('uses the newest canonical record before aliases, exactly as the catalog does', async () => {
  const f = fixture()
  vi.mocked(f.provider.scan).mockResolvedValue([
    { ...session, cwd: '/older', mtime: 1 },
    { ...session, sessionId: 'other', aliases: ['conversation'], cwd: '/alias', mtime: 100 },
    { ...session, cwd: '/newest', mtime: 50 },
  ])
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, session: { cwd: '/newest' } })
})

it('holds conflicting exact records/app evidence and missing terminal evidence', async () => {
  const f = fixture()
  for (const other of [{ ...f.claim, record: '/different' }, { ...f.claim, app: true }]) {
    vi.mocked(f.provider.owners!).mockResolvedValue([f.claim, other])
    expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
  }
  vi.mocked(f.provider.owners!).mockResolvedValue([f.claim, { ...f.claim }])
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true })
  f.options.open.ttys.mockResolvedValue(new Map())
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
})

it.each(['initial', 'later'] as const)('holds a same-PID unrelated exact conversation seen in the %s ownership pass', async when => {
  const f = fixture(), both = [f.claim, { ...f.claim, sessionId: 'another-conversation', record: '/store/another.json' }]
  vi.mocked(f.provider.owners!).mockResolvedValue(both)
  if (when === 'later') vi.mocked(f.provider.owners!).mockResolvedValueOnce([f.claim])
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false, error: 'SEARCH_UNAVAILABLE' })
  expect(f.provider.confirmOwner).not.toHaveBeenCalled()
  // Startup arguments can name a previous conversation; they do not contradict an exact record.
  vi.mocked(f.provider.owners!).mockResolvedValue([f.claim, { ...both[1], fromArgs: true }])
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true })
})

it('checks process generation after the activity read and treats tmux permission failure as unknown', async () => {
  const f = fixture()
  vi.mocked(f.provider.owners!).mockResolvedValue([f.claim])
  vi.mocked(f.provider.confirmOwner!).mockImplementation(async () => { f.generation.mockReturnValue(null); return { current: true, busy: false } })
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
  f.generation.mockReturnValue('ps:1000')
  vi.mocked(f.provider.confirmOwner!).mockResolvedValue({ current: true, busy: false })
  const { harnessTtys } = await vi.importActual<typeof import('../lib/sessionSearch/externals/support.js')>('../lib/sessionSearch/externals/support.js')
  f.options.open.harnessTtys.mockImplementation(() => harnessTtys(async () => ({ failed: true, stdout: '',
    stderr: 'error connecting to /fixture/socket (Permission denied)' }), true))
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, owner: { unverified: true } })
})

it('refuses unavailable or conflicting owners and changed process incarnations', async () => {
  const f = fixture()
  vi.mocked(f.provider.owners!).mockRejectedValueOnce(new Error('unreadable'))
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
  vi.mocked(f.provider.owners!).mockResolvedValueOnce([f.claim, { ...f.claim, pid: 8 }])
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
  vi.mocked(f.provider.owners!).mockResolvedValue([f.claim])
  f.generation.mockReturnValue(null)
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
  f.generation.mockReturnValue('ps:1000')
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, owner: { pid: 7 }, generation: 'ps:1000', busy: false })
  f.provider.owners = undefined
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
})

it('keeps app, argument-only, Harness and unverifiable pane owners distinguishable; unknown activity stays busy', async () => {
  const f = fixture()
  vi.mocked(f.provider.confirmOwner!).mockResolvedValue({ current: true, busy: true })
  for (const flags of [{ app: true }, { fromArgs: true }, {}]) {
    vi.mocked(f.provider.owners!).mockResolvedValue([{ ...f.claim, ...flags }])
    const answer = await f.reader.inspect(target)
    expect(answer).toMatchObject({ ok: true, owner: flags.app ? { tty: null } : flags.fromArgs ? { fromArgs: true } : { tty: '/dev/fixture-terminal' } })
    if (flags.app || flags.fromArgs) expect(answer).not.toHaveProperty('busyConfirmed')
  }
  f.options.open.harnessTtys.mockResolvedValue(new Set(['/dev/fixture-terminal']))
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, owner: { harness: true } })
  f.options.open.harnessTtys.mockResolvedValue(null)
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, owner: { unverified: true } })
  vi.mocked(f.provider.confirmOwner!).mockImplementation(async () => { externalReadFailed({ code: 'ENOENT' }); return { current: true, busy: false } })
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false })
  f.provider.confirmOwner = undefined
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, busy: true })
})

it('reads coherent activity after a deferred second ownership pass and never turns unknown into an interrupted turn', async () => {
  const f = fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  vi.mocked(f.provider.owners!).mockResolvedValueOnce([f.claim]).mockImplementationOnce(async () => { await gate; return [f.claim] })
  const reading = f.reader.inspect(target)
  await vi.waitFor(() => expect(f.provider.owners).toHaveBeenCalledTimes(2))
  vi.mocked(f.provider.confirmOwner!).mockResolvedValue({ current: true, busy: true })
  finish()
  expect(await reading).toMatchObject({ ok: true, busy: true, busyConfirmed: true })
  vi.mocked(f.provider.owners!).mockResolvedValue([f.claim])
  for (const proof of [null, { current: true, busy: null }]) {
    vi.mocked(f.provider.confirmOwner!).mockResolvedValue(proof)
    const answer = await f.reader.inspect(target)
    expect(answer).toMatchObject({ ok: true, busy: true })
    expect(answer).not.toHaveProperty('busyConfirmed')
  }
})

it('uses fresh provider facts after cold discovery finds an ID from another engine', async () => {
  for (const result of ['found', 'missing', 'failed'] as const) {
    const f = fixture()
    vi.mocked(f.provider.scan).mockResolvedValue([])
    const other: ExternalProvider = { engine: 'codex', scan: vi.fn(async () => [{ ...session, engine: 'codex' as const }]) }
    vi.mocked(other.scan).mockImplementationOnce(async () => [{ ...session, engine: 'codex' }])
    if (result === 'missing') vi.mocked(other.scan).mockResolvedValue([])
    if (result === 'failed') vi.mocked(other.scan).mockImplementation(async () => { throw new Error('reader failed') })
    const reader = createExternalSessions({ ...f.options, providers: [f.provider, other] })
    expect(await reader.inspect(target)).toMatchObject(result === 'failed' ? { ok: false } :
      { ok: true, session: result === 'missing' ? null : { engine: 'codex' } })
    expect(other.scan).toHaveBeenCalledTimes(2)
  }
})

it('bounds the actual provider reads even when callers give up waiting', async () => {
  const f = fixture(), finish: Array<(sessions: ExternalSession[]) => void> = []
  vi.mocked(f.provider.scan).mockImplementation(() => new Promise(resolve => finish.push(resolve)))
  const pending = Array.from({ length: 4 }, () => f.reader.inspect(target))
  expect(await f.reader.inspect(target)).toMatchObject({ ok: false, detail: expect.stringContaining('finish verifying') })
  expect(f.provider.scan).toHaveBeenCalledTimes(4)
  for (const resolve of finish) resolve([session])
  expect((await Promise.all(pending)).every(answer => answer.ok)).toBe(true)
  vi.mocked(f.provider.scan).mockResolvedValue([session])
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true })
})

it('rechecks the OS incarnation from its snapshot using default readers and preserves unknown terminals', async () => {
  const f = fixture()
  vi.mocked(processView).mockReturnValue(f.view)
  vi.mocked(processTtys).mockResolvedValue(new Map([[7, '/dev/fixture-terminal']]))
  vi.mocked(harnessTtys).mockResolvedValue(new Set())
  vi.mocked(externalProcessGeneration).mockReturnValue('ps:1000')
  vi.mocked(f.provider.owners!).mockResolvedValue([f.claim])
  const reader = createExternalSessions({ providers: [f.provider] })
  expect(await reader.inspect(target)).toMatchObject({ ok: true, generation: 'ps:1000', session: { title: '' } })
  vi.mocked(externalProcessGeneration).mockReturnValue('ps:2000')
  expect(await reader.inspect(target)).toMatchObject({ ok: false })
  vi.mocked(f.view.list).mockResolvedValue([{ pid: 7, ppid: 1, executable: 'fixture', args: '' }])
  expect(await reader.inspect(target)).toMatchObject({ ok: false })
  vi.mocked(f.view.list).mockResolvedValue([])
  expect(await reader.inspect(target)).toMatchObject({ ok: false })
  vi.mocked(processTtys).mockResolvedValue(new Map([[7, null]]))
  expect(await reader.inspect(target)).toMatchObject({ ok: true, owner: { tty: null } })
  vi.mocked(f.provider.owners!).mockResolvedValue([{ ...f.claim, pid: 0 }])
  expect(await reader.inspect(target)).toMatchObject({ ok: false })
})
