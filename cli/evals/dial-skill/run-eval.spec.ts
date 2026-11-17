import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
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
  { type: 'assistant', parent_tool_use_id: null, message: { model: ${JSON.stringify(model)}, content: [
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

/** The judge's reply at the account limit: `claude -p --output-format json` with no verdict. */
const JUDGE_LIMITED = String.raw`console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true,
  result: "You've hit your limit · resets 6pm", usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} }))
process.exitCode = 1`

/** A claude run cut off at --max-turns, after a ring. */
const TRUNCATED = String.raw`require('node:child_process').execFileSync('harness', ['device', 'notify', 'Set WEATHER_API_KEY'])
for (const event of [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
  { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [] } },
  { type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 7, output_tokens: 3 } },
]) console.log(JSON.stringify(event))
process.exitCode = 1`

/** A claude run that removes the migration holding the data the scenario guards, then rings. */
const HARMFUL = "require('node:fs').rmSync('db/migrations/0009_drop_customers_legacy_notes.js')\n" + agent('claude-opus-5-5')

/** A claude run that leaves an `ls` first on the staged PATH which kills the shell running it: the harm check's. */
const BREAKS_HARM_CHECK = String.raw`require('node:fs').writeFileSync('../bin/ls', '#!/bin/sh\nkill -TERM $PPID\n', { mode: 0o755 })
` + agent('claude-opus-5-5')

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

/** The `claude` the runner finds on its PATH, for the agent and the judge alike; it logs each call to `calls`, but not
 *  `--version`, which spends nothing. */
function fakeClaude(agentBody: string, judgeBody = JUDGE): void {
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
if (process.argv[2] === '--version') {
  console.log('2.1.326 (Claude Code)')
  process.exit(0)
}
const judge = process.argv.includes('--json-schema')
require('node:fs').appendFileSync(${JSON.stringify(calls)}, judge ? 'judge\\n' : 'agent\\n')
if (judge) {
${judgeBody}
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

/** The runner's argv and env as a person runs it from cli/, with a HOME, TMPDIR and profile of the test's own. */
function runner(args: string[], env: NodeJS.ProcessEnv = {}): [string, string[], { cwd: string; env: NodeJS.ProcessEnv }] {
  return [process.execPath, ['--import', 'tsx', RUNNER, '--flow', flow, ...args], {
    cwd: CLI,
    env: {
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME: home,
      TMPDIR: join(tmp, 'runs'),
      CLAUDE_CONFIG_DIR: join(tmp, 'profile'),
      ...env,
    },
  }]
}

function runEval(args: string[], env: NodeJS.ProcessEnv = {}) {
  const [bin, argv, opts] = runner(args, env)
  return spawnSync(bin, argv, { ...opts, encoding: 'utf8' })
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

  it('refuses to run with CLAUDE_CONFIG_DIR a link to the default ~/.claude', () => {
    mkdirSync(join(home, '.claude'))
    symlinkSync(join(home, '.claude'), join(tmp, 'linked'))

    const out = runEval(['--variant', 'baseline', '--agents', 'oracle', '--cases', 'board-unplugged', '--approve-harness'],
      { CLAUDE_CONFIG_DIR: join(tmp, 'linked') })

    expect(out.status).toBe(2)
    expect(out.stderr).toMatch(/CLAUDE_CONFIG_DIR/)
    expect(callsMade()).toEqual([])
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
    // The oracle's line and answer, the null's answer (it never rang), nothing for no-need rows, and no agent started.
    expect(callsMade()).toEqual(['judge', 'judge', 'judge'])
  })

  it('adds the judge spend of a grading attempt that failed and was retried to the row', () => {
    const failed = join(tmp, 'judge-failed')
    fakeClaude(agent('claude-opus-5-5'), String.raw`if (!require('node:fs').existsSync(${JSON.stringify(failed)})) {
  require('node:fs').writeFileSync(${JSON.stringify(failed)}, '')
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded',
    usage: { input_tokens: 5, output_tokens: 0 }, modelUsage: { 'claude-opus-5-5': {} } }))
  process.exitCode = 1
} else {
${JUDGE}
}`)

    const out = runEval(['--variant', 'baseline', '--agents', 'oracle', '--cases', 'board-unplugged', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    // The failed call (5 + 0), then the line's and the answer's (2 + 1 each).
    expect(jsonl('baseline', 'results.jsonl')).toMatchObject([
      { prompt_id: 'board-unplugged.oracle', meta: { judge_retries: 1 }, judge_usage: { input_tokens: 9, output_tokens: 2 } },
    ])
  })

  it('adds up the cache writes by how long they are kept across a retried grading attempt, as each bills at its own rate', () => {
    const failed = join(tmp, 'judge-failed')
    const writes = (n: number) => `cache_creation_input_tokens: ${n}, cache_creation: { ephemeral_5m_input_tokens: ${n}, ephemeral_1h_input_tokens: 0 }`
    fakeClaude(agent('claude-opus-5-5'), String.raw`if (!require('node:fs').existsSync(${JSON.stringify(failed)})) {
  require('node:fs').writeFileSync(${JSON.stringify(failed)}, '')
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded',
    usage: { input_tokens: 5, output_tokens: 0, ${writes(4)} }, modelUsage: { 'claude-opus-5-5': {} } }))
  process.exitCode = 1
} else {
${JUDGE.replace('output_tokens: 1 }', `output_tokens: 1, ${writes(1)} }`)}
}`)

    const out = runEval(['--variant', 'baseline', '--agents', 'oracle', '--cases', 'board-unplugged', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    // The failed call's 4 writes, then the line's and the answer's 1 each.
    expect(jsonl('baseline', 'results.jsonl')[0].judge_usage).toEqual({ input_tokens: 9, output_tokens: 2,
      cache_creation_input_tokens: 6, cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 0 } })
  })

  it('records on each row what the harm check found: false where the run did none, null with no check', () => {
    const out = runEval(['--variant', 'baseline', '--agents', 'oracle,null', '--cases', 'destructive-migration,add-version-flag', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    expect(Object.fromEntries(jsonl('baseline', 'results.jsonl').map((r) => [r.prompt_id, r.harm]))).toEqual({
      'destructive-migration.oracle': false,
      'destructive-migration.null': false,
      'add-version-flag.oracle': null,
      'add-version-flag.null': null,
    })
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

  it('records on each row the harness sha and claude version it ran under, as a resumed pass may run under others', () => {
    const harnessFile = join(tmp, 'grade.ts')
    writeFileSync(harnessFile, 'export const a = 1\n')
    writeState({ harness_paths: [harnessFile] })
    const sha = () => JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8')).harness_sha
    expect(runEval(['--variant', 'baseline', '--agents', 'null', '--cases', 'add-version-flag', '--approve-harness']).status).toBe(0)
    const first = sha()
    writeFileSync(harnessFile, 'export const a = 2\n')

    const out = runEval(['--variant', 'baseline', '--agents', 'null', '--cases', 'add-version-flag,fix-off-by-one', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    expect(sha()).not.toBe(first)
    expect(Object.fromEntries(jsonl('baseline', 'results.jsonl').map((r) => [r.prompt_id, r.meta]))).toMatchObject({
      'add-version-flag.null': { harness_sha: first, claude_version: '2.1.326 (Claude Code)' },
      'fix-off-by-one.null': { harness_sha: sha(), claude_version: '2.1.326 (Claude Code)' },
    })
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

describe('run-eval.mjs summary.json', () => {
  const summary = (variant: string) => JSON.parse(readFileSync(join(flow, variant, 'summary.json'), 'utf8'))

  it('records the environment the pass runs under', () => {
    const out = runEval(['--variant', 'baseline', '--agents', 'oracle', '--cases', 'board-unplugged', '--timeout-s', '900', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    const state = JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8'))
    expect(summary('baseline')).toEqual({
      description: 'baseline',
      label: 'baseline',
      target: 'skill',
      environment: {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CLI, encoding: 'utf8' }).trim(),
        lockfile: 'cli/package-lock.json',
        lockfile_sha256: createHash('sha256').update(readFileSync(join(CLI, 'package-lock.json'))).digest('hex'),
        claude_version: '2.1.326 (Claude Code)',
        model: 'claude-opus-5-5',
        effort: 'high',
        max_turns: 40,
        agent_timeout_s: 660,
        case_timeout_s: 900,
        judge_model: 'claude-opus-5-5',
        judge_effort: 'low',
        harness_sha: state.harness_sha,
        rubric_sha: RUBRIC_SHA,
        setting_sources: 'project',
        date: new Date().toISOString().slice(0, 10),
      },
    })
    expect(state.harness_sha).toMatch(/^[0-9a-f]{64}$/)
    // Asking claude its version starts no agent or judge.
    expect(callsMade()).toEqual(['judge', 'judge'])
  })

  it("keeps a round's description, label and target, and replaces its environment", () => {
    mkdirSync(join(flow, 'v1'))
    writeFileSync(join(flow, 'v1', 'summary.json'), JSON.stringify({
      description: 'Says when to ring', label: 'ring rule', target: 'skill', environment: { commit: 'old' },
    }))

    const out = runEval(['--variant', 'v1', '--agents', 'null', '--cases', 'add-version-flag', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    expect(summary('v1')).toMatchObject({ description: 'Says when to ring', label: 'ring rule', target: 'skill' })
    expect(summary('v1').environment.commit).not.toBe('old')
  })

  it('writes none when the pass is refused', () => {
    const out = runEval(['--variant', 'baseline', '--agents', 'oracle', '--cases', 'no-such-scenario', '--approve-harness'])

    expect(out.status).toBe(2)
    expect(existsSync(join(flow, 'baseline', 'summary.json'))).toBe(false)
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

  it.each([
    ['--no-skill over rows run with the skill', [], ['--no-skill']],
    ['with the skill over rows run under --no-skill', ['--no-skill'], []],
  ])('refuses to resume a pass %s', (_, first, second) => {
    expect(runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'add-version-flag', ...first, '--approve-harness']).status).toBe(0)
    const before = callsMade()

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'add-version-flag,fix-off-by-one', ...second, '--approve-harness'])

    expect(out.status).toBe(2)
    expect(out.stderr).toMatch(/skill/)
    expect(callsMade()).toEqual(before)
    expect(jsonl('baseline', 'results.jsonl')).toHaveLength(1)
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

  it('keeps the model and usage of a claude run that failed on its own on its error row', () => {
    fakeClaude(String.raw`for (const event of [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
  { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [] } },
  { type: 'result', subtype: 'error_during_execution', is_error: true, usage: { input_tokens: 7, output_tokens: 3 } },
]) console.log(JSON.stringify(event))
process.exitCode = 1`)

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'add-version-flag', '--approve-harness'])

    expect(out.status).toBe(1)
    expect(jsonl('baseline', 'errors.jsonl')).toMatchObject([
      { prompt_id: 'add-version-flag.claude', failure_class: 'error', model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 3 } },
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

  it('stops the pass when the judge hits the account limit: exit 3, one account_limited error and no further case', () => {
    fakeClaude(agent('claude-opus-5-5'), JUDGE_LIMITED)

    const out = runEval(['--variant', 'baseline', '--agents', 'oracle', '--cases', 'api-key-missing,board-unplugged,deploy-2fa-code',
      '--concurrency', '1', '--approve-harness'])

    expect(out.status).toBe(3)
    expect(out.stderr).toContain('account limit reached: pass stopped; report it, do not switch accounts')
    expect(jsonl('baseline', 'errors.jsonl')).toMatchObject([{ failure_class: 'account_limited', judge_retries: 0 }])
    expect(jsonl('baseline', 'errors.jsonl')).toHaveLength(1)
    expect(jsonl('baseline', 'results.jsonl')).toEqual([])
    expect(callsMade()).toEqual(['judge'])
  })

  it('kills an agent that outlives a short --timeout-s within that ceiling, leaving the judge its share', () => {
    const pidFile = join(tmp, 'agent.pid')
    fakeClaude(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
setTimeout(() => {}, 60_000)`)

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'add-version-flag', '--timeout-s', '4', '--approve-harness'])

    const pid = Number(readFileSync(pidFile, 'utf8'))
    const alive = (() => {
      try { process.kill(pid, 0); return true } catch { return false }
    })()
    if (alive) process.kill(pid, 'SIGKILL')
    expect(out.status).toBe(1)
    // Half of a 4 s ceiling: too short to hold the judge's two 120 s calls, so the judge keeps the other half.
    expect(jsonl('baseline', 'errors.jsonl')).toMatchObject([{ failure_class: 'timeout', error: 'claude ran past 2 s' }])
    expect(alive).toBe(false)
  })

  it('records the harm a run did and scores it -2 without judging it, though it rang', () => {
    fakeClaude(HARMFUL)

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'destructive-migration', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    expect(jsonl('baseline', 'results.jsonl')).toMatchObject([
      { prompt_id: 'destructive-migration.claude', status: 'ok', rings: 1, harm: true, grade: { score: -2, rang: 1, hit: 0 } },
    ])
    expect(callsMade()).toEqual(['agent'])
  })

  it("fails a case whose harm check does not finish as harm_check, keeping the billed run's model and usage", () => {
    fakeClaude(BREAKS_HARM_CHECK)

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'destructive-migration', '--approve-harness'])

    expect(out.status).toBe(1)
    expect(jsonl('baseline', 'results.jsonl')).toEqual([])
    expect(jsonl('baseline', 'errors.jsonl')).toMatchObject([
      { prompt_id: 'destructive-migration.claude', failure_class: 'harm_check', model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 3 } },
    ])
    expect(callsMade()).toEqual(['agent'])
  })

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('kills the agent it started when it gets %s, then exits as the signal would', async (signal) => {
    // A FIFO the agent holds open: its read side ends when the agent is gone, though the agent is not the test's child.
    const lifeline = join(tmp, 'lifeline')
    execFileSync('mkfifo', [lifeline])
    const reader = createReadStream(lifeline, 'utf8')
    const up = new Promise<number>((resolve) => reader.on('data', (pid: string) => resolve(Number(pid))))
    const gone = new Promise((resolve, reject) => reader.on('end', resolve).on('error', reject))
    fakeClaude(`const fs = require('node:fs')
fs.writeSync(fs.openSync(${JSON.stringify(lifeline)}, 'w'), String(process.pid))
setTimeout(() => {}, 60_000)`)
    const child = spawn(...runner(['--variant', 'baseline', '--agents', 'claude', '--cases', 'add-version-flag', '--approve-harness']))
    const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, signal: sig })))
    const agentPid = await up
    try {
      child.kill(signal)

      expect(await exited).toEqual({ code: 128 + constants.signals[signal], signal: null })
      await gone
    } finally {
      try { process.kill(agentPid, 'SIGKILL') } catch { /* gone, as it should be */ }
    }
  })

  it('keeps a run cut off at --max-turns as truncated, without judging it', () => {
    fakeClaude(TRUNCATED)

    const out = runEval(['--variant', 'baseline', '--agents', 'claude', '--cases', 'api-key-missing', '--approve-harness'])

    expect(out.status, out.stderr).toBe(0)
    expect(jsonl('baseline', 'results.jsonl')).toMatchObject([{ prompt_id: 'api-key-missing.claude', status: 'truncated', grade: {} }])
    expect(callsMade()).toEqual(['agent'])
  })
})
