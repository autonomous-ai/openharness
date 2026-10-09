/** Former-code record for the optional usage reader and the facts delivered to agent frames. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'

process.env.TZ = 'UTC'
const golden = fileURLToPath(new URL('./__fixtures__/usage-shapes.golden.json', import.meta.url))
const at = '2026-10-01T00:00:00Z'
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('')
const claude = (id: string, input = 100, output = 20, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', timestamp: at, sessionId: 'conversation', requestId: `request-${id}`,
  message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } }, ...extra,
})
const codex = (input: number, output: number, last?: [number, number], timestamp = at) => ({
  type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: output, reasoning_output_tokens: output / 2 },
    ...(last ? { last_token_usage: { input_tokens: last[0], cached_input_tokens: last[0] / 2, output_tokens: last[1], reasoning_output_tokens: last[1] / 2 } } : {}),
  } },
})

it('preserves unknown, incremental, fork, rewrite, output, work and database usage facts on both platforms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-shapes-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const result: Record<string, unknown> = {}
  try {
    for (const os of ['darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { value: os })
      vi.resetModules()
      const { usageShapes } = await import('../testing/observerShapes.js')
      const dir = join(root, os)
      mkdirSync(dir)
      let now = Date.parse(at)
      const target = { agentId: 'agent', sessionId: 'conversation', engine: 'claude' as const, transcriptPath: join(dir, 'claude.jsonl'), registeredAt: 1, cwd: '/fixture/work' }
      const changed: string[] = []
      const options = { now: () => now }
      let store = usageShapes(join(dir, 'cache'), options)
      store.onChanged = s => changed.push(`${s.agentId}/${s.sessionId}`)
      const out: Record<string, unknown> = {}
      const read = async (name: string, s: Parameters<typeof store.get>[0] = target) => {
        now += 30_000
        store.changed(s)
        await store.settled()
        out[name] = store.get(s)
      }
      try {
        out.cold = store.get(target)
        await store.settled()
        await read('missing')
        writeFileSync(target.transcriptPath, lines(claude('one', 100, 10), claude('one'), claude('two'), claude('foreign', 999, 999, { sessionId: 'another' })))
        await read('streaming-and-foreign')
        const partial = lines(claude('three'))
        appendFileSync(target.transcriptPath, partial.slice(0, 90))
        await read('partial')
        appendFileSync(target.transcriptPath, partial.slice(90))
        await read('completed')
        appendFileSync(target.transcriptPath, lines(
          { type: 'assistant', timestamp: at, sessionId: 'conversation', message: { content: [{ type: 'tool_use', id: 'pr', name: 'Bash', input: { command: 'gh pr create --body-file /tmp/fixture-body' } }] } },
          { type: 'user', timestamp: at, sessionId: 'conversation', message: { content: [{ type: 'tool_result', tool_use_id: 'pr', content: 'https://github.com/example/project/pull/42' }] } },
          { type: 'assistant', timestamp: at, sessionId: 'conversation', message: { content: [{ type: 'tool_use', id: 'edit', name: 'Write', input: { file_path: '/fixture/work/new.ts' } }] } },
          { type: 'user', timestamp: at, sessionId: 'conversation', toolUseResult: { type: 'create', content: 'one\ntwo\n' }, message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Created' }] } },
        ))
        await read('output-and-work')
        renameSync(target.transcriptPath, target.transcriptPath + '.away')
        await read('unreadable-keeps-last')
        writeFileSync(target.transcriptPath, lines(claude('replacement', 300)))
        utimesSync(target.transcriptPath, now / 1000, now / 1000)
        await read('rewritten-keeps-history')
        await read('rebound-does-not-borrow', { ...target, sessionId: 'different' })
        await read('unsupported', { ...target, engine: 'hermes' })
        writeFileSync(target.transcriptPath, lines(claude('old'), claude('new', 200, 40, { timestamp: '2026-10-01T01:00:00Z' })))
        await read('fork', { ...target, forkedFrom: { agentId: 'parent', name: 'Parent' }, registeredAt: Date.parse(at) + 1000 })
        const cx = { ...target, engine: 'codex' as const, codexHome: '/fixture/profile', transcriptPath: join(dir, 'codex.jsonl') }
        writeFileSync(cx.transcriptPath, lines({ type: 'session_meta', payload: { id: 'conversation' } }, codex(100, 20), codex(200, 50, [100, 30]), codex(200, 50, [100, 30]),
          { type: 'event_msg', payload: { type: 'token_count', info: null } }))
        await read('codex-deltas', cx)
        appendFileSync(cx.transcriptPath, lines(codex(300, 80, [100, 30], '2026-10-01T00:02:00Z')))
        await read('codex-append', cx)
        writeFileSync(cx.transcriptPath, lines({ type: 'session_meta', payload: { id: 'elsewhere' } }, codex(900, 80)))
        await read('codex-other-conversation', cx)
        out.notifications = [...changed]
        store.dispose(); await store.settled()
        store = usageShapes(join(dir, 'cache'), options)
        await read('restart-from-checkpoint')
        store.dispose(); await store.settled()
        for (const name of readdirSync(join(dir, 'cache'))) writeFileSync(join(dir, 'cache', name), '{broken')
        store = usageShapes(join(dir, 'cache'), options)
        await read('corrupt-checkpoint-rebuilt')
        for (const mode of ['valid', 'fallback', 'unreadable', 'malformed'] as const) {
          const queries: unknown[] = []
          const db = usageShapes(join(dir, 'db-' + mode), { ...options, opencodeDb: '/fixture/opencode.db', readSqlite: async (_path, sql, args) => {
            queries.push({ sql, args })
            if (mode === 'unreadable' || mode === 'fallback' && queries.length === 1) return { ok: false, reason: 'unavailable' } as never
            return { ok: true, via: 'builtin', rows: [{ tokens_input: 100, tokens_output: 20, tokens_reasoning: 5, tokens_cache_read: 80, tokens_cache_write: mode === 'malformed' ? -1 : 10 }] }
          } })
          const s = { ...target, engine: 'opencode' as const, transcriptPath: null }
          out[`opencode/${mode}/cold`] = db.get(s)
          await db.settled()
          out[`opencode/${mode}`] = { value: db.get(s), queries }
          db.dispose()
        }
      } finally { store.dispose(); await store.settled() }
      result[os] = JSON.parse(JSON.stringify(out).split(root).join('<fixture>'))
    }
    const text = JSON.stringify(result, null, 2) + '\n'
    expect(text).not.toContain(root)
    if (process.env.RECORD_USAGE_SHAPES === '1') writeFileSync(golden, text)
    expect(result).toEqual(JSON.parse(readFileSync(golden, 'utf8')))
  } finally { Object.defineProperty(process, 'platform', platform); vi.resetModules(); rmSync(root, { recursive: true, force: true }) }
})
