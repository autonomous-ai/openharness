/** Former-code record: optional readers provide facts; core alone admits or stops a conversation. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { ExternalProvider, ExternalSession, OwnerClaim, ProcessView } from './externals/types.js'

process.env.TZ = 'UTC'
const golden = fileURLToPath(new URL('./__fixtures__/external-shapes.golden.json', import.meta.url))
const quiet: ProcessView = { list: async () => [], openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map(), alive: () => true }

it('preserves external lists, exact ownership, conservative busy answers and core admission on both platforms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'external-shapes-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const result: Record<string, unknown> = {}
  try {
    for (const os of ['darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { value: os })
      vi.resetModules()
      const { externalShapes } = await import('../../testing/observerShapes.js')
      const work = join(root, os, 'work')
      mkdirSync(work, { recursive: true })
      const session = (id: string, extra: Partial<ExternalSession> = {}): ExternalSession => ({
        sessionId: id, engine: 'claude', cwd: work, origin: 'terminal', title: '', mtime: 100,
        transcriptPath: join(work, id + '.jsonl'), ...extra,
      })
      let broken = false
      const logs: string[] = []
      const providers: ExternalProvider[] = [
        { engine: 'claude', scan: async ctx => [session('first', { title: String(ctx.excluded(join(work, 'private'))) }), session('duplicate')] },
        { engine: 'hermes', scan: async () => { if (broken) throw new Error('store unavailable'); return [
          session('tip', { engine: 'hermes', mtime: 400, aliases: ['root', 'first'], launchArgs: ['-p', 'work'] }),
          session('duplicate', { engine: 'hermes', mtime: 200 }),
        ] } },
      ]
      const own = { bySession: () => undefined, byAgent: () => undefined, stoppedAgents: { list: () => [] }, search: { session: () => ({ title: 'Indexed title' }) } }
      const openOptions = { providers, view: () => quiet, ttys: async () => new Map<number, string | null>(), harnessTtys: async () => new Set<string>(), now: () => 1000 }
      const shapes = externalShapes({ providers, excluded: [work], log: line => logs.push(line) }, openOptions, own)
      const out: Record<string, unknown> = { cold: shapes.known(), scan: await shapes.scan(), alias: await shapes.lookup('root'), collision: await shapes.lookup('first') }
      broken = true
      out.lastGood = await shapes.scan()
      out.logs = logs
      out.missing = await shapes.lookup('missing') ?? null
      for (const engine of ['claude', 'codex', 'grok', 'pi'] as const) {
        const p: ExternalProvider = { engine, scan: async () => [], busy: engine === 'claude' ? async () => false
          : engine === 'codex' ? async () => true : engine === 'grok' ? async () => { throw new Error('unreadable') } : undefined }
        const one = externalShapes({ providers: [p] }, { ...openOptions, providers: [p] }, own)
        out[`busy/${engine}`] = await one.busy({ engine, pid: 7, record: '/fixture/record' })
      }
      const cases: Array<{ name: string; claim?: Partial<OwnerClaim>; tty?: string | null; harness?: boolean | null; busy?: boolean | null; extra?: Partial<ExternalSession>; owned?: boolean; saved?: boolean }> = [
        { name: 'free' }, { name: 'terminal', claim: {}, tty: '/dev/fixture-terminal', busy: false },
        { name: 'busy', claim: {}, tty: '/dev/fixture-terminal', busy: true },
        { name: 'unknown-busy', claim: {}, tty: '/dev/fixture-terminal', busy: null },
        { name: 'app', claim: { app: true }, tty: '/dev/fixture-terminal' },
        { name: 'args-only', claim: { fromArgs: true }, tty: '/dev/fixture-terminal' },
        { name: 'harness', claim: {}, tty: '/dev/fixture-terminal', harness: true },
        { name: 'unverified', claim: {}, tty: '/dev/fixture-terminal', harness: null },
        { name: 'no-tty', claim: {}, tty: null }, { name: 'archived', extra: { engine: 'codex', archived: true } },
        { name: 'gone-folder', extra: { cwd: join(root, 'missing') } }, { name: 'owned', owned: true },
        { name: 'saved-alias', saved: true, extra: { aliases: ['held'] } },
        { name: 'profile', extra: { engine: 'hermes', launchArgs: ['-p', 'work'], title: 'Named conversation' } },
      ]
      for (const test of cases) {
        const found = session('conversation', test.extra)
        const p: ExternalProvider = { engine: found.engine, scan: async () => [found],
          owners: async () => test.claim ? [{ sessionId: found.sessionId, pid: 7, record: '/fixture/record', ...test.claim }] : [],
          busy: async () => test.busy ?? null, confirmOwner: async () => ({ current: true, busy: test.busy ?? null }) }
        const one = externalShapes({ providers: [p] }, { ...openOptions, providers: [p],
          ttys: async () => new Map([[7, test.tty ?? null]]), harnessTtys: async () => test.harness === null ? null : new Set(test.harness ? [test.tty!] : []) },
          { ...own, bySession: () => test.owned ? {} as never : undefined, stoppedAgents: { list: () => test.saved ? [{ sessionId: 'held' } as never] : [] } })
        out[`${test.name}/open`] = await one.fresh()
        out[`${test.name}/owner`] = await one.owner('conversation')
        out[`${test.name}/working`] = await one.working('conversation')
        for (const takeOver of [null, 'idle', 'now', 'wait'] as const) {
          out[`${test.name}/${takeOver}`] = await one.adoption.adoptableSession('conversation', found.engine, takeOver)
        }
        out[`${test.name}/heldBy`] = await one.adoption.heldBy('conversation', { pid: 7, engine: found.engine, tty: test.tty ?? null, record: '/fixture/record' })
      }
      out.wrongEngine = await shapes.adoption.adoptableSession('first', 'codex', null)
      out.notFound = await shapes.adoption.adoptableSession('missing', 'claude', null)
      result[os] = JSON.parse(JSON.stringify(out).split(root).join('<fixture>'))
    }
    const text = JSON.stringify(result, null, 2) + '\n'
    expect(text).not.toContain(root)
    if (process.env.RECORD_EXTERNAL_SHAPES === '1') { mkdirSync(join(golden, '..'), { recursive: true }); writeFileSync(golden, text) }
    expect(result).toEqual(JSON.parse(readFileSync(golden, 'utf8')))
  } finally { Object.defineProperty(process, 'platform', platform); vi.resetModules(); rmSync(root, { recursive: true, force: true }) }
})
