import { describe, expect, it } from 'vitest'

// The dial eval's tier B editor steps, the parts that need no daemon. They are outside tsconfig's rootDir (src), so they
// are loaded untyped, as dialAppEvalTierB.spec.ts loads the harness.
const editor = await import('../../e2e/harness/appEvalEditor.js' as string) as {
  windowRecords(window: string, keyOf: (pid: number) => string | undefined,
    record: (line: Record<string, unknown>, at: number) => void): (printed: Record<string, unknown>, at: number) => void
}

describe("tier B's editor windows", () => {
  it("the window's printed lines become stream records: a show with the raise after it folded in, each scrolled line for the active terminal, each state taken, shells by key", () => {
    const shells: Record<number, string> = { 41_001: 'a', 41_002: 'b' }
    const records: Array<{ at: number; line: Record<string, unknown> }> = []
    const take = editor.windowRecords('eval-w1-1', (pid) => shells[pid], (line, at) => records.push({ at, line }))
    const printed: Array<Record<string, unknown>> = [
      { took: { terminals: [41_001, 41_002], active: 41_001, focused: true } },
      { log: 'state: connected' },
      { state: 'connected' },
      // A tap's show, then its raise.
      { show: 41_002 },
      { raise: true },
      { scroll: 'up' },
      { scroll: 'up' },
      { took: { terminals: [41_001, 41_002], active: 41_002, focused: false } },
      { scroll: 'down' },
      { key: 'up', pid: 41_002 },
      // A rest's show, with no raise, and one of a shell no session of the scenario has.
      { show: 41_001 },
      { show: 41_999 },
    ]
    printed.forEach((line, i) => take(line, 100 + i))
    expect(records).toEqual([
      { at: 100, line: { type: 'vscode-state', terminals: ['a', 'b'], active: 'a', focused: true } },
      { at: 102, line: { type: 'vscode', window: 'eval-w1-1' } },
      { at: 103, line: { show: 'b', raise: true } },
      { at: 105, line: { scroll: 'up', pid: 'a' } },
      { at: 106, line: { scroll: 'up', pid: 'a' } },
      { at: 107, line: { type: 'vscode-state', terminals: ['a', 'b'], active: 'b', focused: false } },
      { at: 108, line: { scroll: 'down', pid: 'b' } },
      { at: 110, line: { show: 'a' } },
      { at: 111, line: { show: 'other' } },
    ])
  })
})
