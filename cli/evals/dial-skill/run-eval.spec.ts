import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIAL_SKILL } from '../../src/devices/dialSkill.js'
import { RUBRIC_SHA } from './lib/judge.js'
import { loadScenarios } from './lib/scenarios.js'

const CLI = resolve(import.meta.dirname, '../..')
const RUNNER = join(import.meta.dirname, 'run-eval.mjs')
const SCENARIOS = new Map(loadScenarios().map((s) => [s.id, s]))

/** The fake `claude`'s judge: passes when the line or answer is the expected ask, and echoes it in the reason. */
const JUDGE = String.raw`const prompt = process.argv[process.argv.indexOf('-p') + 1]
const [ask, given] = [...prompt.matchAll(/^(\x60{3,})\n([\s\S]*?)\n\1$/gm)].map((m) => m[2])
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '',
  structured_output: { pass: given === ask, reason: 'judged ' + given },
  usage: { input_tokens: 2, output_tokens: 1 }, modelUsage: { 'claude-opus-5-5': {} } }))`

/** A fake agent run served by `model`: it rings the staged harness with a line holding $HOME, and prints its repo path. */
function agent(model: string, text = 'Looked around'): string {
  return String.raw`const home = process.env.HOME
require('node:child_process').execFileSync('harness', ['device', 'notify', 'Check ' + home])
for (const event of [
  { type: 'system', subtype: 'init', model: ${JSON.stringify(model)} },
  { type: 'assistant', message: { content: [
    { type: 'text', text: ${JSON.stringify(text)} + ' in ' + process.cwd() },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'harness device notify "Check ' + home + '"' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'shown' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Stopped in ' + process.cwd() + ' under ' + home,
    stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } },
]) console.log(JSON.stringify(event))`
}

const LIMITED = String.raw`console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true,
  result: "You've hit your limit · resets 6pm", usage: { input_tokens: 0, output_tokens: 0 } }))
process.exitCode = 1`

let tmp: string
let flow: string
let home: string
let bin: string
let calls: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dial-skill-run-')))
  flow = join(tmp, 'flow')
  home = join(tmp, 'home')
  bin = join(tmp, 'bin')
  calls = join(tmp, 'calls.log')
  for (const dir of [flow, home, bin, join(tmp, 'runs'), join(tmp, 'profile')]) mkdirSync(dir)
  fakeClaude(agent('claude-opus-5-5'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** The `claude` the runner finds on its PATH, for the agent and the judge alike; it logs each call to `calls`. */
function fakeClaude(agentBody: string): void {
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const judge = process.argv.includes('--json-schema')
require('node:fs').appendFileSync(${JSON.stringify(calls)}, judge ? 'judge\\n' : 'agent\\n')
if (judge) {
${JUDGE}
} else {
${agentBody}
}
`, { mode: 0o755 })
}

function callsMade(): string[] {
  return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
}

function writeState(state: object): void {
  writeFileSync(join(flow, '_state.json'), JSON.stringify(state))
}

/** The runner as a person runs it from cli/, with a HOME, TMPDIR and profile of the test's own. */
function runEval(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', RUNNER, '--flow', flow, ...args], {
    cwd: CLI,
    encoding: 'utf8',
    env: {
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME: home,
      TMPDIR: join(tmp, 'runs'),
      CLAUDE_CONFIG_DIR: join(tmp, 'profile'),
      ...env,
    },
  })
}

function jsonl(variant: string, file: string): any[] {
  const path = join(flow, variant, file)
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
}

describe('run-eval.mjs arguments', () => {
  it.each([
    ['--model', 'claude-opus-5-5'],
    ['--agents', 'codex'],
    ['--split', 'dev'],
  ])('refuses %s %s', (flag, value) => {
    const out = runEval(['--variant', 'baseline', flag, value, '--approve-harness'])

    expect(out.status).toBe(2)
    expect(callsMade()).toEqual([])
    expect(existsSync(join(flow, 'baseline'))).toBe(false)
  })

  it.each([
    ['unset', undefined],
    ['the default ~/.claude', 'HOME/.claude'],
  ])('refuses to run with CLAUDE_CONFIG_DIR %s', (_, profile) => {
    const out = runEval(['--variant', 'baseline', '--agents', 'oracle', '--cases', 'board-unplugged', '--approve-harness'],
      { CLAUDE_CONFIG_DIR: profile?.replace('HOME', home) })

    expect(out.status).toBe(2)
    expect(out.stderr).toMatch(/CLAUDE_CONFIG_DIR/)
    expect(callsMade()).toEqual([])
    expect(jsonl('baseline', 'results.jsonl')).toEqual([])
  })

  it.each([
    ['a case naming no scenario', ['--cases', 'board-unplugged,no-such-scenario']],
    ['a split _state.json does not list', ['--split', 'test']],
  ])('refuses %s', (_, args) => {
    writeState({ val_ids: ['board-unplugged.claude'] })

    const out = runEval(['--variant', 'baseline', '--agents', 'oracle', ...args, '--approve-harness'])

    expect(out.status).toBe(2)
    expect(callsMade()).toEqual([])
    expect(jsonl('baseline', 'results.jsonl')).toEqual([])
  })
})

describe('run-eval.mjs pass', () => {
  it('runs only the split\'s scenarios with the stand-ins, and scores them', () => {
    writeState({ train_ids: ['api-key-missing.claude'], val_ids: ['board-unplugged.claude', 'add-version-flag.claude'] })

    const out = runEval(['--variant', 'baseline', '--split', 'val', '--agents', 'oracle,null', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    const rows = jsonl('baseline', 'results.jsonl')
    expect(Object.fromEntries(rows.map((r) => [r.prompt_id, r.grade]))).toEqual({
      'board-unplugged.oracle': { score: 4, rang: 1, hit: 1, line_ok: 1, ask_ok: 1 },
      'board-unplugged.null': { score: -2, rang: 0, hit: 0, ask_ok: 0 },
      'add-version-flag.oracle': { score: 0, rang: 0, quiet: 1 },
      'add-version-flag.null': { score: 0, rang: 0, quiet: 1 },
    })
    for (const row of rows) {
      const [scenario, agentKind] = row.prompt_id.split('.')
      const s = SCENARIOS.get(scenario)!
      expect(row).toMatchObject({
        prompt: s.prompt,
        tags: [s.need, s.kind, agentKind],
        meta: { scenario, agent: agentKind, skill: false, rubric_sha: RUBRIC_SHA },
        model: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        status: 'ok',
        tool_calls: 0,
        rings: agentKind === 'oracle' && s.need === 'need' ? 1 : 0,
      })
    }
    expect(rows.find((r) => r.prompt_id === 'board-unplugged.oracle').judge_model).toBe('claude-opus-5-5')
    // Two judge calls for each need row, none for no-need rows, and no agent ever started.
    expect(callsMade()).toEqual(['judge', 'judge', 'judge', 'judge'])
  })

  it('resumes: a second run starts nothing and adds no row', () => {
    const args = ['--variant', 'baseline', '--agents', 'oracle,null', '--cases', 'board-unplugged', '--approve-harness']
    expect(runEval(args).status).toBe(0)
    const rows = readFileSync(join(flow, 'baseline', 'results.jsonl'), 'utf8')
    const before = callsMade()

    const out = runEval(args)

    expect(out.status, out.stderr).toBe(0)
    expect(out.stderr).toContain('0 of 2 (id,rep) to run')
    expect(readFileSync(join(flow, 'baseline', 'results.jsonl'), 'utf8')).toBe(rows)
    expect(callsMade()).toEqual(before)
  })

  it('refuses a changed harness file until --approve-harness', () => {
    const harnessFile = join(tmp, 'grade.ts')
    writeFileSync(harnessFile, 'export const a = 1\n')
    writeState({ harness_paths: [harnessFile] })
    const args = ['--variant', 'baseline', '--agents', 'null', '--cases', 'add-version-flag']

    expect(runEval(args).status).toBe(2)
    expect(runEval([...args, '--approve-harness']).status).toBe(0)
    writeFileSync(harnessFile, 'export const a = 2\n')
    const changed = runEval(['--variant', 'v1', ...args.slice(2)])

    expect(changed.status).toBe(2)
    expect(changed.stderr).toMatch(/harness changed/)
    expect(existsSync(join(flow, 'v1', 'results.jsonl'))).toBe(false)
    expect(runEval(['--variant', 'v1', ...args.slice(2), '--approve-harness']).status).toBe(0)
  })
})

describe('run-eval.mjs with claude', () => {
  it('writes each trace as turns led by the staged skill, and no row or trace holds the run root or $HOME', () => {
    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'api-key-missing,add-version-flag', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    const rows = jsonl('baseline', 'results.jsonl')
    expect(rows.map((r) => r.prompt_id).sort()).toEqual(['add-version-flag.claude', 'api-key-missing.claude'])
    const need = rows.find((r) => r.prompt_id === 'api-key-missing.claude')
    expect(need).toMatchObject({ model: 'claude-opus-5-5', status: 'ok', meta: { skill: true }, rings: 1, tool_calls: 1 })
    // The judge's reason quoted the line, which named $HOME.
    expect(need.explanation.line_ok).toBe('judged Check ~')

    const traces = join(flow, 'baseline', 'traces')
    const trace = JSON.parse(readFileSync(join(traces, 'api-key-missing.claude_rep0.json'), 'utf8'))
    expect(trace[0]).toEqual({ role: 'system', content: DIAL_SKILL })
    for (const turn of trace) {
      expect(typeof turn.role).toBe('string')
      expect(typeof turn.content).toBe('string')
    }
    expect(trace.map((t: { content: string }) => t.content).join('\n')).toContain('Looked around in <run>/repo')
    const written = [readFileSync(join(flow, 'baseline', 'results.jsonl'), 'utf8'),
      ...readdirSync(traces).map((f) => readFileSync(join(traces, f), 'utf8'))].join('\n')
    expect(written).not.toContain(join(tmp, 'runs'))
    expect(written).not.toContain(home)
  })

  it('leads the trace with "no skill" under --no-skill', () => {
    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'add-version-flag', '--no-skill', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    expect(jsonl('baseline', 'results.jsonl')[0].meta.skill).toBe(false)
    const trace = JSON.parse(readFileSync(join(flow, 'baseline', 'traces', 'add-version-flag.claude_rep0.json'), 'utf8'))
    expect(trace[0]).toEqual({ role: 'system', content: 'no skill' })
  })

  it('marks a run whose transcript reaches the answer key invalid', () => {
    fakeClaude(agent('claude-opus-5-5', 'Read ../scenario.json'))

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'api-key-missing', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    expect(jsonl('baseline', 'results.jsonl')[0]).toMatchObject({ status: 'invalid', grade: {} })
  })

  it('fails a run served by another model as serving_substitution, keeping its model and usage', () => {
    fakeClaude(agent('claude-sonnet-4-5'))

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'add-version-flag', '--approve-harness'])

    expect(out.status).toBe(1)
    expect(jsonl('baseline', 'results.jsonl')).toEqual([])
    expect(jsonl('baseline', 'errors.jsonl')).toMatchObject([
      { prompt_id: 'add-version-flag.claude', failure_class: 'serving_substitution', model: 'claude-sonnet-4-5', usage: { input_tokens: 7, output_tokens: 3 } },
    ])
  })

  it('stops the pass at the account limit: exit 3, one account_limited error and no further case', () => {
    fakeClaude(LIMITED)

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'add-version-flag,api-key-missing,fix-off-by-one',
      '--concurrency', '1', '--approve-harness'])

    expect(out.status).toBe(3)
    expect(out.stderr).toContain('account limit reached: pass stopped; report it, do not switch accounts')
    expect(jsonl('baseline', 'errors.jsonl')).toMatchObject([{ failure_class: 'account_limited' }])
    expect(jsonl('baseline', 'errors.jsonl')).toHaveLength(1)
    expect(jsonl('baseline', 'results.jsonl')).toEqual([])
    expect(callsMade()).toEqual(['agent'])
  })
})
