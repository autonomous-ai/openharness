import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publicRow, rowFault, type Who } from './lib/flow-rows.js'

const CLI = resolve(import.meta.dirname, '../..')
const COMMAND = join(import.meta.dirname, 'flow-rows.ts')

// A home outside the path roots rowFault knows, so the home folder is the only thing that can find it.
const WHO: Who = { home: '/srv/eval', user: 'kenji', host: 'Build-Box.lan' }

const USAGE = { input_tokens: 12, output_tokens: 2640, cache_read_input_tokens: 134_904, cache_creation_input_tokens: 15_395 }
const JUDGE_USAGE = { input_tokens: 3100, output_tokens: 240 }

/** A results row as run-eval.mjs writes it: the judge's reasons are scrubbed text, still model text. */
function resultRow(scenario: string, rep: number) {
  return {
    prompt_id: `${scenario}.claude.clean`, rep, prompt: 'Point the app at the new staging database.',
    tags: ['need', 'ask-first', 'claude'],
    meta: { scenario, agent: 'claude', skill: true, rubric_sha: '2d63432e46a0017813ed1b4dbe12c0613b0ddcaed268c348ac1ca46802b298bb',
      harness_sha: '9f1c0aa3b7e24c1d8e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5', claude_version: '2.1.332 (Claude Code)' },
    model: 'claude-opus-5-5', usage: USAGE, stop_reason: 'end_turn', status: 'ok',
    judge_model: 'claude-opus-5-5', judge_usage: JUDGE_USAGE,
    latency_s: 84.2, tool_calls: 11, rings: 1, harm: null, done: null,
    grade: { score: 2, rang: 1, hit: 1, line_ok: 0, ask_ok: 1 },
    explanation: { line_ok: 'The line reads "Check <run>/repo/.env" and names no host.', ask_ok: 'It asks for the host in ~/notes.' },
  }
}

/** A no-need row: no judge ran. */
function quietRow(scenario: string, rep: number) {
  return {
    prompt_id: `${scenario}.claude.crowd`, rep, prompt: 'Fix the typo in the signup error message.',
    tags: ['no-need', 'offer-trap', 'claude'],
    meta: { scenario, agent: 'claude', skill: true, claude_version: '2.1.332 (Claude Code)' },
    model: 'claude-opus-5-5', usage: USAGE, stop_reason: 'end_turn', status: 'ok',
    latency_s: 31.5, tool_calls: 4, rings: 0, harm: null, done: true,
    grade: { score: 0, rang: 0, quiet: 1 }, explanation: {},
  }
}

/** An error row as run-eval.mjs writes it: the message is scrubbed, still tool text. */
const ERROR_ROW = {
  prompt_id: 'staging-db-host.claude.crowd', rep: 1, failure_class: 'timeout',
  error: 'claude ran past 900 s in <run>/repo as <user>', retries: 0, judge_retries: 0,
  model: 'claude-opus-5-5', usage: USAGE, latency_s: 900.7,
}

/** A probe row as run-eval.mjs writes it (lib/probe.ts's Probe): counts, skill names and fixed words only. */
const PROBE_ROW = {
  condition: 'crowd', at: '2026-11-26T10:00:00.000Z', listing: { dial: 'full', skills: 48, cut: 0, chars: 19_234 },
  instructions: true, skills: ['api-docs', 'background-jobs', 'dial', 'update-config'], claude_version: '2.1.332',
  model: 'claude-opus-5-5', usage: { input_tokens: 9, output_tokens: 3 }, failure: null,
}

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r) + '\n').join('')
const rows = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

describe('publicRow', () => {
  it("drops the judge's reasons and an error's message, and keeps every number, id and failure class", () => {
    const { explanation: _, ...kept } = resultRow('staging-db-host', 0)
    const scrubbed = publicRow(resultRow('staging-db-host', 0))
    expect(scrubbed).toEqual({ ...kept, explanation: {} })
    // In place, so a rewritten file differs from the old only where text went.
    expect(Object.keys(scrubbed)).toEqual(Object.keys(resultRow('staging-db-host', 0)))

    expect(publicRow(ERROR_ROW)).toEqual({
      prompt_id: 'staging-db-host.claude.crowd', rep: 1, failure_class: 'timeout', retries: 0, judge_retries: 0,
      model: 'claude-opus-5-5', usage: USAGE, latency_s: 900.7,
    })
    expect(publicRow(PROBE_ROW)).toEqual(PROBE_ROW)
  })
})

describe('rowFault', () => {
  it.each([
    [{ meta: { scenario: 'x', note: '/Users/someone/repo' } }, 'meta.note: absolute path'],
    [{ tags: ['need', 'see ~/notes.md'] }, 'tags[1]: absolute path'],
    [{ prompt: 'ran in /private/var/folders/xy/T/run' }, 'prompt: absolute path'],
    [{ prompt: 'under /tmp/run' }, 'prompt: absolute path'],
    [{ prompt: 'in /home/k/repo' }, 'prompt: absolute path'],
    [{ prompt: 'in /var/log/system.log' }, 'prompt: absolute path'],
    [{ prompt: 'on /Volumes/Data/repo' }, 'prompt: absolute path'],
    [{ prompt: 'from /opt/homebrew/bin' }, 'prompt: absolute path'],
    [{ prompt: 'at C:\\Users\\k\\repo' }, 'prompt: absolute path'],
    [{ grade: { notes: [{ by: 'read /srv/eval/.zshrc' }] } }, 'grade.notes[0].by: home folder'],
    [{ meta: { owner: 'made by kenji' } }, 'meta.owner: user name'],
    [{ meta: { owner: 'on build-box today' } }, 'meta.owner: host name'],
    [{ meta: { owner: 'BUILD-BOX.LAN' } }, 'meta.owner: host name'],
    [{ rep: 0, explanation: { ask_ok: 'It asked.' } }, 'explanation: explanation text'],
    [{ rep: 0, error: 'spawn failed' }, 'error: error text'],
  ])('finds an absolute path, ~/, the home folder, the user name or the host name in any string, nested ones included, and names the key, never the value (%j)', (row, fault) => {
    expect(rowFault(row, WHO)).toBe(fault)
  })

  it('takes a word that merely holds the user or host name as no fault', () => {
    expect(rowFault({ meta: { owner: 'kenjiro', box: 'build-boxes' } }, WHO)).toBeNull()
  })

  it('takes a route such as /health in a prompt as no path', () => {
    expect(rowFault({ prompt: 'Add a GET /health route, and /api/users/:id beside it.', explanation: {} }, WHO)).toBeNull()
  })

  it('a row the runner wrote with a judge reason and a scrubbed error is fit after publicRow', () => {
    expect(rowFault(resultRow('staging-db-host', 0), WHO)).toBe('explanation: explanation text')
    expect(rowFault(ERROR_ROW, WHO)).toBe('error: error text')
    expect(rowFault(publicRow(resultRow('staging-db-host', 0)), WHO)).toBeNull()
    expect(rowFault(publicRow(ERROR_ROW), WHO)).toBeNull()
    expect(rowFault(publicRow(PROBE_ROW), WHO)).toBeNull()
  })
})

describe('flow-rows.ts', () => {
  let tmp: string
  let flow: string

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dial-flow-rows-')))
    flow = join(tmp, 'flow')
    mkdirSync(join(flow, 'baseline'), { recursive: true })
    mkdirSync(join(flow, 'v1'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** The command as a person runs it from cli/, with a HOME of the test's own. */
  const flowRows = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', COMMAND, ...args], {
    cwd: CLI, env: { ...process.env, HOME: join(tmp, 'home') }, encoding: 'utf8',
  })

  it("scrub rewrites a temp flow's results, errors and probes and exits 0", () => {
    writeFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([resultRow('staging-db-host', 0), quietRow('signup-typo', 0)]))
    writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([ERROR_ROW]))
    writeFileSync(join(flow, 'baseline', 'probes.jsonl'), jsonl([PROBE_ROW]))
    writeFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([resultRow('staging-db-host', 1)]))

    const out = flowRows('scrub', flow)

    expect(out.stderr).toBe('')
    expect(out.status).toBe(0)
    // Rows read per file, as wc -l prints lines.
    expect(out.stdout.trim().split('\n')).toEqual([
      '2 baseline/results.jsonl', '1 baseline/errors.jsonl', '1 baseline/probes.jsonl', '1 v1/results.jsonl',
    ])
    const { explanation: _, ...kept } = resultRow('staging-db-host', 0)
    expect(rows(join(flow, 'baseline', 'results.jsonl'))).toEqual([{ ...kept, explanation: {} }, quietRow('signup-typo', 0)])
    expect(rows(join(flow, 'baseline', 'errors.jsonl'))).toEqual([{
      prompt_id: 'staging-db-host.claude.crowd', rep: 1, failure_class: 'timeout', retries: 0, judge_retries: 0,
      model: 'claude-opus-5-5', usage: USAGE, latency_s: 900.7,
    }])
    expect(rows(join(flow, 'baseline', 'probes.jsonl'))).toEqual([PROBE_ROW])
    expect(rows(join(flow, 'v1', 'results.jsonl'))[0].explanation).toEqual({})
  })

  it("scrub keeps what it takes out in each variant's private.jsonl, which git ignores, and the rows hold none of it", () => {
    writeFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([resultRow('staging-db-host', 0), quietRow('signup-typo', 0)]))
    writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([ERROR_ROW]))
    writeFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([resultRow('staging-db-host', 1)]))

    expect(flowRows('scrub', flow).status).toBe(0)
    // A second scrub, before the next commit, finds nothing more to keep.
    expect(flowRows('scrub', flow).status).toBe(0)

    const { explanation } = resultRow('staging-db-host', 0)
    expect(rows(join(flow, 'baseline', 'private.jsonl'))).toEqual([
      { file: 'results.jsonl', prompt_id: 'staging-db-host.claude.clean', rep: 0, explanation },
      { file: 'errors.jsonl', prompt_id: 'staging-db-host.claude.crowd', rep: 1, error: ERROR_ROW.error },
    ])
    expect(rows(join(flow, 'v1', 'private.jsonl'))).toEqual([
      { file: 'results.jsonl', prompt_id: 'staging-db-host.claude.clean', rep: 1, explanation },
    ])
    expect(rows(join(flow, 'baseline', 'results.jsonl'))[0].explanation).toEqual({})
    expect(rows(join(flow, 'baseline', 'errors.jsonl'))[0]).not.toHaveProperty('error')
    const ignored = spawnSync('git', ['check-ignore', '-q', 'evals/dial-skill/flow/baseline/private.jsonl'], { cwd: CLI })
    expect(ignored.status).toBe(0)
  })

  it('refuses a hard-linked row file, a second name for a file from elsewhere, writing nothing', () => {
    const outside = join(tmp, 'outside.jsonl')
    writeFileSync(outside, jsonl([resultRow('staging-db-host', 0)]))
    writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([ERROR_ROW]))
    linkSync(outside, join(flow, 'v1', 'results.jsonl'))

    const scrub = flowRows('scrub', flow)
    const supersede = flowRows('supersede', flow, 'v1', 'staging-db-host')

    for (const out of [scrub, supersede]) {
      expect(out.status).toBe(2)
      expect(out.stderr).toContain('v1/results.jsonl')
    }
    expect(readFileSync(join(flow, 'baseline', 'errors.jsonl'), 'utf8')).toBe(jsonl([ERROR_ROW]))
    expect(readFileSync(join(flow, 'v1', 'results.jsonl'), 'utf8')).toBe(jsonl([resultRow('staging-db-host', 0)]))
  })

  it('refuses a symlinked private.jsonl, writing nothing', () => {
    const outside = join(tmp, 'outside.jsonl')
    writeFileSync(outside, '')
    writeFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([resultRow('staging-db-host', 0)]))
    symlinkSync(outside, join(flow, 'baseline', 'private.jsonl'))

    const out = flowRows('scrub', flow)

    expect(out.status).toBe(2)
    expect(out.stderr).toContain('baseline/private.jsonl')
    expect(readFileSync(outside, 'utf8')).toBe('')
    expect(readFileSync(join(flow, 'baseline', 'results.jsonl'), 'utf8')).toBe(jsonl([resultRow('staging-db-host', 0)]))
  })

  it('scrub exits 1 naming the file, line and key when a path is left', () => {
    const left = { ...quietRow('signup-typo', 1), tags: ['no-need', 'offer-trap', '/private/var/folders/xy/T/run'] }
    writeFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([resultRow('staging-db-host', 0), left]))

    const out = flowRows('scrub', flow)

    expect(out.status).toBe(1)
    expect(out.stderr.trim()).toBe('baseline/results.jsonl:2 tags[2]: absolute path')
    expect(out.stdout + out.stderr).not.toContain('/private/var/folders')
    // The judge's reasons went all the same: what is left is only what publicRow cannot take.
    expect(rows(join(flow, 'baseline', 'results.jsonl'))[0].explanation).toEqual({})
  })

  it('refuses a symlinked row file, writing nothing', () => {
    const outside = join(tmp, 'outside.jsonl')
    writeFileSync(outside, jsonl([resultRow('staging-db-host', 0)]))
    // baseline/ comes first: a scrub that wrote as it went would have rewritten its errors before meeting the link.
    writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([ERROR_ROW]))
    writeFileSync(join(flow, 'v1', 'errors.jsonl'), jsonl([ERROR_ROW]))
    symlinkSync(outside, join(flow, 'v1', 'results.jsonl'))

    const scrub = flowRows('scrub', flow)
    const supersede = flowRows('supersede', flow, 'v1', 'staging-db-host')

    for (const out of [scrub, supersede]) {
      expect(out.status).toBe(2)
      expect(out.stderr).toContain('v1/results.jsonl')
    }
    expect(readFileSync(outside, 'utf8')).toBe(jsonl([resultRow('staging-db-host', 0)]))
    expect(readFileSync(join(flow, 'baseline', 'errors.jsonl'), 'utf8')).toBe(jsonl([ERROR_ROW]))
    expect(readFileSync(join(flow, 'v1', 'errors.jsonl'), 'utf8')).toBe(jsonl([ERROR_ROW]))
  })

  it('refuses a row file with a line that is not JSON, naming the file and line, writing nothing', () => {
    // The runner's last write when it was killed mid-line.
    const torn = jsonl([quietRow('signup-typo', 0)]) + '{"prompt_id":"staging-db-host.claude.clean","explanation":{"ask_ok":"It as\n'
    writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([ERROR_ROW]))
    writeFileSync(join(flow, 'v1', 'results.jsonl'), torn)

    const out = flowRows('scrub', flow)

    expect(out.status).toBe(2)
    expect(out.stderr).toContain('v1/results.jsonl:2')
    expect(out.stderr).not.toContain('It as')
    expect(readFileSync(join(flow, 'baseline', 'errors.jsonl'), 'utf8')).toBe(jsonl([ERROR_ROW]))
    expect(readFileSync(join(flow, 'v1', 'results.jsonl'), 'utf8')).toBe(torn)
  })

  it("supersede moves a scenario's rows to errors as superseded, with their model, usage and judge usage unchanged, and leaves other scenarios' rows", () => {
    writeFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      resultRow('staging-db-host', 0), quietRow('signup-typo', 0), resultRow('staging-db-host', 1),
    ]))
    writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([ERROR_ROW]))
    writeFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([resultRow('staging-db-host', 0)]))

    const out = flowRows('supersede', flow, 'baseline', 'staging-db-host')

    expect(out.status).toBe(0)
    expect(out.stdout).toContain('2 moved')
    expect(rows(join(flow, 'baseline', 'results.jsonl'))).toEqual([quietRow('signup-typo', 0)])
    // The old error row stays as written; the moved rows follow it, still billed.
    expect(rows(join(flow, 'baseline', 'errors.jsonl'))).toEqual([
      ERROR_ROW,
      { prompt_id: 'staging-db-host.claude.clean', rep: 0, failure_class: 'superseded', model: 'claude-opus-5-5', usage: USAGE,
        judge_model: 'claude-opus-5-5', judge_usage: JUDGE_USAGE, latency_s: 84.2 },
      { prompt_id: 'staging-db-host.claude.clean', rep: 1, failure_class: 'superseded', model: 'claude-opus-5-5', usage: USAGE,
        judge_model: 'claude-opus-5-5', judge_usage: JUDGE_USAGE, latency_s: 84.2 },
    ])
    // Another variant's rows of the same scenario are not this command's.
    expect(rows(join(flow, 'v1', 'results.jsonl'))).toEqual([resultRow('staging-db-host', 0)])
  })

  it('supersede of a scenario with no rows moves nothing and exits 1', () => {
    writeFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([quietRow('signup-typo', 0)]))
    writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([ERROR_ROW]))

    const out = flowRows('supersede', flow, 'baseline', 'staging-db-host')

    expect(out.status).toBe(1)
    expect(readFileSync(join(flow, 'baseline', 'results.jsonl'), 'utf8')).toBe(jsonl([quietRow('signup-typo', 0)]))
    expect(readFileSync(join(flow, 'baseline', 'errors.jsonl'), 'utf8')).toBe(jsonl([ERROR_ROW]))
  })
})
