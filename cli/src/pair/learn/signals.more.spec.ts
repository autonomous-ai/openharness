/**
 * L1 NOTICE, the edges (daemons/LEARNING.md): every engine's shell shape, events that arrive out of order or
 * malformed, a harness that changes folders, sub-agents, the bounds that keep memory and the 0600 file small,
 * a state file from another version, a signal handler that throws, and a file that cannot be written.
 * Fake clock; temp files only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAILURE_WINDOW_MS, LessonSignals, STEPS_WINDOW_MS, failingTests, shellCommand, stepOf, type LearnContext, type LearnEvent } from './signals.js'
import { projectHash, type Signal } from './types.js'

let dir: string
let clock: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'learn-signals-more-')); clock = 2_000_000_000 })
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

const HOME = '/Users/someone'
const API = `${HOME}/code/api`
const WEB = `${HOME}/code/web`
const DAY = 24 * 60 * 60_000
const ctx = (agentId: string, engine = 'claude', cwd: string | null = API, sessionId = `s-${agentId}`): LearnContext => ({ agentId, sessionId, engine, cwd })

function detector(opts: { file?: string | null; home?: string | null; onSignal?: (s: Signal) => void } = {}) {
  const signals: Signal[] = []
  const d = new LessonSignals({
    now: () => clock, machine: () => 'm2', onSignal: opts.onSignal ?? ((s) => signals.push(s)),
    file: opts.file === undefined ? join(dir, 'signals.json') : opts.file, ...(opts.home === undefined ? { home: HOME } : opts.home === null ? {} : { home: opts.home }),
  })
  return { d, signals }
}

let toolSeq = 0
const bash = (command: string, output = '', isError = false): LearnEvent[] => {
  const id = `t${++toolSeq}`
  return [
    { type: 'tool_start', payload: { id, tool: 'Bash', input: { command } } },
    { type: 'tool_end', payload: { id, tool: 'Bash', output, isError } },
  ]
}
const turn = (prompt: string, body: LearnEvent[] = []): LearnEvent[] => [
  { type: 'turn_started', payload: { userMessage: prompt } }, ...body, { type: 'turn_ended', payload: {} },
]
const routine = (): LearnEvent[] => [...bash('npm run db:reset'), ...bash('npm run migrate'), ...bash('npm test')]

describe('shellCommand: every shape a shell tool call comes in', () => {
  it('a raw string input that is not JSON is the command itself; blank is nothing', () => {
    expect(shellCommand('Bash', '  make lint  ')).toBe('make lint')
    expect(shellCommand('Bash', '   ')).toBeNull()
    expect(shellCommand('functions.exec_command', 'cargo build')).toBe('cargo build')
  })

  it('a JSON string input holding a bare string or an argv array', () => {
    expect(shellCommand('shell', JSON.stringify('npm ci'))).toBe('npm ci')
    expect(shellCommand('local_shell', JSON.stringify(['git', 'push']))).toBe('git push')
    expect(shellCommand('local_shell', JSON.stringify(['/bin/zsh', '-c', 'make test']))).toBe('make test')
  })

  it('an empty or blank command, and an argv that is not all strings, are nothing', () => {
    expect(shellCommand('Bash', { command: '   ' })).toBeNull()
    expect(shellCommand('shell', { command: ['bash', '-lc', '   '] })).toBeNull()
    expect(shellCommand('shell', { command: [] })).toBeNull()
    expect(shellCommand('shell', { command: ['npm', 3] })).toBeNull()
    expect(shellCommand('shell', null)).toBeNull()
    // Three words that are not a shell's `-c`: the whole argv is the command.
    expect(shellCommand('shell', { command: ['node', '-e', 'x'] })).toBe('node -e x')
  })
})

describe('stepOf and failingTests, the edges', () => {
  it('a runner given a path first names only the runner', () => {
    expect(stepOf('pytest tests/unit/test_api.py -x')).toBe('pytest')
    expect(stepOf('vitest src/pair/shell.spec.ts')).toBe('vitest')
    expect(stepOf('node ./scripts/build.js --prod')).toBe('node build.js')
  })

  it('reads at most twenty failing names from one run, and answers five', () => {
    const output = Array.from({ length: 30 }, (_, i) => ` FAIL  src/f${i}.spec.ts`).join('\n')
    expect(failingTests(output)).toEqual(['src/f0.spec.ts', 'src/f1.spec.ts', 'src/f2.spec.ts', 'src/f3.spec.ts', 'src/f4.spec.ts'])
  })
})

describe('events out of order, malformed, or from a sub-agent', () => {
  it('ignores a payload that is not an object, an unknown event, and a turn_started with no message', () => {
    const { d, signals } = detector()
    d.ingest(ctx('a1'), [
      { type: 'turn_started', payload: 'not an object' }, { type: 'session_meta', payload: { x: 1 } },
      { type: 'text_delta', payload: { content: 42 } }, { type: 'turn_ended' },
    ])
    // The turn with no message ended: the next prompt answers it, and it is a correction.
    d.ingest(ctx('a1'), turn('no, the other file'))
    expect(signals.map((s) => [s.kind, s.correction?.said])).toEqual([['correction', 'no, the other file']])
    expect(signals[0]!.evidence).toEqual(['the person said: no, the other file'])
  })

  it('a text_delta before anything else of that agent, and a turn_ended with no turn, change nothing', () => {
    const { d, signals } = detector()
    d.ingest(ctx('a1'), [{ type: 'text_delta', payload: { content: 'hello' } }, { type: 'turn_ended', payload: {} }])
    // No turn was seen ending: the first prompt answers nothing.
    d.ingest(ctx('a1'), turn('no, stop'))
    expect(signals).toEqual([])
  })

  it('a tool_end without its start, a start with no id or tool, and a sub-agent\'s tool are not the agent\'s steps', () => {
    const { d, signals } = detector()
    const noise: LearnEvent[] = [
      { type: 'tool_end', payload: { id: 'never-started', output: ' FAIL  src/a.spec.ts', isError: true } },
      { type: 'tool_start', payload: { id: 7, tool: 'Bash', input: { command: 'npm test' } } },
      { type: 'tool_end', payload: { id: 7, output: ' FAIL  src/a.spec.ts', isError: true } },
      { type: 'tool_start', payload: { id: 'x', tool: null, input: { command: 'npm test' } } },
      { type: 'tool_end', payload: { id: 'x', output: ' FAIL  src/a.spec.ts', isError: true } },
      { type: 'tool_start', payload: { id: 'sub', tool: 'Bash', input: { command: 'npm test' }, parentToolUseId: 'task-1' } },
      { type: 'tool_end', payload: { id: 'sub', output: ' FAIL  src/a.spec.ts', isError: true } },
    ]
    d.ingest(ctx('a1', 'claude'), turn('t', noise))
    d.ingest(ctx('b1', 'codex'), turn('t', noise))
    expect(signals).toEqual([])
    // The same failure, run by the agents themselves, is one.
    d.ingest(ctx('a1', 'claude'), turn('t', bash('npm test', ' FAIL  src/a.spec.ts', true)))
    d.ingest(ctx('b1', 'codex'), turn('t', bash('npm test', ' FAIL  src/a.spec.ts', true)))
    expect(signals.map((s) => s.failure)).toEqual([{ what: 'test', name: 'src/a.spec.ts' }])
  })

  it('a failing tool_end whose output is not text still names the failing command', () => {
    const { d, signals } = detector()
    for (const [agent, engine] of [['a1', 'claude'], ['b1', 'codex']] as const) {
      d.ingest(ctx(agent, engine), turn('t', [
        { type: 'tool_start', payload: { id: `${agent}-1`, tool: 'Bash', input: { command: 'make release' } } },
        { type: 'tool_end', payload: { id: `${agent}-1`, output: { stderr: 'boom' }, isError: true } },
      ]))
    }
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ kind: 'repeat-failure', failure: { what: 'command', name: 'make release' } })
    expect(signals[0]!.evidence[1]).toBe('make release ->')
  })

  it('keeps at most 200 open tool calls per agent: the oldest start is forgotten', () => {
    const { d, signals } = detector()
    const starts: LearnEvent[] = Array.from({ length: 201 }, (_, i) => ({ type: 'tool_start', payload: { id: `open-${i}`, tool: 'Bash', input: { command: 'make release' } } }))
    for (const [agent, engine] of [['a1', 'claude'], ['b1', 'codex']] as const) {
      d.ingest(ctx(agent, engine), [{ type: 'turn_started', payload: { userMessage: 'go' } }, ...starts])
      // The first start was pushed out: its end is not a step, and not a failure.
      d.ingest(ctx(agent, engine), [{ type: 'tool_end', payload: { id: 'open-0', output: 'x', isError: true } }])
    }
    expect(signals).toEqual([])
    for (const [agent, engine] of [['a1', 'claude'], ['b1', 'codex']] as const) {
      d.ingest(ctx(agent, engine), [{ type: 'tool_end', payload: { id: 'open-200', output: 'x', isError: true } }])
    }
    expect(signals.map((s) => s.failure)).toEqual([{ what: 'command', name: 'make release' }])
  })
})

describe('the project follows the harness', () => {
  it('a harness that moves to another folder mid-session is counted in the new project', () => {
    const { d, signals } = detector()
    d.ingest(ctx('a1', 'claude', API), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    d.ingest(ctx('a1', 'claude', WEB), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    // A codex harness in web fails the same way: the pair is claude-in-web and codex-in-web.
    d.ingest(ctx('b1', 'codex', WEB), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ project: projectHash(WEB), projectName: 'web' })
    expect(signals[0]!.from.map((f) => [f.agentId, f.project])).toEqual([['a1', projectHash(WEB)], ['b1', projectHash(WEB)]])
  })

  it('a correction with no known folder is still a correction, keyed without a project', () => {
    const { d, signals } = detector()
    d.ingest(ctx('a1', 'claude', null), turn('build'))
    d.ingest(ctx('a1', 'claude', null), turn('stop, wrong file'))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ kind: 'correction', project: null, projectName: null })
    expect(signals[0]!.key).toMatch(/^correction:-:[0-9a-f]{24}$/)
  })

  it('two harnesses whose folders are unknown are never "the same project": no repeat-failure between them', () => {
    const { d, signals } = detector()
    d.ingest(ctx('a1', 'claude', null), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    d.ingest(ctx('b1', 'codex', null), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    d.ingest(ctx('c1', 'codex', null), turn('t', bash('npm run build', 'error', true)))
    d.ingest(ctx('d1', 'claude', null), turn('t', bash('npm run build', 'error', true)))
    expect(signals).toEqual([])
    // Nor is either of them remembered to pair with a known project later.
    d.ingest(ctx('e1', 'claude', API), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    expect(signals).toEqual([])
    expect(readFileSync(join(dir, 'signals.json'), 'utf8')).not.toContain('test:-:')
  })
})

describe('forget and the daemon\'s own words', () => {
  it('forget drops the harness\'s turn and what the daemon typed into it', () => {
    const { d, signals } = detector()
    d.ingest(ctx('a1'), turn('build it'))
    d.forget('a1')
    // What follows is the first prompt of a harness it knows nothing about: nothing to correct.
    d.ingest(ctx('a1'), turn('no, the other branch'))
    expect(signals).toEqual([])
    d.daemonSent('a1', 'stop, run the linter first')
    d.forget('a1')
    d.ingest(ctx('a1'), turn('go'))
    // The daemon's words were forgotten with the harness: the person typing the same words is heard.
    d.ingest(ctx('a1'), turn('stop, run the linter first'))
    expect(signals.map((s) => s.kind)).toEqual(['correction'])
  })

  it('remembers the daemon\'s last five prompts per harness, each matched once', () => {
    const { d, signals } = detector()
    d.ingest(ctx('a1'), turn('go'))
    for (let i = 0; i < 6; i++) d.daemonSent('a1', `no, step ${i}`)
    d.ingest(ctx('a1'), turn('no, step 5'))       // the daemon's
    d.ingest(ctx('a1'), turn('no, step 5'))       // matched once: now it is the person
    d.ingest(ctx('a1'), turn('no, step 0'))       // the sixth back was dropped: the person
    expect(signals.map((s) => s.correction?.said)).toEqual(['no, step 5', 'no, step 0'])
  })
})

describe('repeat-steps, the edges', () => {
  it('one turn that runs the routine twice counts once', () => {
    const { d, signals } = detector()
    for (let i = 0; i < 2; i++) d.ingest(ctx('a1'), turn(`t${i}`, [...routine(), ...routine()]))
    expect(signals).toEqual([])
    d.ingest(ctx('a1'), turn('t3', routine()))
    expect(signals).toHaveLength(1)
    expect(signals[0]!.steps).toEqual(['npm run db:reset', 'npm run migrate', 'npm test'])
    expect(signals[0]!.from.map((f) => f.turn)).toEqual([1, 2, 3])
  })

  it('four steps repeated: names all four, and never later the shorter runs inside them', () => {
    const { d, signals } = detector()
    const four = (): LearnEvent[] => [...routine(), ...bash('npm run seed')]
    for (let i = 0; i < 3; i++) d.ingest(ctx('a1'), turn(`t${i}`, four()))
    expect(signals.map((s) => s.steps)).toEqual([['npm run db:reset', 'npm run migrate', 'npm test', 'npm run seed']])
    // The three-step runs inside it reached three turns too: already said, as part of the longer one.
    d.ingest(ctx('a1'), turn('t3', routine()))
    d.ingest(ctx('a1'), turn('t4', [...bash('npm run migrate'), ...bash('npm test'), ...bash('npm run seed')]))
    expect(signals).toHaveLength(1)
  })

  it('keeps only the last 200 steps of a long turn', () => {
    const { d, signals } = detector()
    const long = (): LearnEvent[] => [...routine(), ...Array.from({ length: 200 }, () => bash('npm run lint')).flat()]
    // The routine scrolled out of every turn: only `npm run lint` is left, which is no sequence.
    for (let i = 0; i < 3; i++) d.ingest(ctx('a1'), turn(`t${i}`, long()))
    expect(signals).toEqual([])
  })

  it('a turn done a month apart has expired: windows and signaled marks are pruned', () => {
    const file = join(dir, 'signals.json')
    const { d, signals } = detector({ file })
    d.ingest(ctx('a1'), turn('one', routine()))
    d.ingest(ctx('a1'), turn('two', routine()))
    clock += STEPS_WINDOW_MS
    d.ingest(ctx('a1'), turn('three', routine()))
    expect(signals).toEqual([])
    d.ingest(ctx('a1'), turn('four', routine()))
    d.ingest(ctx('a1'), turn('five', routine()))
    expect(signals).toHaveLength(1)
    // An unrelated turn a month later prunes both the old windows and the old signaled mark.
    clock += STEPS_WINDOW_MS
    d.ingest(ctx('a1'), turn('six', [...bash('make a'), ...bash('make b'), ...bash('make c')]))
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { windows: Record<string, unknown>; signaled: Record<string, number> }
    expect(Object.keys(saved.windows).every((key) => key.includes('make '))).toBe(true)
    expect(saved.signaled).toEqual({})
  })

  it('keeps at most 2,000 step windows on disk, dropping the least recently seen', () => {
    const file = join(dir, 'signals.json')
    const project = projectHash(API)!
    const from = (at: number) => ({ engine: 'claude', machine: 'm2', agentId: 'old', session: 's', turn: 1, project, at })
    const windows: Record<string, unknown[]> = {}
    for (let i = 0; i < 2_000; i++) windows[`steps:${project}:./a${i}.sh > ./b${i}.sh > ./c${i}.sh`] = [{ from: from(clock - DAY + i), commands: [] }]
    // The one this turn completes, seen twice before: the oldest of all by its last turn, yet touched now.
    const routineKey = `steps:${project}:npm run db:reset > npm run migrate > npm test`
    windows[routineKey] = [{ from: { ...from(clock - 2 * DAY), turn: 1 }, commands: [] }, { from: { ...from(clock - 2 * DAY), turn: 2 }, commands: [] }]
    writeFileSync(file, JSON.stringify({ v: 1, failures: [], windows, signaled: {} }))
    const { d, signals } = detector({ file })
    d.ingest(ctx('a1'), turn('t', routine()))
    expect(signals.map((s) => s.steps)).toEqual([['npm run db:reset', 'npm run migrate', 'npm test']])
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { windows: Record<string, unknown> }
    const keys = Object.keys(saved.windows)
    expect(keys).toHaveLength(2_000)
    expect(keys).toContain(routineKey)
    // The least recently seen went: a0 alone (the one this turn touched is the newest now).
    expect(keys).not.toContain(`steps:${project}:./a0.sh > ./b0.sh > ./c0.sh`)
    expect(keys).toContain(`steps:${project}:./a1.sh > ./b1.sh > ./c1.sh`)
    expect(keys).toContain(`steps:${project}:./a1999.sh > ./b1999.sh > ./c1999.sh`)
  })
})

describe('the file kept across restarts', () => {
  it('keeps at most 500 failures, the oldest dropped', () => {
    const file = join(dir, 'signals.json')
    const project = projectHash(API)!
    const failures = Array.from({ length: 500 }, (_, i) => ({
      key: `test:${project}:src/f${i}.spec.ts`, what: 'test', name: `src/f${i}.spec.ts`, evidence: '',
      from: { engine: 'claude', machine: 'm2', agentId: 'x', session: 's', turn: 1, project, at: clock - FAILURE_WINDOW_MS + 1_000 + i },
    }))
    writeFileSync(file, JSON.stringify({ v: 1, failures, windows: {}, signaled: {} }))
    const { d, signals } = detector({ file })
    d.ingest(ctx('b1', 'codex'), turn('t', bash('npm test', ' FAIL  src/f0.spec.ts', true)))
    // The oldest remembered one is the one it pairs with, and still said once before it is dropped.
    expect(signals.map((s) => s.failure?.name)).toEqual(['src/f0.spec.ts'])
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { failures: Array<{ name: string }> }
    expect(saved.failures).toHaveLength(500)
    expect(saved.failures[0]!.name).toBe('src/f1.spec.ts')
    expect(saved.failures.at(-1)!.name).toBe('src/f0.spec.ts')
  })

  it('a file from another version, or with the wrong shapes, starts empty and is rewritten sound', () => {
    const file = join(dir, 'signals.json')
    writeFileSync(file, JSON.stringify({ v: 2, failures: [{ key: 'x' }] }))
    let { d } = detector({ file })
    d.ingest(ctx('a1'), turn('t', bash('npm run build', 'error', true)))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ v: 1, windows: {}, signaled: {}, failures: [{ name: 'npm run build' }] })
    writeFileSync(file, JSON.stringify({ v: 1, failures: 'nope', windows: 3, signaled: null }))
    ;({ d } = detector({ file }))
    d.ingest(ctx('a1'), turn('t', bash('npm run build', 'error', true)))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ v: 1, windows: {}, signaled: {}, failures: [{ name: 'npm run build' }] })
    writeFileSync(file, '{ torn')
    ;({ d } = detector({ file }))
    d.ingest(ctx('a1'), turn('t', routine()))
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { v: number; failures: unknown[]; windows: Record<string, unknown[]>; signaled: object }
    expect(saved).toMatchObject({ v: 1, failures: [], signaled: {} })
    expect(Object.values(saved.windows).map((turns) => turns.length)).toEqual([1])
  })

  it('with no file, nothing is written anywhere and nothing survives a restart', () => {
    const first = detector({ file: null })
    first.d.ingest(ctx('a1'), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    const second = detector({ file: null })
    second.d.ingest(ctx('b1', 'codex'), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    expect(second.signals).toEqual([])
    expect(() => readFileSync(join(dir, 'signals.json'))).toThrow()
  })

  it('a file that cannot be written warns and keeps working in memory', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dir, 'a-file'), 'x')
    const { d, signals } = detector({ file: join(dir, 'a-file', 'signals.json') })
    d.ingest(ctx('a1'), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    d.ingest(ctx('b1', 'codex'), turn('t', bash('npm test', ' FAIL  src/x.spec.ts', true)))
    expect(signals).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[learn\] could not save signals: /))
  })

  it('without a home folder, only the usual home shapes are redacted', () => {
    const file = join(dir, 'signals.json')
    const { d } = detector({ file, home: null })
    d.ingest(ctx('a1', 'claude', '/srv/me/api'), turn('t', bash('cat /srv/me/api/x && npm run build --token=abcdef1234567', 'error', true)))
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('/srv/me/api/x')
    expect(text).not.toContain('abcdef1234567')
  })
})

describe('a signal handler that throws', () => {
  it('is logged, and noticing goes on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const { d } = detector({ onSignal: () => { calls++; if (calls === 1) throw new Error('queue full'); throw 'plain' } })
    d.ingest(ctx('a1'), turn('go'))
    d.ingest(ctx('a1'), turn('no, the other one'))
    d.ingest(ctx('a1'), turn('stop, wrong file'))
    expect(calls).toBe(2)
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['[learn] signal handler failed: queue full', '[learn] signal handler failed: plain'])
  })
})
