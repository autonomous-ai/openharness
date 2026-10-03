/**
 * DISTILL at its edges: who hit a signal (in words, never a machine), the model's hourly budget refilling,
 * replies of every wrong shape, prompts for every kind of signal with parts missing, and lessons that are
 * empty once their control characters are gone.
 */
import { describe, expect, it, vi } from 'vitest'
import { DISTILL_BUDGET_MS, LessonDistiller, distillPrompt, guardLesson, parseDistilled, slug, templateLesson, whoHit } from './distill.js'
import type { PairOneShot } from '../triage.js'
import type { Provenance, Signal } from './types.js'

const at = 1_000_000
const from = (engine: string, agentId: string, turn = 1, session = `s-${agentId}`): Provenance => ({ engine, machine: 'm2', agentId, session, turn, project: 'abc', at })
const steps = (patch: Partial<Signal> = {}): Signal => ({
  kind: 'repeat-steps', key: 'steps:abc:x', project: 'abc', projectName: 'api', at,
  from: [from('claude', 'a1', 1), from('codex', 'b1', 3), from('claude', 'a1', 4)], evidence: ['npm test'],
  steps: ['npm run lint', 'npm run build', 'npm test'], ...patch,
})

describe('whoHit', () => {
  it('names engines when there are several, else counts harnesses of the one engine', () => {
    expect(whoHit([from('claude', 'a'), from('codex', 'b'), from('pi', 'c')])).toBe('claude, codex and pi')
    expect(whoHit([from('claude', 'a'), from('codex', 'b')])).toBe('claude and codex')
    expect(whoHit([from('claude', 'a'), from('claude', 'b')])).toBe('two claude harnesses')
    expect(whoHit([from('claude', 'a'), from('claude', 'b'), from('claude', 'c')])).toBe('3 claude harnesses')
    expect(whoHit([from('claude', 'a'), from('claude', 'a')])).toBe('1 claude harnesses')
    expect(whoHit([])).toBe('0 agent harnesses')
  })
})

describe('slug', () => {
  it('lowercase words joined by one dash, capped, never ending in a dash', () => {
    expect(slug('  Run: THE tests!! ')).toBe('run-the-tests')
    expect(slug('a'.repeat(10) + ' b', 11)).toBe('aaaaaaaaaa')
    expect(slug('--')).toBe('')
  })
})

describe('the model budget', () => {
  it('refills an hour after each call', async () => {
    let now = at
    const oneshot = vi.fn<PairOneShot>(async () => '{"lesson": null}')
    const d = new LessonDistiller({ oneshot, modelEnabled: () => true, now: () => now, hourlyCap: 1 })
    expect(await d.distill(steps())).toMatchObject({ lesson: null, why: 'nothing', source: 'model' })
    now += 59 * 60_000
    expect(await d.distill(steps())).toEqual({ lesson: null, why: 'cap' })
    expect(oneshot).toHaveBeenCalledTimes(1)
    now += 60_000
    expect(await d.distill(steps())).toMatchObject({ source: 'model' })
    expect(oneshot).toHaveBeenCalledTimes(2)
  })

  it('asks with the default budget when none is set, and passes an abort signal', async () => {
    const oneshot = vi.fn<PairOneShot>(async () => 'nothing worth saving')
    const d = new LessonDistiller({ oneshot, modelEnabled: () => true, now: () => at })
    expect(await d.distill(steps())).toMatchObject({ lesson: null, why: 'nothing' })
    expect(oneshot.mock.calls[0]![1]).toMatchObject({ timeoutMs: DISTILL_BUDGET_MS, signal: expect.any(AbortSignal) })
  })

  it('a model that runs past its budget is aborted, and the template answers', async () => {
    let signal: AbortSignal | undefined
    const oneshot = vi.fn<PairOneShot>((_prompt, opts) => { signal = opts?.signal; return new Promise(() => {}) })
    const d = new LessonDistiller({ oneshot, modelEnabled: () => true, now: () => at, budgetMs: 20 })
    expect(await d.distill(steps())).toMatchObject({ source: 'template', lesson: { kind: 'skill' } })
    expect(signal?.aborted).toBe(true)
  })

  it('off unless pair.jsonc turns it on', async () => {
    const oneshot = vi.fn<PairOneShot>(async () => '{"lesson": null}')
    await new LessonDistiller({ oneshot, now: () => at }).distill(steps())
    await new LessonDistiller({ oneshot, modelEnabled: () => false, now: () => at }).distill(steps())
    expect(oneshot).not.toHaveBeenCalled()
  })
})

describe('parseDistilled: only the JSON asked for', () => {
  it('every other shape is bad-json; null and false are nothing', () => {
    for (const text of ['{not json}', '{"lesson": 5}', '{"lesson": "a skill"}', '{"other": 1}', '[1]', '{"lesson": {"kind": "note", "lines": [1, 2]}}',
      '{"lesson": {"kind": "note", "lines": 5}}', '{"lesson": {"kind": "skill", "name": "x", "description": "y"}}', '{"lesson": {"kind": "script"}}',
      'x'.repeat(300)]) {
      expect(parseDistilled(text), text).toBe('bad-json')
    }
    expect(parseDistilled('{"lesson": false}')).toBe('nothing')
    expect(parseDistilled('Here: {"lesson": null} — done')).toBe('nothing')
    expect(parseDistilled('null')).toBe('nothing')
    expect(parseDistilled('{"lesson": {"kind": "note", "lines": "one\\ntwo"}}')).toEqual({ kind: 'note', lines: ['one', 'two'] })
  })
})

describe('prompts for every kind of signal, parts missing', () => {
  it('names what failed, or "check", and the steps, or none; a borrowed signal names its engine', () => {
    const failure: Signal = { kind: 'repeat-failure', key: 'f', project: null, projectName: null, at, from: [], evidence: [] }
    expect(distillPrompt(failure)).toContain('The same check failed for two different agents in this project within a week: .')
    expect(distillPrompt(failure)).toContain('Project: unknown. Agents: unknown.')
    expect(distillPrompt(failure)).toContain('<evidence>\n- (none)\n</evidence>')
    expect(distillPrompt({ ...failure, kind: 'repeat-steps' })).toContain('in 0 separate turns in this project: .')
    expect(distillPrompt({ ...failure, kind: 'borrowed' })).toContain('One agent (another engine) saved this on its own.')
    expect(distillPrompt({ ...failure, kind: 'borrowed', borrowed: { engine: 'hermes', source: 'skills/x' } })).toContain('One agent (hermes) saved this on its own.')
    expect(distillPrompt({ ...failure, kind: 'correction', from: [from('codex', 'b1', 14)] })).toContain('Agents: codex on m2 (turn 14).')
  })
})

describe('templates with parts missing', () => {
  it('no project name reads "this project"; no steps is no lesson', () => {
    const lesson = templateLesson(steps({ projectName: null, from: [from('claude', 'a1', 1), from('codex', 'b1', 3), from('claude', 'a1', 4)] }))
    expect(lesson).toMatchObject({ kind: 'skill', name: 'run-npm-run-lint-before-npm-test' })
    expect(lesson?.kind === 'skill' && lesson.description).toContain('in this project, in order')
    expect(templateLesson(steps({ projectName: '\u0000\u0001' }))?.kind === 'skill' && (templateLesson(steps({ projectName: '\u0000\u0001' })) as { description: string }).description).toContain('in this project')
    expect(templateLesson(steps({ steps: undefined }))).toBeNull()
    expect(templateLesson(steps({ steps: ['a', '', 'b'] }))).toBeNull()
  })
})

describe('guardLesson: empty once cleaned', () => {
  it('a note of only control characters and spaces is empty; a skill whose words are only control characters too', () => {
    expect(guardLesson({ kind: 'note', lines: ['\u0000\u0007', '   ', '\t\r\n'] }, 'model')).toEqual({ lesson: null, why: 'empty', source: 'model' })
    // A bullet is taken off a line: `- ` before words goes.
    expect(guardLesson({ kind: 'note', lines: ['-   Run lint first.', '* Then test.'] }, 'model')).toEqual({ lesson: { kind: 'note', lines: ['Run lint first.', 'Then test.'] }, source: 'model' })
    expect(guardLesson({ kind: 'skill', name: 'fine-name', description: '\u0001\u0002', body: 'Body.' }, 'model')).toMatchObject({ lesson: null, why: 'empty' })
    expect(guardLesson({ kind: 'skill', name: 'fine-name', description: 'Fine.', body: '<!---->' }, 'model')).toMatchObject({ lesson: null, why: 'empty' })
  })

  it('a longer body passes when the caller allows it (a borrowed skill)', () => {
    const body = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}.`).join('\n')
    expect(guardLesson({ kind: 'skill', name: 'long-one', description: 'Long.', body }, 'borrowed')).toMatchObject({ lesson: null, why: 'too-long' })
    expect(guardLesson({ kind: 'skill', name: 'long-one', description: 'Long.', body }, 'borrowed', { maxBodyLines: 60 })).toMatchObject({ lesson: { kind: 'skill' }, source: 'borrowed' })
  })
})
