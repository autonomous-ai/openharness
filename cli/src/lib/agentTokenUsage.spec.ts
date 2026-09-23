import { appendFile, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTokenUsageCache } from './agentTokenUsage.js'
import type { RegisteredSession } from './registry.js'

const at = '2026-09-22T16:00:00Z'
const claude = (id: string, input = 100, output = 20, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', timestamp: at, sessionId: 'conversation', requestId: `req-${id}`,
  message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 80,
    cache_creation_input_tokens: 10, output_tokens_details: { thinking_tokens: 5 } } }, ...extra,
}) + '\n'
const codex = (input: number, output: number, last?: [number, number], timestamp = at) => JSON.stringify({
  type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: Math.floor(input / 2), output_tokens: output, reasoning_output_tokens: Math.floor(output / 2) },
    ...(last ? { last_token_usage: { input_tokens: last[0], cached_input_tokens: Math.floor(last[0] / 2), output_tokens: last[1], reasoning_output_tokens: Math.floor(last[1] / 2) } } : {}),
  } },
}) + '\n'

describe('owning-machine token cache', () => {
  let dir: string
  let now: number
  let bytes: number
  let store: AgentTokenUsageCache
  let target: Pick<RegisteredSession, 'agentId' | 'sessionId' | 'engine' | 'transcriptPath' | 'registeredAt'>
  const read = async () => { store.changed(target); await store.settled(); return store.get(target) }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-token-test-'))
    now = Date.parse('2026-09-23T00:00:00Z')
    bytes = 0
    target = { agentId: 'harness', sessionId: 'conversation', engine: 'claude', transcriptPath: join(dir, 'transcript.jsonl'), registeredAt: 1 }
    store = new AgentTokenUsageCache(join(dir, 'cache'), { now: () => now, onRead: n => { bytes += n } })
  })
  afterEach(async () => { store.dispose(); await store.settled(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

  it('coalesces activity bursts, captures their final usage, and does not poll idle harnesses', async () => {
    await writeFile(target.transcriptPath!, claude('one'))
    await read()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await appendFile(target.transcriptPath!, claude('two'))
    for (let i = 0; i < 100; i++) store.changed(target)
    expect(vi.getTimerCount()).toBe(1)
    now += 15_000
    await vi.advanceTimersByTimeAsync(15_000)
    await store.settled()
    expect(store.get(target)?.totalTokens).toBe(420)
    const reads = bytes
    await vi.advanceTimersByTimeAsync(60_000)
    await store.settled()
    expect(bytes).toBe(reads)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('snapshots queued identity so a rebind cannot write another conversation’s usage into its cache', async () => {
    await writeFile(target.transcriptPath!, claude('one'))
    const original = { ...target }
    store.get(target)
    target.sessionId = 'replacement-conversation'
    target.transcriptPath = '/missing/replacement.jsonl'
    await store.settled()
    expect(store.get(original)?.totalTokens).toBe(210)
    expect(store.get(target)).toBeNull()
  })

  it('keeps 200-harness repeated display lookups free of transcript reads', async () => {
    const targets = Array.from({ length: 200 }, (_, i) => ({ ...target, agentId: `harness-${i}`,
      transcriptPath: join(dir, `harness-${i}.jsonl`) }))
    await Promise.all(targets.map(s => writeFile(s.transcriptPath!, claude('one'))))
    for (const s of targets) store.get(s)
    await store.settled()
    const reads = bytes
    now += 3_600_000 // A warm display never schedules work, even after a long idle.
    const start = performance.now()
    for (let round = 0; round < 50; round++) {
      for (const s of targets) expect(store.get(s)?.totalTokens).toBe(210)
    }
    const elapsed = performance.now() - start
    await store.settled()
    expect(bytes).toBe(reads)
    console.log(`200 harnesses × 50 cached lookups: ${elapsed.toFixed(1)} ms including assertions; 0 transcript bytes read`)
  })

  it('returns immediately while cold, merges streaming repeats, and counts cache/reasoning once', async () => {
    await writeFile(target.transcriptPath!, claude('one', 100, 10) + claude('one') + claude('two'))
    const changed = vi.fn()
    store.onChanged = changed
    expect(store.get(target)).toBeNull()
    expect((await read())?.totalTokens).toBe(420)
    expect(changed).toHaveBeenCalledTimes(1)
    const reads = bytes
    for (let i = 0; i < 1000; i++) expect(store.get(target)?.totalTokens).toBe(420)
    await store.settled()
    expect(bytes).toBe(reads)
    now += 30_000
    await read()
    expect(bytes).toBe(reads)
  })

  it('reads only appended bytes plus a bounded checkpoint, and survives pause/resume and daemon restart', async () => {
    await writeFile(target.transcriptPath!, JSON.stringify({ type: 'user', text: 'x'.repeat(250_000) }) + '\n' + claude('one'))
    expect((await read())?.totalTokens).toBe(210)
    const oldBytes = bytes
    now += 30_000
    await appendFile(target.transcriptPath!, claude('one') + claude('two'))
    expect((await read())?.totalTokens).toBe(420)
    expect(bytes - oldBytes).toBeLessThan(2048)
    const cacheFile = join(dir, 'cache', (await readdir(join(dir, 'cache')))[0])
    const checkpoint = await readFile(cacheFile, 'utf8')
    expect(checkpoint).not.toContain('x'.repeat(100))
    expect(checkpoint).not.toContain('req-one')
    expect((await stat(cacheFile)).mode & 0o777).toBe(0o600)
    store.dispose()
    store = new AgentTokenUsageCache(join(dir, 'cache'), { now: () => now, onRead: n => { bytes += n } })
    const restartedBytes = bytes
    expect((await read())?.totalTokens).toBe(420)
    expect(bytes).toBe(restartedBytes)
    now += 30_000
    await appendFile(target.transcriptPath!, claude('three'))
    expect((await read())?.totalTokens).toBe(630)
  })

  it('waits for a complete JSONL record without double counting its prefix', async () => {
    const line = claude('two')
    await writeFile(target.transcriptPath!, claude('one') + line.slice(0, 100))
    expect((await read())?.totalTokens).toBe(210)
    now += 30_000
    await appendFile(target.transcriptPath!, line.slice(100))
    expect((await read())?.totalTokens).toBe(420)
  })

  it('rebuilds after truncation, replacement, and same-size rewrites', async () => {
    await writeFile(target.transcriptPath!, claude('one') + claude('two'))
    expect((await read())?.totalTokens).toBe(420)
    now += 30_000
    await writeFile(target.transcriptPath!, claude('new'))
    expect((await read())?.totalTokens).toBe(210)
    now += 30_000
    await writeFile(join(dir, 'replacement'), claude('new', 200))
    await rename(join(dir, 'replacement'), target.transcriptPath!)
    expect((await read())?.totalTokens).toBe(310)
    now += 30_000
    await writeFile(target.transcriptPath!, claude('new', 300))
    await utimes(target.transcriptPath!, now / 1000, now / 1000)
    expect((await read())?.totalTokens).toBe(410)
  })

  it('never borrows another conversation, profile, or machine cache', async () => {
    await writeFile(target.transcriptPath!, claude('one'))
    expect((await read())?.totalTokens).toBe(210)
    expect(store.get({ ...target, sessionId: 'another' })).toBeNull()
    expect(store.get({ ...target, engine: 'codex', codexHome: '/different-profile' })).toBeNull()
    const remote = new AgentTokenUsageCache(join(dir, 'other-machine-cache'))
    expect(remote.get({ ...target, transcriptPath: '/missing/on/this/machine' })).toBeNull()
    await remote.settled()
    remote.dispose()
  })

  it('hides unavailable or unsupported usage rather than making up zero', async () => {
    expect(await read()).toBeNull()
    expect(store.get({ ...target, engine: 'hermes' })).toBeNull()
    now += 30_000
    await writeFile(target.transcriptPath!, '{"type":"user"}\n')
    expect(await read()).toBeNull()
    now += 30_000
    await appendFile(target.transcriptPath!, '{"type":"assistant","message":{"usage":{}}}\n')
    expect(await read()).toBeNull()
  })

  it('keeps a previously measured total when the original transcript is unavailable', async () => {
    await writeFile(target.transcriptPath!, claude('one'))
    await read()
    await rm(target.transcriptPath!)
    now += 30_000
    expect((await read())?.totalTokens).toBe(210)
  })

  it('drops invalidated measurements after a readable transcript is replaced with unreported data', async () => {
    await writeFile(target.transcriptPath!, claude('one'))
    expect((await read())?.totalTokens).toBe(210)
    now += 30_000
    await writeFile(target.transcriptPath!, '{"type":"user","message":"New empty history"}\n')
    expect(await read()).toBeNull()
  })

  it('omits inherited fork history but includes the fork’s own usage', async () => {
    const fork = { ...target, forkedFrom: { agentId: 'parent', name: 'Parent' }, registeredAt: Date.parse(at) + 1000 }
    await writeFile(target.transcriptPath!, claude('old') + claude('new', 100, 20, { timestamp: '2026-09-22T17:00:00Z' }))
    store.get(fork)
    await store.settled()
    expect(store.get(fork)?.totalTokens).toBe(210)
  })

  it('recovers a malformed disk checkpoint without affecting the harness', async () => {
    await writeFile(target.transcriptPath!, claude('one'))
    await read()
    const file = join(dir, 'cache', (await readdir(join(dir, 'cache')))[0])
    await writeFile(file, '{broken')
    store.dispose()
    store = new AgentTokenUsageCache(join(dir, 'cache'), { now: () => now })
    expect((await read())?.totalTokens).toBe(210)
  })

  it('counts Codex deltas, excludes rate-limit-only updates and repeated records', async () => {
    target.engine = 'codex'
    await writeFile(target.transcriptPath!, codex(100, 20) + codex(200, 50, [100, 30])
      + codex(200, 50, [100, 30]) + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n')
    expect((await read())?.totalTokens).toBe(250)
    now += 30_000
    await appendFile(target.transcriptPath!, codex(300, 80, [100, 30], '2026-09-22T16:02:00Z'))
    expect((await read())?.totalTokens).toBe(380)
  })

  it('handles Codex counter resets and stale regressions without rebilling history', async () => {
    target.engine = 'codex'
    await writeFile(target.transcriptPath!, codex(1000, 100) + codex(990, 99, [10, 1])
      + codex(10, 1) + codex(110, 11, [100, 10]))
    expect((await read())?.totalTokens).toBe(1210)
  })

  it('reads one OpenCode aggregate by session id and includes reasoning once', async () => {
    const query = vi.fn().mockResolvedValue({ ok: true, via: 'builtin', rows: [{
      tokens_input: 100, tokens_output: 20, tokens_reasoning: 5, tokens_cache_read: 80, tokens_cache_write: 10,
    }] })
    store.dispose()
    store = new AgentTokenUsageCache(join(dir, 'cache'), { readSqlite: query, now: () => now })
    target.engine = 'opencode'
    target.transcriptPath = null
    expect((await read())?.totalTokens).toBe(215)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][2]).toEqual(['conversation'])
    expect(query.mock.calls[0][1]).toContain('WHERE id = ?')
    now += 3_600_000
    for (let i = 0; i < 1000; i++) store.get(target)
    await store.settled()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('collects output in the same incremental pass, persists it, and does not credit inherited work', async () => {
    const receipt = (id: string, timestamp = at) => [
      { type: 'assistant', timestamp, sessionId: 'conversation', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'gh pr create --body-file /tmp/body' } }] } },
      { type: 'user', timestamp, sessionId: 'conversation', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'https://github.com/team/project/pull/42' }] } },
    ].map(v => JSON.stringify(v) + '\n').join('')
    await writeFile(target.transcriptPath!, receipt('old') + claude('usage'))
    expect((await read())?.output?.pullRequestsCreated).toBe(1)
    const before = bytes
    now += 3_600_000
    for (let i = 0; i < 1000; i++) store.get(target)
    await store.settled()
    expect(bytes).toBe(before)
    store.dispose()
    store = new AgentTokenUsageCache(join(dir, 'cache'), { now: () => now, onRead: n => { bytes += n } })
    expect((await read())?.output?.pullRequestsCreated).toBe(1)
    expect(bytes).toBe(before)
    const fork = { ...target, forkedFrom: { agentId: 'parent', name: 'Parent' }, registeredAt: Date.parse(at) + 1000 }
    store.get(fork)
    await store.settled()
    expect(store.get(fork)).toBeNull()
  })

  it('publishes recorded output even when token usage is unreported', async () => {
    await writeFile(target.transcriptPath!, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit', name: 'Write', input: {} }] } },
      { type: 'user', toolUseResult: { type: 'create', content: 'line\n' }, message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Created' }] } },
    ].map(v => JSON.stringify(v) + '\n').join(''))
    expect(await read()).toMatchObject({ totalTokens: null, output: { linesAdded: 1, linesRemoved: 0, pullRequestsCreated: null } })
  })
})
