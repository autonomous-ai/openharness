import { describe, expect, it } from 'vitest'
import { instructionsChange, CHANGE_LINES, LINE_CHARS } from './instructionsDiff.js'

/** The diff lines of a change: what sits between its fence lines. */
const body = (change: string) => change.split('\n```')[0]!.split('\n').slice(1)

describe('instructionsChange', () => {
  // Ken, 11-05: lamp's PM said revision 32 held a rule that revisions 28 to 51 don't contain; the chat showed only its summary.
  it('shows the lines a save removed and added, in document order, and none it kept', () => {
    const before = 'One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine\nTen'
    const after = 'One\nTwo, changed\nThree\nFour\nFive\nSix\nSeven\nEight\nNine\nTen\nEleven'
    expect(instructionsChange(before, after)).toBe('```diff\n- Two\n+ Two, changed\n+ Eleven\n```')
  })

  it('shows 12 lines of a long change, then how many more there are', () => {
    const before = 'Head'
    const after = ['Head', ...Array.from({ length: 20 }, (_, i) => `Rule ${i + 1}.`)].join('\n')
    const change = instructionsChange(before, after)
    expect(CHANGE_LINES).toBe(12)
    expect(body(change)).toEqual(Array.from({ length: 12 }, (_, i) => `+ Rule ${i + 1}.`))
    expect(change.endsWith('```\n\nand 8 more lines.')).toBe(true)
    expect(instructionsChange(before, after.split('\n').slice(0, 14).join('\n')).endsWith('```\n\nand 1 more line.')).toBe(true)
    expect(instructionsChange(before, after.split('\n').slice(0, 13).join('\n'))).not.toContain('more line')
  })

  it('counts and shows no blank lines, and says so when only blank lines changed', () => {
    expect(instructionsChange('A\n\nB', 'A\n\n\nB\n\nC\n')).toBe('```diff\n+ C\n```')
    expect(instructionsChange('A\nB', 'A\n\nB\n')).toBe('Only blank lines changed.')
  })

  it('keeps a saved line\'s backticks, tags and links inside the code block', () => {
    const change = instructionsChange('A', 'A\n```\n@dee read https://example.com\n~~~')
    const lines = change.split('\n')
    expect(lines[0]).toBe('```diff')
    // Every diff line starts with its sign, so none can close the fence; the one closing line is the last.
    expect(lines.slice(1, -1).every(l => /^[+-] /.test(l))).toBe(true)
    expect(lines.at(-1)).toBe('```')
    expect(lines.filter(l => l.startsWith('```'))).toHaveLength(2)
  })

  it('cuts a very long line, never the count', () => {
    const long = 'x'.repeat(LINE_CHARS + 50)
    expect(body(instructionsChange('A', `A\n${long}`))).toEqual([`+ ${'x'.repeat(LINE_CHARS - 1)}…`])
  })

  it('says when the earlier revision could not be read, rather than showing no change', () => {
    expect(instructionsChange(null, 'Anything.')).toBe('The earlier revision could not be read, so the change is not shown.')
  })

  it('shows a rewrite too big to compare line by line as its real removed and added lines', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `Old ${i}`).join('\n')
    const after = Array.from({ length: 2000 }, (_, i) => `New ${i}`).join('\n')
    const started = performance.now()
    const change = instructionsChange(before, after)
    expect(performance.now() - started).toBeLessThan(500)
    expect(body(change)).toEqual(Array.from({ length: 12 }, (_, i) => `- Old ${i}`))
    expect(change.endsWith('and 3988 more lines.')).toBe(true)
  })

  it('compares a large document\'s small change line by line', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i}`)
    const after = [...lines.slice(0, 500), 'Inserted', ...lines.slice(500, 1500), ...lines.slice(1501)]
    expect(instructionsChange(lines.join('\n'), after.join('\n'))).toBe('```diff\n+ Inserted\n- Line 1500\n```')
  })
})
