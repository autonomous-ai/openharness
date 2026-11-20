import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { once, type EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshVerdictWatcher, parseVerdict, type DshVerdict } from './verdict.js'

/**
 * The chokidar instance behind one agent's watch: to wait for its `ready`, or announce what chokidar would. A spec writes
 * a file and announces the write itself: macOS hands a watch its events in batches, on a loaded Mac many seconds after the
 * write (12 s seen at load 20), so a wait for chokidar's own event has no bound.
 */
const innerWatcher = (w: DshVerdictWatcher, agentId: string): EventEmitter & { closed: boolean } =>
  (w as unknown as { watched: Map<string, { watcher: EventEmitter & { closed: boolean } }> }).watched.get(agentId)!.watcher

/** The debounce held: a publish waits until the test runs it. */
function heldDebounce() {
  const pending = new Set<() => void>()
  return {
    debounce: (run: () => void): (() => void) => {
      const once = (): void => { pending.delete(once); run() }
      pending.add(once)
      return () => { pending.delete(once) }
    },
    get pending(): number { return pending.size },
    run: (): void => { for (const run of [...pending]) run() },
  }
}

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
      preview: null,
      phases: [],
      updatedAt: '2026-09-14T20:00:00Z',
    })
  })

  it('names a preview only as a loopback page with a port', () => {
    const preview = (value: unknown): string | null | undefined => parseVerdict(JSON.stringify({ spec: 1, ready: true, preview: value }))?.preview
    expect(preview('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/')
    expect(preview('http://localhost:3000/menu?x=1')).toBe('http://localhost:3000/menu?x=1')
    expect(preview('http://example.com:5173/')).toBeNull()
    expect(preview('https://127.0.0.1:5173/')).toBeNull()
    expect(preview('http://127.0.0.1/')).toBeNull()
    expect(preview('http://me:pw@127.0.0.1:5173/')).toBeNull()
    expect(preview(5173)).toBeNull()
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
    const ready = once(innerWatcher(watcher, 'agent-1'), 'ready')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.summary).toBe('first')
    expect(watcher.current('agent-1')?.summary).toBe('first')

    const next = new Promise<void>((resolve) => { resolveNext = resolve })
    await ready
    writeFileSync(file, JSON.stringify({ spec: 1, ready: true, summary: 'second' }))
    innerWatcher(watcher, 'agent-1').emit('change', file)
    await next
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

describe('the edges of parseVerdict', () => {
  it('reads a blank summary, no findings and an empty artifact as nothing', () => {
    expect(parseVerdict(JSON.stringify({ spec: 1, ready: true, summary: '   ', findings: 'none', artifact: '' })))
      .toEqual({ ready: true, summary: null, errors: 0, warnings: 0, artifact: null, preview: null, phases: [], updatedAt: null })
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

  const verdict = (summary: string): string => JSON.stringify({ spec: 1, ready: false, summary })

  it('publishes a verdict that appears, debounces a burst, ignores other files and unchanged rewrites, and says when it goes', async () => {
    const file = join(workspace, '.harness', 'verdict.json')
    const seen: Array<string | null> = []
    const clock = heldDebounce()
    watcher = new DshVerdictWatcher({ onChange: (_id, v) => seen.push(v ? v.summary : null), debounce: clock.debounce })
    watcher.watch('a', file)
    const inner = innerWatcher(watcher, 'a')
    await once(inner, 'ready')
    expect(seen).toEqual([])
    expect(watcher.current('a')).toBeNull()

    writeFileSync(file, verdict('first'))
    inner.emit('add', file)
    expect(clock.pending).toBe(1)
    clock.run()
    expect(seen).toEqual(['first'])
    expect(watcher.current('a')?.summary).toBe('first')

    // two changes inside the debounce are one publish, of the last write
    writeFileSync(file, verdict('draft'))
    inner.emit('change', file)
    writeFileSync(file, verdict('second'))
    inner.emit('change', file)
    expect(clock.pending).toBe(1)
    clock.run()
    expect(seen).toEqual(['first', 'second'])

    // a neighbour in .harness/ added, changed and removed schedules nothing, and the same bytes again publish nothing
    const neighbour = join(workspace, '.harness', 'other.json')
    for (const event of ['add', 'change', 'unlink']) inner.emit(event, neighbour)
    expect(clock.pending).toBe(0)
    writeFileSync(file, verdict('second'))
    inner.emit('change', file)
    clock.run()
    expect(seen).toEqual(['first', 'second'])

    rmSync(file)
    inner.emit('unlink', file)
    expect(clock.pending).toBe(1)
    clock.run()
    expect(seen).toEqual(['first', 'second', null])
    expect(watcher.current('a')).toBeNull()
  }, 15_000)

  it('publishes a verdict written while the watch is still starting', async () => {
    // chokidar reads the directory after watch() returns and counts what it finds there as already present: a
    // verdict written in between, as a harness that writes one at once does, waited for its next change.
    const file = join(workspace, '.harness', 'verdict.json')
    const seen: Array<string | null> = []
    watcher = new DshVerdictWatcher({ onChange: (_id, v) => seen.push(v ? v.summary : null) })
    watcher.watch('a', file)
    const ready = once(innerWatcher(watcher, 'a'), 'ready')
    writeFileSync(file, verdict('early'))
    await ready
    expect(seen).toEqual(['early'])
  })

  it('watching the same file again is a no-op; a different file replaces the watch', () => {
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
    const old = innerWatcher(watcher, 'a')
    watcher.watch('a', second)
    expect(seen).toEqual(['one', 'two'])
    // the first file's watch is closed: a change there reaches nothing
    expect(old.closed).toBe(true)
  })

  it('logs, and watches nothing, when the verdict directory cannot be made', () => {
    writeFileSync(join(workspace, 'plain-file'), '')
    const logs: string[] = []
    watcher = new DshVerdictWatcher({ onChange: () => undefined, log: (line) => logs.push(line) })
    watcher.watch('a', join(workspace, 'plain-file', '.harness', 'verdict.json'))
    expect(logs).toEqual(['[dsh] verdict dir could not be created · ENOTDIR'])
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
    expect(logs).toEqual(['[dsh] verdict watch error · Error', '[dsh] verdict watch error · string'])
    // with nowhere to log, an error is still not a throw
    const quiet = new DshVerdictWatcher({ onChange: () => undefined })
    quiet.watch('q', join(workspace, 'q', 'verdict.json'))
    expect(() => innerWatcher(quiet, 'q').emit('error', new Error('x'))).not.toThrow()
    void quiet.stop()
  })

  it('unwatch and stop cancel a publish still in its debounce', async () => {
    const files = { a: join(workspace, '.harness', 'verdict.json'), b: join(workspace, 'b', '.harness', 'verdict.json') }
    const seen: Array<string | null> = []
    const clock = heldDebounce()
    watcher = new DshVerdictWatcher({ onChange: (id, v) => seen.push(`${id}:${v?.summary ?? null}`), debounce: clock.debounce })
    watcher.unwatch('never-watched')
    // the add events land, then the watches go before their debounce runs
    for (const [id, file] of Object.entries(files)) {
      watcher.watch(id, file)
      writeFileSync(file, verdict('late'))
      innerWatcher(watcher, id).emit('add', file)
    }
    expect(clock.pending).toBe(2)
    watcher.unwatch('a')
    expect(clock.pending).toBe(1)
    await watcher.stop()
    expect(clock.pending).toBe(0)
    clock.run()
    expect(seen).toEqual([])
  })

  it('an old watch cannot publish into the same agent after it is watched again', async () => {
    const seen: string[] = []
    const first = join(workspace, 'first', 'verdict.json'), next = join(workspace, 'next', 'verdict.json')
    watcher = new DshVerdictWatcher({ onChange: (_id, value) => seen.push(value?.summary ?? '') })
    watcher.watch('a', first)
    const oldChange = innerWatcher(watcher, 'a').listeners('change')[0] as (path: string) => void
    watcher.unwatch('a')
    watcher.watch('a', next)
    vi.useFakeTimers()
    try {
      writeFileSync(first, verdict('old run'))
      oldChange(first)
      await vi.advanceTimersByTimeAsync(200)
      expect(seen).toEqual([])
    } finally { vi.useRealTimers() }
  })
})
