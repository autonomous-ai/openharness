import { expect, it, vi } from 'vitest'
import { createExternalSessions } from './externalSessions.js'
import { externalReadFailed } from '../lib/sessionSearch/evidence.js'
import type { ExternalProvider, ExternalSession, OwnerClaim, ProcessView } from '../lib/sessionSearch/externals/types.js'

const target = { sessionId: 'conversation', engine: 'claude' as const }
const session: ExternalSession = { ...target, cwd: '/workspace', origin: 'terminal', title: '', mtime: 10, transcriptPath: '/store/conversation.jsonl' }
function fixture() {
  const claim: OwnerClaim = { sessionId: target.sessionId, pid: 7, record: '/store/process.json' }
  const provider: ExternalProvider = { engine: 'claude', scan: vi.fn(async () => [session]), owners: vi.fn(async () => []), busy: vi.fn(async () => false) }
  const view: ProcessView = { list: vi.fn(async () => [{ pid: 7, ppid: 1, executable: 'fixture', args: '', generation: 'ps:1000' }]),
    openFiles: async () => new Map(), openFilesOf: async () => new Map(), alive: () => true }
  const generation = vi.fn((): string | null => 'ps:1000')
  const options = { providers: [provider], generation, title: () => 'Indexed title',
    open: { view: () => view, ttys: vi.fn(async () => new Map([[7, '/dev/fixture-terminal']])), harnessTtys: vi.fn(async (): Promise<Set<string> | null> => new Set()) } }
  return { claim, provider, view, options, generation, reader: createExternalSessions(options) }
}

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
  for (const flags of [{ app: true }, { fromArgs: true }, {}]) {
    vi.mocked(f.provider.owners!).mockResolvedValue([{ ...f.claim, ...flags }])
    expect(await f.reader.inspect(target)).toMatchObject({ ok: true, owner: flags.app ? { tty: null } : flags.fromArgs ? { fromArgs: true } : { tty: '/dev/fixture-terminal' } })
  }
  f.options.open.harnessTtys.mockResolvedValue(new Set(['/dev/fixture-terminal']))
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, owner: { harness: true } })
  f.options.open.harnessTtys.mockResolvedValue(null)
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, owner: { unverified: true } })
  vi.mocked(f.provider.busy!).mockImplementation(async () => { externalReadFailed({ code: 'ENOENT' }); return false })
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, busy: true })
  f.provider.busy = undefined
  expect(await f.reader.inspect(target)).toMatchObject({ ok: true, busy: true })
})
