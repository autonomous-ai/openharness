import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEngineQuestionPane, parseQuestionPane, questionRequestId, type QuestionView } from './askQuestion.js'

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')

describe('question parsing through terminal whitespace', () => {
  it.each([' ', '\t', '\r', '\v', '\f', '\u00a0', '\u2003', '\u2028', '\u2029', '\uFEFF'])
    ('reads numbered rows indented with %j without changing their choices', space => {
      const view = parseQuestionPane([
        'Choose a drink?',
        `${space.repeat(120)}❯${space}1.${space}Tea`,
        `${space.repeat(120)}2.${space}Coffee`,
        'Enter to select · ↑/↓ to navigate · Esc to cancel',
      ].join('\n')) as QuestionView
      expect(view).toMatchObject({ kind: 'question', question: 'Choose a drink?', multi: false,
        rows: [{ number: '1', label: 'Tea', checked: false }, { number: '2', label: 'Coffee', checked: false }] })
    })

  it.each(['❯', '›', '>'])('retains checked and unchecked choices after the %s cursor', cursor => {
    const view = parseQuestionPane([
      'Which toppings?',
      `${' '.repeat(240)}${cursor} 1. [ ] Cheese`,
      `${' '.repeat(240)}2. [✔] Ham`,
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')) as QuestionView
    expect(view).toMatchObject({ kind: 'question', multi: true,
      rows: [{ number: '1', label: 'Cheese', checked: false }, { number: '2', label: 'Ham', checked: true }] })
  })

  it.each(['│', '┃', '|'])('removes the %s frame but preserves indentation and bars inside the dialog', border => {
    const frame = (line: string) => `    ${border} ${line.padEnd(240)} ${border}   `
    const view = parseEngineQuestionPane('hermes', [
      frame('  Choose red | blue?'),
      frame('  ❯ 1. Red | warm'),
      frame('    2. Blue | cool'),
      frame('  Enter to select · ↑/↓ to navigate · Esc to cancel'),
    ].join('\n')) as QuestionView
    expect(view).toMatchObject({ kind: 'question', question: 'Choose red | blue?',
      rows: [{ number: '1', label: 'Red | warm' }, { number: '2', label: 'Blue | cool' }] })
    expect(view.dialog).toBe('Choose red | blue?\n      ❯ 1. Red | warm\n        2. Blue | cool')
  })

  it.each(['claude', 'hermes', 'opencode', 'copilot'] as const)
    ('does not turn padded %s output or blank rows into a prompt', engine => {
      const output = Array.from({ length: 60 }, (_, i) => (i % 3 ? '' : 'Still working...').padEnd(240)).join('\n')
      expect(parseEngineQuestionPane(engine, output)).toBeNull()
    })

  it.each([
    ['claude', 'question-single.txt'], ['claude', 'question-multi.txt'],
    ['codex', 'question-codex.txt'], ['codex', 'permission-codex.txt'],
    ['hermes', 'question-hermes.txt'], ['hermes', 'question-hermes-lock.txt'],
    ['opencode', 'question-opencode.txt'], ['copilot', 'question-copilot.txt'],
  ] as const)('keeps %s/%s choices and request IDs stable when terminal padding changes', (engine, name) => {
    const raw = fixture(name)
    const original = parseEngineQuestionPane(engine, raw) as QuestionView
    const padded = parseEngineQuestionPane(engine, raw.split('\n').map(line => line.padEnd(240)).join('\n')) as QuestionView
    expect(original.kind).toBe('question')
    expect(padded).toEqual(original)
    expect(questionRequestId('same-session', padded)).toBe(questionRequestId('same-session', original))
  })
})
