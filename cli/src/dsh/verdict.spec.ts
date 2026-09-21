import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshVerdictWatcher, parseVerdict, readVerdictFile, type DshVerdict } from './verdict.js'

describe('parseVerdict', () => {
  it('reduces a spec-1 verdict to the wire shape', () => {
    const verdict = parseVerdict(JSON.stringify({
      spec: 1,
      ready: false,
      summary: '  2 errors, 1 warning ',
      findings: [
        { severity: 'error', kind: 'a', message: 'x' },
        { severity: 'error', kind: 'b', message: 'y', ref: 'U3.pin7' },
        { severity: 'warning', message: 'z' },
        { severity: 'info', message: 'fyi' },
        null,
      ],
      artifact: 'boards/main.board.json',
      updatedAt: '2026-09-14T20:00:00Z',
      extra: 'ignored',
    }))
    expect(verdict).toEqual<DshVerdict>({
      ready: false,
      summary: '2 errors, 1 warning',
      errors: 2,
      warnings: 1,
      artifact: 'boards/main.board.json',
      phases: [],
      updatedAt: '2026-09-14T20:00:00Z',
    })
  })

  it('keeps the phases in order, sanitised, and never more than twelve', () => {
    const verdict = parseVerdict(JSON.stringify({
      spec: 1,
      ready: false,
      phases: [
        { id: 'build', name: 'Build', state: 'done', artifact: 'model.step' },
        { name: 'Checks', state: 'active' },
        { name: ' Fab ', state: 'someday' },
        { name: '', state: 'done' },
        'nope',
        { id: 'x', state: 'done' },
        { name: 'Bad path', state: 'done', artifact: '../out.step' },
      ],
    }))
    expect(verdict?.phases).toEqual([
      { id: 'build', name: 'Build', state: 'done', artifact: 'model.step' },
      { id: 'checks', name: 'Checks', state: 'active', artifact: null },
      { id: 'fab', name: 'Fab', state: 'pending', artifact: null },
      { id: 'bad-path', name: 'Bad path', state: 'done', artifact: null },
    ])
    const many = parseVerdict(JSON.stringify({
      spec: 1, ready: true, phases: Array.from({ length: 20 }, (_, i) => ({ name: `P${i}` })),
    }))
    expect(many?.phases).toHaveLength(12)
    expect(parseVerdict(JSON.stringify({ spec: 1, ready: true, phases: 'later' }))?.phases).toEqual([])
  })

  it('refuses what is not a verdict, and scrubs an artifact that leaves the workspace', () => {
    expect(parseVerdict('nope')).toBeNull()
    expect(parseVerdict('[]')).toBeNull()
    expect(parseVerdict(JSON.stringify({ spec: 2, ready: true }))).toBeNull()
    expect(parseVerdict(JSON.stringify({ spec: 1, ready: 'yes' }))).toBeNull()
    expect(parseVerdict(JSON.stringify({ spec: 1, ready: true, artifact: '../x.step' }))?.artifact).toBeNull()
    expect(parseVerdict(JSON.stringify({ spec: 1, ready: true, artifact: '/abs.step' }))?.artifact).toBeNull()
    expect(parseVerdict(JSON.stringify({ spec: 1, ready: true, updatedAt: 'yesterday' }))?.updatedAt).toBeNull()
  })
})

describe('DshVerdictWatcher', () => {
  let workspace: string
  let watcher: DshVerdictWatcher | null = null
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'dsh-verdict-')) })
  afterEach(async () => {
    await watcher?.stop()
    watcher = null
    rmSync(workspace, { recursive: true, force: true })
  })

  it('publishes the existing verdict at watch time and each change after it', async () => {
    const file = join(workspace, '.harness', 'verdict.json')
    mkdirSync(join(workspace, '.harness'), { recursive: true })
    writeFileSync(file, JSON.stringify({ spec: 1, ready: false, summary: 'first' }))
    const seen: Array<DshVerdict | null> = []
    let resolveNext: (() => void) | null = null
    watcher = new DshVerdictWatcher({ onChange: (_agentId, verdict) => { seen.push(verdict); resolveNext?.() } })
    watcher.watch('agent-1', file)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.summary).toBe('first')
    expect(watcher.current('agent-1')?.summary).toBe('first')

    const next = new Promise<void>((resolve) => { resolveNext = resolve })
    // Give chokidar a moment to be ready before the write it must notice.
    await new Promise((resolve) => setTimeout(resolve, 300))
    writeFileSync(file, JSON.stringify({ spec: 1, ready: true, summary: 'second' }))
    await Promise.race([next, new Promise((resolve) => setTimeout(resolve, 4_000))])
    expect(seen.at(-1)?.summary).toBe('second')
    expect(seen.at(-1)?.ready).toBe(true)
  }, 10_000)

  it('creates the directory it watches, so a first verdict lands in a watched place', () => {
    const file = join(workspace, 'nested', '.harness', 'verdict.json')
    watcher = new DshVerdictWatcher({ onChange: () => undefined })
    watcher.watch('agent-2', file)
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync(join(workspace, 'nested', '.harness'))).toBe(true)
    expect(watcher.current('agent-2')).toBeNull()
    watcher.unwatch('agent-2')
  })
})

describe('readVerdictFile and the edges of parseVerdict', () => {
  it('reads a verdict off disk, or null when there is no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verdict-file-'))
    try {
      writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ spec: 1, ready: true, summary: '   ', findings: 'none', artifact: '' }))
      expect(readVerdictFile(join(dir, 'verdict.json'))).toEqual({ ready: true, summary: null, errors: 0, warnings: 0, artifact: null, phases: [], updatedAt: null })
      expect(readVerdictFile(join(dir, 'missing.json'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps the summary, refuses an overlong artifact, and skips a phase that is a list', () => {
    const verdict = parseVerdict(JSON.stringify({
      spec: 1, ready: false, summary: 'x'.repeat(300), artifact: `${'a/'.repeat(600)}b.step`,
      phases: [['Build'], { id: ' ', name: 'Build Plate!', state: 'failed' }],
    }))
    expect(verdict?.summary).toHaveLength(200)
    expect(verdict?.artifact).toBeNull()
    expect(verdict?.phases).toEqual([{ id: 'build-plate-', name: 'Build Plate!', state: 'failed', artifact: null }])
  })
})

describe('DshVerdictWatcher, event by event', () => {
  let workspace: string
  let watcher: DshVerdictWatcher | null = null
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'dsh-verdict-events-')) })
  afterEach(async () => {
    await watcher?.stop()
    watcher = null
    rmSync(workspace, { recursive: true, force: true })
  })

  const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const verdict = (summary: string): string => JSON.stringify({ spec: 1, ready: false, summary })
  /** The chokidar instance behind one agent's watch, to raise the error chokidar would. */
  const innerWatcher = (w: DshVerdictWatcher, agentId: string): EventEmitter =>
    (w as unknown as { watched: Map<string, { watcher: EventEmitter }> }).watched.get(agentId)!.watcher

  it('publishes a verdict that appears, debounces a burst, ignores other files and unchanged rewrites, and says when it goes', async () => {
    const file = join(workspace, '.harness', 'verdict.json')
    const seen: Array<string | null> = []
    watcher = new DshVerdictWatcher({ onChange: (_id, v) => seen.push(v ? v.summary : null) })
    watcher.watch('a', file)
    expect(seen).toEqual([])
    expect(watcher.current('a')).toBeNull()
    await settle()

    writeFileSync(file, verdict('first'))
    await vi.waitFor(() => expect(seen).toEqual(['first']), { timeout: 4_000 })
    expect(watcher.current('a')?.summary).toBe('first')

    // two changes inside the debounce are one publish, of the last write
    const inner = innerWatcher(watcher, 'a')
    /** Do something to the directory and wait until chokidar has told the watcher exactly that. */
    const observed = async (event: 'add' | 'change' | 'unlink', path: string, act: () => void): Promise<void> => {
      let listener: (name: string, at: string) => void = () => undefined
      const landed = new Promise<boolean>((resolve) => {
        listener = (name, at) => { if (name === event && at === path) resolve(true) }
        inner.on('all', listener)
      })
      // a change within the same millisecond as the last one can read as no change at all
      await settle(20)
      act()
      const seenIt = await Promise.race([landed, settle(3_000).then(() => false)])
      inner.off('all', listener)
      expect(seenIt, `${event} ${path}`).toBe(true)
    }
    await observed('change', file, () => writeFileSync(file, verdict('draft')))
    await observed('change', file, () => writeFileSync(file, verdict('second')))
    await vi.waitFor(() => expect(seen.at(-1)).toBe('second'), { timeout: 4_000 })
    await settle()
    expect(seen).toEqual(['first', 'second'])

    // the same bytes again, and a neighbour in .harness/ added, changed and removed, publish nothing
    await observed('change', file, () => writeFileSync(file, verdict('second')))
    const neighbour = join(workspace, '.harness', 'other.json')
    await observed('add', neighbour, () => writeFileSync(neighbour, '{}'))
    await observed('change', neighbour, () => writeFileSync(neighbour, '{"a":1}'))
    await observed('unlink', neighbour, () => rmSync(neighbour))
    await settle(400)
    expect(seen).toEqual(['first', 'second'])

    rmSync(file)
    await vi.waitFor(() => expect(seen.at(-1)).toBeNull(), { timeout: 4_000 })
    expect(watcher.current('a')).toBeNull()
  }, 15_000)

  it('watching the same file again is a no-op; a different file replaces the watch', async () => {
    const first = join(workspace, 'one', 'verdict.json')
    const second = join(workspace, 'two', 'verdict.json')
    mkdirSync(join(workspace, 'one'))
    mkdirSync(join(workspace, 'two'))
    writeFileSync(first, verdict('one'))
    writeFileSync(second, verdict('two'))
    const seen: Array<string | null> = []
    watcher = new DshVerdictWatcher({ onChange: (_id, v) => seen.push(v ? v.summary : null) })
    watcher.watch('a', first)
    watcher.watch('a', first)
    expect(seen).toEqual(['one'])
    watcher.watch('a', second)
    expect(seen).toEqual(['one', 'two'])
    await settle()
    writeFileSync(first, verdict('one again'))
    await settle(600)
    expect(seen).toEqual(['one', 'two'])
  }, 10_000)

  it('logs, and watches nothing, when the verdict directory cannot be made', () => {
    writeFileSync(join(workspace, 'plain-file'), '')
    const logs: string[] = []
    watcher = new DshVerdictWatcher({ onChange: () => undefined, log: (line) => logs.push(line) })
    watcher.watch('a', join(workspace, 'plain-file', '.harness', 'verdict.json'))
    expect(logs).toEqual([expect.stringMatching(/^\[dsh\] verdict dir .*plain-file\/\.harness could not be created · ENOTDIR/)])
    expect(watcher.current('a')).toBeNull()
    // and with no log at all, still no throw
    new DshVerdictWatcher({ onChange: () => undefined }).watch('b', join(workspace, 'plain-file', 'x', 'verdict.json'))
  })

  it('logs a watch error, whatever was thrown', () => {
    const logs: string[] = []
    watcher = new DshVerdictWatcher({ onChange: () => undefined, log: (line) => logs.push(line) })
    watcher.watch('a', join(workspace, '.harness', 'verdict.json'))
    innerWatcher(watcher, 'a').emit('error', new Error('EMFILE: too many open files'))
    innerWatcher(watcher, 'a').emit('error', 'a string')
    expect(logs).toEqual(['[dsh] verdict watch error · EMFILE: too many open files', '[dsh] verdict watch error · a string'])
    // with nowhere to log, an error is still not a throw
    const quiet = new DshVerdictWatcher({ onChange: () => undefined })
    quiet.watch('q', join(workspace, 'q', 'verdict.json'))
    expect(() => innerWatcher(quiet, 'q').emit('error', new Error('x'))).not.toThrow()
    void quiet.stop()
  })

  it('unwatch and stop cancel a publish still in its debounce', async () => {
    const file = join(workspace, '.harness', 'verdict.json')
    const seen: Array<string | null> = []
    watcher = new DshVerdictWatcher({ onChange: (id, v) => seen.push(`${id}:${v?.summary ?? null}`) })
    watcher.unwatch('never-watched')
    watcher.watch('a', file)
    watcher.watch('b', join(workspace, 'b', '.harness', 'verdict.json'))
    await settle()
    // the add events land, then the watches go before their 150ms debounce fires
    const landed = ['a', 'b'].map((id) => new Promise<void>((resolve) => innerWatcher(watcher!, id).once('add', () => resolve())))
    writeFileSync(file, verdict('late'))
    writeFileSync(join(workspace, 'b', '.harness', 'verdict.json'), verdict('late'))
    await Promise.all(landed)
    watcher.unwatch('a')
    await watcher.stop()
    await settle(400)
    expect(seen).toEqual([])
  }, 10_000)
})
