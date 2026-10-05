/**
 * More of pair.jsonc (pair/rules.ts): the JSONC reader's strings, escapes and comments; every way a file
 * or a rule is malformed; a rule's project against a harness with no folder; a rule whose choice is
 * neither a yes nor a no; the runner's log; and a settings path that is not a readable file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_PAIR_CONFIG, matchRule, PairConfigFile, pairConfigPath, parseJsonc, parseLearnConfig, parsePairConfig, ruleRunner, type PairConfig } from './rules.js'
import type { PairQuestion } from './protocol.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pair-rules-more-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

const question = (patch: Partial<PairQuestion> = {}): PairQuestion => ({
  requestId: 'q1', text: 'Approve Bash command: npm test', options: ['1. Yes', '2. Maybe later', '3. No'],
  multi: false, deny: false, allow: true, permission: true, since: 0, ...patch,
})
const config = (rules: object[]): PairConfig => parsePairConfig(JSON.stringify({ rules }), '/home/me')

describe('the JSONC reader', () => {
  it('keeps comment markers, escaped quotes and commas inside strings', () => {
    expect(parseJsonc('{"a": "// not a comment", "b": "/* nor this */", "c": "say \\"hi\\", then go",}')).toEqual({
      a: '// not a comment', b: '/* nor this */', c: 'say "hi", then go',
    })
    expect(parseJsonc('{"p": "C:\\\\dir\\\\", "q": [1, 2, ], }')).toEqual({ p: 'C:\\dir\\', q: [1, 2] })
    expect(parseJsonc('[1, 2 /* two */, // three\n 3,\n]')).toEqual([1, 2, 3])
    // A backslash that ends the text inside a string escapes nothing: the text is not JSON.
    expect(() => parseJsonc('"a\\')).toThrow()
    expect(() => parseJsonc('["a\\')).toThrow()
  })

  it('an unterminated block comment swallows the rest, and what is left must still be JSON', () => {
    expect(() => parseJsonc('{"a": 1} /* open')).not.toThrow()
    expect(parseJsonc('{"a": 1} /* open')).toEqual({ a: 1 })
    expect(() => parseJsonc('{"a": /* open')).toThrow()
  })
})

describe('a malformed file or rule is read as nothing', () => {
  it.each([
    ['[]', 'pair.jsonc must be an object'],
    ['null', 'pair.jsonc must be an object'],
    ['3', 'pair.jsonc must be an object'],
    ['{"rules": ["npm test"]}', 'rule 1: "question" is a pattern and is required'],
    ['{"rules": [null]}', 'rule 1: "question" is a pattern and is required'],
    ['{"rules": [{"question": "  ", "choice": "Yes"}]}', 'rule 1: "question" is a pattern and is required'],
    ['{"rules": [{"question": "x", "choice": 1}]}', 'rule 1: "choice" is required'],
    ['{"rules": [{"question": "x", "choice": "Always allow"}]}', 'rule 1: a rule never chooses an option that answers for more than this once'],
    ['{"rules": [{"question": "(", "choice": "Yes"}]}', 'rule 1: "question" is not a valid pattern'],
  ])('%s', (text, error) => {
    expect(parsePairConfig(text, '/home/me')).toEqual({ ...EMPTY_PAIR_CONFIG, error })
  })

  it('names default to the rule\'s place, and are cut to 60 characters', () => {
    const c = config([{ question: 'x', choice: 'Yes', name: '  ' }, { question: 'y', choice: 'No', name: 'n'.repeat(80), engine: ' Claude ', harness: 'api-*', project: '~/code' }])
    expect(c.rules.map((r) => r.name)).toEqual(['rule 1', 'n'.repeat(60)])
    expect(c.rules[1]).toMatchObject({ engine: 'claude', project: '/home/me/code' })
    expect(c.rules[1]!.harness!.test('API-web')).toBe(true)
    expect(c.rules[1]!.harness!.test('api')).toBe(false)
  })

  it('learn: only strings name folders, duplicates collapse, ~ is the home folder', () => {
    expect(parseLearnConfig(['borrow'], '/h')).toEqual({ borrow: false, export: [], agentsMd: [] })
    expect(parseLearnConfig({ borrow: 'yes', export: 'claude', agentsMd: '/x' }, '/h')).toEqual({ borrow: false, export: [], agentsMd: [] })
    expect(parseLearnConfig({ agentsMd: ['~', '~/a', '/h/a', 7, ' ', '~x'] }, '/h').agentsMd).toEqual(['/h', '/h/a', `${process.cwd()}/~x`])
  })

  it('XDG_CONFIG_HOME counts only when absolute', () => {
    expect(pairConfigPath({ XDG_CONFIG_HOME: 'relative' }, '/home/me')).toBe('/home/me/.config/harness/pair.jsonc')
    expect(pairConfigPath({ XDG_CONFIG_HOME: '' }, '/home/me')).toBe('/home/me/.config/harness/pair.jsonc')
  })
})

describe('matching', () => {
  it('a rule scoped to a project never matches a harness with no folder', () => {
    const c = config([{ question: 'npm', choice: 'Yes', project: '/w/api' }])
    expect(matchRule(c, { name: 'api', engine: 'claude', cwd: null }, question())).toBeNull()
    expect(matchRule(c, { name: 'api', engine: 'claude' }, question())).toBeNull()
    expect(matchRule(c, { name: 'api', engine: 'claude', cwd: '/w/api-old' }, question())).toBeNull()
    expect(matchRule(c, { name: 'api', engine: 'claude', cwd: '/w/api/sub/../pkg' }, question())).toMatchObject({ option: '1. Yes' })
  })

  it('a choice that is neither a yes nor a no is skipped, and the next rule gets its turn', () => {
    const c = config([{ name: 'odd', question: 'npm', choice: 'Maybe later' }, { name: 'no', question: 'npm', choice: 'No' }])
    expect(matchRule(c, { name: 'api', engine: 'claude' }, question())).toMatchObject({ rule: { name: 'no' }, option: '3. No' })
  })

  it('a choice the dialog does not offer is skipped', () => {
    const c = config([{ name: 'gone', question: 'npm', choice: 'Proceed' }])
    expect(matchRule(c, { name: 'api', engine: 'claude' }, question())).toBeNull()
  })

  it('never on a multi-select question', () => {
    const c = config([{ question: 'npm', choice: 'Yes' }])
    expect(matchRule(c, { name: 'api', engine: 'claude' }, question({ multi: true }))).toBeNull()
  })
})

describe('the runner', () => {
  const subject = { name: 'api', engine: 'claude', cwd: '/w/api' }

  it('logs what it answered, and what the owner refused', async () => {
    const log = vi.fn()
    const answer = vi.fn(async () => ({ ok: true }))
    const run = ruleRunner({ active: () => true, config: () => config([{ name: 'tests', question: 'npm', choice: 'Yes' }]),
      question: () => question(), subject: () => subject, answer, log })
    expect(await run('abcdefghijkl', 'q1')).toEqual({ rule: 'tests', option: '1. Yes', ok: true })
    expect(answer).toHaveBeenCalledWith({ agentId: 'abcdefghijkl', requestId: 'q1', choice: '1. Yes' }, 'rule', 'rule "tests"')
    expect(log).toHaveBeenLastCalledWith('[pair] rule "tests" · abcdefgh · answered "1. Yes"')
    answer.mockResolvedValueOnce({ ok: false, error: 'STALE_QUESTION' } as never)
    expect(await run('abcdefghijkl', 'q1')).toEqual({ rule: 'tests', option: '1. Yes', ok: false, error: 'STALE_QUESTION' })
    expect(log).toHaveBeenLastCalledWith('[pair] rule "tests" · abcdefgh · refused STALE_QUESTION')
  })

  it('does nothing off the dial, for another question, for an unknown harness, or with no matching rule — and logs nothing without a logger', async () => {
    const answer = vi.fn(async () => ({ ok: true }))
    const base = { config: () => config([{ question: 'npm', choice: 'Yes' }]), question: () => question(), subject: () => subject, answer }
    expect(await ruleRunner({ ...base, active: () => false })('a', 'q1')).toBeNull()
    expect(await ruleRunner({ ...base, active: () => true })('a', 'q2')).toBeNull()
    expect(await ruleRunner({ ...base, active: () => true, question: () => null })('a', 'q1')).toBeNull()
    expect(await ruleRunner({ ...base, active: () => true, subject: () => null })('a', 'q1')).toBeNull()
    expect(await ruleRunner({ ...base, active: () => true, config: () => EMPTY_PAIR_CONFIG })('a', 'q1')).toBeNull()
    expect(answer).not.toHaveBeenCalled()
    expect(await ruleRunner({ ...base, active: () => true })('a', 'q1')).toMatchObject({ ok: true })
  })
})

describe('the settings file on disk', () => {
  it('a path that is a folder is read as no rules, with one warning until it changes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = join(dir, 'pair.jsonc')
    mkdirSync(path)
    const file = new PairConfigFile(path, '/home/me')
    const first = file.load()
    expect(first.text).toBeNull()
    expect(first.config.rules).toEqual([])
    expect(first.config.error).toMatch(/EISDIR|directory/i)
    expect(file.get()).toBe(first.config)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('no rules until it is fixed')
  })
})
