import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LiveEvent } from '../normalize.js'
import { SessionSearchIndex, folderWords, type SearchSource } from './indexer.js'
import { SessionSearchStore } from './store.js'

const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

const at = (minute: number) => `2026-09-20T10:${String(minute).padStart(2, '0')}:00.000Z`
const prompt = (text: string, minute: number) => JSON.stringify({ type: 'user', timestamp: at(minute), message: { role: 'user', content: text } }) + '\n'
const answer = (text: string, minute: number) => JSON.stringify({ type: 'assistant', timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'

function setup(initial: string, agents?: () => string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'session-search-'))
  dirs.push(dir)
  const path = join(dir, 's1.jsonl')
  writeFileSync(path, initial)
  const store = SessionSearchStore.open(':memory:')!
  let sources: SearchSource[] = [{ agentId: 'agent-1', sessionId: 's1', engine: 'claude', transcriptPath: path, header: 'Dial firmware · harness', changedAt: 1 }]
  const index = new SessionSearchIndex({ store, sources: () => sources, agents, touchDelayMs: 5 })
  cleanups.push(() => { index.stop(); store.close() })
  const found = (query: string) => index.search(query).hits.map((hit) => hit.sessionId)
  const settle = async () => {
    index.sweep()
    await vi.waitFor(() => { expect((index as unknown as { running: boolean }).running).toBe(false) })
    await index.drain()
  }
  return { path, store, index, found, settle, setSources: (next: SearchSource[]) => { sources = next } }
}

describe('SessionSearchIndex', () => {
  it('discovers on first search and distinguishes an unfinished scan from empty history', async () => {
    const store = SessionSearchStore.open(':memory:')!
    let finish!: () => void
    const discover = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const index = new SessionSearchIndex({ store, sources: () => [], discover })
    cleanups.push(() => { index.stop(); store.close() })
    index.start(60_000)
    expect(index.search('')).toMatchObject({ hits: [], ready: false, pending: 0 })
    await Promise.resolve()
    expect(discover).toHaveBeenCalledTimes(1)
    index.search('')
    index.sweep()
    expect(discover).toHaveBeenCalledTimes(1)
    finish()
    await vi.waitFor(() => expect(index.search('')).toMatchObject({ hits: [], ready: true }))
  })

  it('keeps readiness false through the final indexing pass, then returns discovered history', async () => {
    const store = SessionSearchStore.open(':memory:')!
    let finish!: (events: LiveEvent[]) => void
    const index = new SessionSearchIndex({ store, sources: () => [{
      agentId: '', sessionId: 'existing-codex', engine: 'codex', transcriptPath: null,
      header: '', changedAt: Date.now(), external: { cwd: '/repo', origin: 'terminal', title: 'Existing work' },
      readHistory: () => new Promise<LiveEvent[]>((resolve) => { finish = resolve }),
    }] })
    cleanups.push(() => { index.stop(); store.close() })
    expect(index.search('')).toMatchObject({ ready: false, pending: 0 })
    finish([{ type: 'user_message', payload: { content: 'fix welcome' } }])
    await vi.waitFor(() => {
      const result = index.search('', { from: 0, to: Date.now() + 1 })
      expect(result.ready).toBe(true)
      expect(result.hits[0]).toMatchObject({ sessionId: 'existing-codex', external: { title: 'Existing work' } })
    })
  })

  it('reports discovery failure and lets a later search retry without overlapping scans', async () => {
    const store = SessionSearchStore.open(':memory:')!
    const discover = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(undefined)
    const index = new SessionSearchIndex({ store, sources: () => [], discover })
    cleanups.push(() => { index.stop(); store.close() })
    index.search('')
    await vi.waitFor(() => expect(index.search('')).toMatchObject({ ready: false, discoveryError: true }))
    expect(discover).toHaveBeenCalledTimes(1)
    index.sweep()
    await vi.waitFor(() => expect(index.search('').ready).toBe(true))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect deleted conversation history from an in-flight pass or stale source list', async () => {
    const { index, found, settle, store } = setup(prompt('purge search history', 0) + answer('sensitive fixture', 1))
    await settle()
    expect(found('sensitive')).toEqual(['s1'])
    const pass = index.pass({ agentId: 'agent-1', sessionId: 's1', engine: 'claude', transcriptPath: store.session('s1')!.path, header: 'stale row', changedAt: 2 })
    index.deleteHistory('s1')
    await pass
    await settle()
    expect(found('sensitive')).toEqual([])
    expect(store.session('s1')).toBeUndefined()
  })
  it('indexes a transcript on the first sweep and picks up only what was added since', async () => {
    const { path, store, found, settle } = setup(prompt('why does the dial scroll jump', 0) + answer('The delta is doubled.', 1))
    await settle()
    expect(found('doubled')).toEqual(['s1'])
    const first = store.session('s1')!
    expect(first).toMatchObject({ resumeOffset: 0, resumeTurn: 0, turns: 1, lastAt: Date.parse(at(1)) })

    // The open turn grows, then a new one starts: the pass resumes at the open turn, not the start.
    appendFileSync(path, answer('Halved it in ui.c.', 2) + prompt('now flash the keyboard firmware', 3))
    await settle()
    expect(found('halved')).toEqual(['s1'])
    expect(found('keyboard')).toEqual(['s1'])
    const second = store.session('s1')!
    expect(second.resumeTurn).toBe(1)
    expect(second.resumeOffset).toBeGreaterThan(0)
    expect(store.counts()).toEqual({ sessions: 1, turns: 2 })
    // Nothing indexed twice.
    expect(found('doubled')).toEqual(['s1'])
    expect(store.search('delta')[0].snippet).toContain('doubled')
  })

  it('writes a long first pass in batches, and a pass stopped between them resumes at the next', async () => {
    let transcript = ''
    for (let i = 0; i < 70; i++) transcript += prompt(`step ${i} of the dial rewrite`, i % 60) + answer(`finished step${i}`, i % 60)
    const { store, index, found } = setup(transcript)
    const write = vi.spyOn(store, 'writeSession')
    write.mockImplementationOnce(function (this: SessionSearchStore, ...args) {
      index.stop()
      return SessionSearchStore.prototype.writeSession.apply(this, args)
    })
    index.sweep()
    await vi.waitFor(() => { expect((index as unknown as { running: boolean }).running).toBe(false) })
    // Stopped after the first batch: its rows are in, and the session resumes at the next one.
    expect(store.counts().turns).toBe(32)
    expect(store.session('s1')).toMatchObject({ resumeTurn: 32, mtime: 0 })
    expect(store.session('s1')!.size).toBe(store.session('s1')!.resumeOffset)
    write.mockRestore()

    const resumed = new SessionSearchIndex({ store, sources: () => [{ agentId: 'agent-1', sessionId: 's1', engine: 'claude', transcriptPath: store.session('s1')!.path, header: 'Dial firmware · harness', changedAt: 1 }] })
    cleanups.push(() => resumed.stop())
    resumed.sweep()
    await vi.waitFor(() => { expect((resumed as unknown as { running: boolean }).running).toBe(false) })
    expect(store.counts()).toEqual({ sessions: 1, turns: 70 })
    for (const i of [0, 31, 32, 33, 64, 69]) expect(found(`step${i}`)).toEqual(['s1'])
    expect(store.session('s1')).toMatchObject({ resumeTurn: 69, turns: 70 })
    expect(store.session('s1')!.mtime).toBeGreaterThan(0)
  })

  it('brings a session being written up to date before it answers for a preview', async () => {
    const { path, index, settle } = setup(prompt('why does the dial scroll jump', 0) + answer('Looking at ui.c.', 1))
    await settle()
    // The turn goes on with no turn event yet: the index has not seen this.
    appendFileSync(path, answer('Found it:\n\n- the delta is applied twice', 2))
    const tail = await index.tail('s1')
    expect(tail!.rows.at(-1)).toMatchObject({ ask: 'why does the dial scroll jump', answer: 'Looking at ui.c.\nFound it:\n\n- the delta is applied twice' })
    // Older pages are read as they are: no pass for them.
    expect((await index.tail('s1', { beforeTurn: 0 }))!.rows).toEqual([])
    expect(await index.tail('unknown')).toBeNull()
  })

  it("dates a conversation Harness did not start by its engine's time when its lines carry none, and indexes a database's under its title", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-search-external-times-'))
    dirs.push(dir)
    // Cursor's lines have no time.
    const cursorFile = join(dir, 'c1.jsonl')
    writeFileSync(cursorFile, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>ship the dial</user_query>' }] } }) + '\n'
      + JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Shipped.' }] } }) + '\n')
    const events: LiveEvent[] = [
      { type: 'user_message', payload: { content: 'compare cohorts in the warehouse' } },
      { type: 'text_delta', payload: { content: 'Day-7 is 35%.' } },
    ]
    const store = SessionSearchStore.open(':memory:')!
    const sources: SearchSource[] = [
      { agentId: '', sessionId: 'c1', engine: 'cursor', transcriptPath: cursorFile, header: '', changedAt: 1_790_000_000_000, external: { cwd: '/work/dial', origin: 'terminal', title: 'Dial release' } },
      { agentId: '', sessionId: 'ses_1', engine: 'opencode', transcriptPath: null, header: '', changedAt: 1_790_000_100_000, readHistory: async () => events, external: { cwd: '/work/cohorts', origin: 'terminal', title: '' } },
    ]
    const index = new SessionSearchIndex({ store, sources: () => sources, agents: () => [] })
    cleanups.push(() => { index.stop(); store.close() })
    index.sweep()
    await vi.waitFor(() => { expect((index as unknown as { running: boolean }).running).toBe(false) })
    expect(store.session('c1')).toMatchObject({ lastAt: 1_790_000_000_000, title: 'Dial release', cwd: '/work/dial' })
    // A database's conversation, titled by its first ask, with its folder and origin.
    expect(store.session('ses_1')).toMatchObject({ title: 'compare cohorts in the warehouse', cwd: '/work/cohorts', origin: 'terminal', lastAt: 1_790_000_100_000 })
    expect(index.search('warehouse').hits[0]).toMatchObject({ sessionId: 'ses_1', external: { title: 'compare cohorts in the warehouse' } })
    // Read again unchanged: its heading is kept.
    index.sweep()
    await vi.waitFor(() => { expect((index as unknown as { running: boolean }).running).toBe(false) })
    expect(store.session('ses_1')?.title).toBe('compare cohorts in the warehouse')
  })

  it("indexes a conversation Harness did not start under its own title, says if it is open, and drops it with its file", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-search-external-'))
    dirs.push(dir)
    const titled = (type: string, key: string, title: string) => JSON.stringify({ type, [key]: title, sessionId: 'e1' }) + '\n'
    const claudeFile = join(dir, 'e1.jsonl')
    writeFileSync(claudeFile, prompt('why does the dial scroll jump', 0) + titled('ai-title', 'aiTitle', 'Dial scroll jump')
      + answer('The delta is doubled.', 1) + titled('custom-title', 'customTitle', 'Dial fix') + titled('ai-title', 'aiTitle', 'Later AI title'))
    const untitledFile = join(dir, 'e2.jsonl')
    writeFileSync(untitledFile, prompt('compare retention\nby cohort please', 0) + answer('Day-7 is 35%.', 1))
    const store = SessionSearchStore.open(':memory:')!
    const open = new Map([['e1', 'terminal' as const]])
    let sources: SearchSource[] = [
      { agentId: '', sessionId: 'e1', engine: 'claude', transcriptPath: claudeFile, header: '', changedAt: 2, external: { cwd: '/work/dial', origin: 'terminal', title: '' } },
      { agentId: '', sessionId: 'e2', engine: 'claude', transcriptPath: untitledFile, header: '', changedAt: 1, external: { cwd: '/work/cohorts', origin: 'claude-app', title: '' } },
    ]
    const index = new SessionSearchIndex({
      store, sources: () => sources, agents: () => [],
      openSessions: { known: () => open, fresh: async () => open },
    })
    cleanups.push(() => { index.stop(); store.close() })
    const settle = async () => {
      index.sweep()
      await vi.waitFor(() => { expect((index as unknown as { running: boolean }).running).toBe(false) })
    }
    await settle()
    // The person's own title wins over Claude's; with none, the first ask, on one line.
    expect(store.session('e1')).toMatchObject({ agentId: '', title: 'Dial fix', cwd: '/work/dial', origin: 'terminal' })
    expect(store.session('e2')?.title).toBe('compare retention by cohort please')
    // Found by its title, marked as not Harness's, and as open elsewhere.
    const hit = index.search('dial fix').hits[0]
    expect(hit).toMatchObject({ sessionId: 'e1', agentId: '', external: { title: 'Dial fix', cwd: '/work/dial', origin: 'terminal', open: true, openIn: 'terminal' } })
    expect(index.search('cohort').hits[0]).toMatchObject({ sessionId: 'e2', external: { origin: 'claude-app', open: false } })
    const tail = await index.tail('e1')
    expect(tail?.external).toEqual({ title: 'Dial fix', cwd: '/work/dial', origin: 'terminal', open: true, openIn: 'terminal' })

    // Its file gone, it leaves the index at the next sweep.
    sources = sources.filter((source) => source.sessionId !== 'e2')
    await settle()
    expect(store.session('e2')).toBeUndefined()
    expect(store.session('e1')).toBeDefined()
  })

  it('starts over when the transcript was rewritten shorter', async () => {
    const { path, found, settle } = setup(prompt('first long conversation about cohorts and retention', 0) + answer('Done with the cohort table.', 1))
    await settle()
    writeFileSync(path, prompt('tiny', 0))
    await settle()
    expect(found('cohort')).toEqual([])
    expect(found('tiny')).toEqual(['s1'])
  })

  it('updates the name without rereading the transcript, and forgets sessions of deleted agents', async () => {
    const { store, found, settle, setSources, path } = setup(prompt('flash it', 0))
    await settle()
    setSources([{ agentId: 'agent-1', sessionId: 's1', engine: 'claude', transcriptPath: path, header: 'Keyboard firmware', changedAt: 2 }])
    await settle()
    expect(found('keyboard')).toEqual(['s1'])
    expect(found('dial')).toEqual([])
    expect(store.session('s1')!.turns).toBe(1)

    // An agent's earlier session (before a /clear) stays while the agent does…
    setSources([{ agentId: 'agent-1', sessionId: 's2', engine: 'terminal', transcriptPath: null, header: 'Keyboard firmware', changedAt: 3 }])
    await settle()
    expect(found('flash')).toEqual(['s1'])
    // …and goes with it.
    setSources([])
    await settle()
    expect(found('flash')).toEqual([])
    expect(store.counts().sessions).toBe(0)
  })

  it('indexes a touched session shortly after its turn event', async () => {
    const { path, index, found } = setup(prompt('first ask', 0))
    index.touch('s1')
    await vi.waitFor(() => { expect(found('first')).toEqual(['s1']) })
    appendFileSync(path, prompt('second ask about tmux', 1))
    index.touch('s1')
    index.touch('s1')
    await vi.waitFor(() => { expect(found('tmux')).toEqual(['s1']) })
  })

  it('reads a database-backed history whole, again only when the session changed', async () => {
    const store = SessionSearchStore.open(':memory:')!
    let reads = 0
    let history: LiveEvent[] = [
      { type: 'user_message', payload: { content: 'draft the release notes' } },
      { type: 'text_delta', payload: { content: 'Drafted them in RELEASE.md.' } },
    ]
    let source: SearchSource = {
      agentId: 'agent-oc', sessionId: 'ses_1', engine: 'opencode', transcriptPath: null, header: 'OpenCode harness',
      changedAt: 100, readHistory: async () => { reads++; return history },
    }
    const index = new SessionSearchIndex({ store, sources: () => [source], touchDelayMs: 5 })
    cleanups.push(() => { index.stop(); store.close() })
    const found = (query: string) => index.search(query).hits.map((hit) => hit.sessionId)
    index.sweep()
    await vi.waitFor(() => { expect(found('release')).toEqual(['ses_1']) })
    expect(store.session('ses_1')).toMatchObject({ turns: 1, lastAt: 100 })

    index.sweep()
    await index.drain()
    expect(reads).toBe(1)

    // A turn event marks it changed even before its update time moves.
    history = [...history, { type: 'user_message', payload: { content: 'now tag v2' } }]
    index.touch('ses_1')
    await vi.waitFor(() => { expect(found('tag')).toEqual(['ses_1']) })
    expect(reads).toBe(2)

    // A turn event that changed nothing leaves it as it was worked on.
    const before = store.session('ses_1')!.lastAt
    index.touch('ses_1')
    await vi.waitFor(() => { expect(reads).toBe(3) })
    await index.drain()
    expect(store.session('ses_1')!.lastAt).toBe(before)

    const now = Date.now()
    history = [...history, { type: 'user_message', payload: { content: 'publish the changelog' } }]
    index.touch('ses_1')
    await vi.waitFor(() => { expect(found('changelog')).toEqual(['ses_1']) })
    expect(store.session('ses_1')!.turns).toBe(3)
    expect(store.session('ses_1')!.lastAt).toBeGreaterThanOrEqual(now)

    // A turn whose event was lost (the daemon restarted first): its activity stamp moved, so the
    // next sweep reads it, and dates it by that stamp.
    history = [...history, { type: 'user_message', payload: { content: 'archive the old builds' } }]
    source = { ...source, changedAt: 5_000 }
    const restarted = new SessionSearchIndex({ store, sources: () => [source] })
    cleanups.push(() => restarted.stop())
    restarted.sweep()
    await vi.waitFor(() => { expect(restarted.search('archive').hits.map((hit) => hit.sessionId)).toEqual(['ses_1']) })
    expect(store.session('ses_1')).toMatchObject({ turns: 4, lastAt: 5_000 })
    restarted.sweep()
    await restarted.drain()
    expect(reads).toBe(5)
  })

  it('keeps an agent\'s sessions while the agent exists, even with nothing to read right now', async () => {
    let agents = ['agent-1']
    const { store, found, settle, setSources } = setup(prompt('the first conversation about tmux', 0), () => agents)
    await settle()
    setSources([])
    await settle()
    expect(found('tmux')).toEqual(['s1'])
    agents = []
    await settle()
    expect(store.counts().sessions).toBe(0)
  })

  it('names folders the way a person would: the last two segments', () => {
    expect(folderWords('/home/me/code/worktrees/autonomous-harness/dapper-otter')).toBe('dapper-otter autonomous-harness')
    expect(folderWords('C:\\work\\app')).toBe('app work')
    expect(folderWords(null)).toBe('')
  })
})
