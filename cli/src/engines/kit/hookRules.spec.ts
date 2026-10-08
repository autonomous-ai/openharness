import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCodexRolloutMeta } from '../codex/rollout.js'
import { hooks as codex } from '../codex/hookContract.js'
import { isChildSession, knownTranscript } from './hookRules.js'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'hook-rules-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const meta = (payload: unknown, type = 'session_meta'): string => JSON.stringify({ type, payload })
/** First records as Codex writes them, and every way one can fail to be a child's. */
const FIRST_RECORDS: Array<[string, string]> = [
  ['a spawned child', meta({ id: 'c', source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } } }) + '\n'],
  ['a review child', meta({ id: 'c', source: { subagent: 'review' } }) + '\n'],
  ['a child marked false', meta({ source: { subagent: false } }) + '\n'],
  ['a child marked 0', meta({ source: { subagent: 0 } }) + '\n'],
  ['a child marked by an empty list', meta({ source: { subagent: [] } }) + '\n'],
  ['a null child field', meta({ source: { subagent: null } }) + '\n'],
  ['a main session', meta({ id: 'p', source: 'cli' }) + '\n'],
  ['a source that is a list', meta({ source: [{ subagent: 'x' }] }) + '\n'],
  ['a payload that is a list', meta([{ source: { subagent: 'x' } }]) + '\n'],
  ['a payload that is text', meta('subagent') + '\n'],
  ['no payload', JSON.stringify({ type: 'session_meta' }) + '\n'],
  ['another first record', meta({ source: { subagent: 'x' } }, 'response_item') + '\n'],
  ['a record that is a list', '[{"type":"session_meta"}]\n'],
  ['a record that is null', 'null\n'],
  ['blank lines before the record', '\n  \n\t\n' + meta({ source: { subagent: 'x' } }) + '\n'],
  ['carriage returns', meta({ source: { subagent: 'x' } }) + '\r\n' + meta({}) + '\r\n'],
  ['a child as the second record', meta({ source: 'cli' }) + '\n' + meta({ source: { subagent: 'x' } }) + '\n'],
  ['no newline after the record', meta({ source: { subagent: 'x' } })],
  ['malformed JSON', '{"type":"session_meta",\n'],
  ['an empty file', ''],
  ['only blank lines', '\n\n'],
  ['a record past the bound', meta({ source: { subagent: 'x' }, pad: 'x'.repeat(130 * 1024) }) + '\n'],
  ['a record just inside the bound', meta({ source: { subagent: 'x' }, pad: 'x'.repeat(127 * 1024) }) + '\n'],
  ['a __proto__ step', '{"type":"session_meta","payload":{"__proto__":{"subagent":"x"},"source":{}}}\n'],
  ['unicode before the field', meta({ note: 'é✓🎉', source: { subagent: 'x' } }) + '\n'],
]

describe('Codex\'s declared child rule', () => {
  // `registry` still reads rollouts with readCodexRolloutMeta, at load, to repair a parent a child's hook
  // overwrote: the rule evaluated on the hook path must say what that reader says about every first record.
  it.each(FIRST_RECORDS)('agrees with the rollout reader on %s', (name, text) => {
    const file = join(root, `${name.replace(/\W+/g, '-')}.jsonl`)
    writeFileSync(file, text)
    expect(isChildSession(file, codex.children!)).toBe(readCodexRolloutMeta(file)?.isSubagent === true)
  })

  it('finds the children it should', () => {
    const verdict = (text: string): boolean => {
      const file = join(root, 'verdict.jsonl')
      writeFileSync(file, text)
      return isChildSession(file, codex.children!)
    }
    expect(FIRST_RECORDS.filter(([, text]) => verdict(text)).map(([name]) => name)).toEqual([
      'a spawned child', 'a review child', 'a child marked false', 'a child marked 0', 'a child marked by an empty list',
      'blank lines before the record', 'carriage returns', 'no newline after the record', 'a record just inside the bound',
      'unicode before the field',
    ])
  })

  it('admits what it cannot read: a missing file, a folder, a dangling link', () => {
    mkdirSync(join(root, 'folder.jsonl'))
    symlinkSync(join(root, 'nowhere.jsonl'), join(root, 'dangling.jsonl'))
    for (const file of [join(root, 'missing.jsonl'), join(root, 'folder.jsonl'), join(root, 'dangling.jsonl')]) {
      expect(isChildSession(file, codex.children!)).toBe(false)
      expect(readCodexRolloutMeta(file)).toBeNull()
    }
  })

  it('reads any declared path, needing an object at every step before the field', () => {
    const file = join(root, 'other.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'start', a: { b: { c: 'yes' } } }) + '\n')
    const rule = (child: string[], type = 'start') => isChildSession(file, { type, child, reason: 'test' })
    expect(rule(['a', 'b', 'c'])).toBe(true)
    expect(rule(['a', 'b', 'c'], 'session_meta')).toBe(false)
    expect(rule(['a', 'b', 'c', 'd'])).toBe(false)
    expect(rule(['a', 'x'])).toBe(false)
    expect(rule([])).toBe(true)
  })
})

describe('the declared session file naming', () => {
  const suffix = { suffix: '.jsonl' }
  it('takes the row\'s own file for an announcement that never appears, and only for this conversation', () => {
    const sessionId = '73f090ca-0000-4000-8000-000000000000'
    const known = join(root, 'project', `${sessionId}.jsonl`)
    mkdirSync(join(root, 'project'), { recursive: true })
    writeFileSync(known, '{}\n')
    const announced = join(root, 'elsewhere', `${sessionId}.jsonl`)
    const row = { sessionId, transcriptPath: known }
    expect(knownTranscript({ sessionId, transcriptPath: announced }, row, suffix)).toBe(known)
    expect(knownTranscript({ sessionId, transcriptPath: announced }, row, { suffix: '.json' })).toBe(announced)
    expect(knownTranscript({ sessionId, transcriptPath: known }, { sessionId, transcriptPath: announced }, suffix)).toBe(known)
    expect(knownTranscript({ sessionId: 'other', transcriptPath: announced }, row, suffix)).toBe(announced)
    expect(knownTranscript({ sessionId, transcriptPath: announced }, undefined, suffix)).toBe(announced)
    expect(knownTranscript({ sessionId, transcriptPath: null }, row, suffix)).toBeUndefined()
    expect(knownTranscript({ transcriptPath: announced }, row, suffix)).toBe(announced)
  })
})
