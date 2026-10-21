import { describe, expect, it } from 'vitest'
import { changedFiles } from './handoffChangedFiles.js'
import { toolText, type IndexedTurn } from './sessionSearch/turns.js'
import { codexToolDescriptor } from '../engines/codex/subagent.js'

const turn = (n: number, tools: string): IndexedTurn => ({ turn: n, offset: 0, at: null, ask: '', answer: '', tools })

describe('changedFiles', () => {
  it('lists edited files newest first, once, relative to the project', () => {
    const turns = [
      turn(0, 'Edit /w/src/a.ts\nBash npm test'),
      turn(1, 'Write /w/docs/my notes.md\nEdit /w/src/a.ts'),
      turn(2, 'ApplyPatch src/b.ts src/c.ts\nRead /w/src/d.ts'),
    ]
    expect(changedFiles(turns, '/w')).toEqual(['src/c.ts', 'src/b.ts', 'src/a.ts', 'docs/my notes.md'])
  })
  it('keeps a path outside the project absolute and ignores tools that change nothing', () => {
    expect(changedFiles([turn(0, 'MultiEdit /etc/hosts\nNotebookEdit /w/n.ipynb\nGrep TODO\nBash rm -rf x')], '/w'))
      .toEqual(['n.ipynb', '/etc/hosts'])
  })
  it('stops at the cap and cuts a very long path', () => {
    const tools = Array.from({ length: 40 }, (_, i) => `Edit /w/f${i}.ts`).join('\n')
    const out = changedFiles([turn(0, tools), turn(1, `Write /w/${'x'.repeat(500)}`)], '/w')
    expect(out).toHaveLength(30)
    expect(out[0].length).toBe(200)
    expect(out[1]).toBe('f39.ts')
  })
  it('is empty when nothing was edited', () => {
    expect(changedFiles([turn(0, ''), turn(1, 'Bash ls')], '/w')).toEqual([])
  })
})

// Codex records apply_patch three ways; the reviewer counted 540 code-mode `exec` calls and 7 freeform ones in 80
// sessions, and both reached the record as a bare "ApplyPatch" (2026-10-21). Real shapes, through the real normalizer.
describe('Codex patches, as its rollouts record them', () => {
  const line = (name: string, input: unknown) => { const d = codexToolDescriptor(name, input); return toolText(d.tool, d.input) }
  it('lists the files of freeform, code-mode and JSON patches', () => {
    const freeform = line('apply_patch', '*** Begin Patch\n*** Add File: /w/docs/a.md\n+# A\n*** Update File: /w/src/b.ts\n@@\n-x\n+y\n*** End Patch\n')
    const exec = line('exec', 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /w/src/c.ts\\n@@\\n-x\\n+y\\n*** End Patch\\n"))')
    const json = line('apply_patch', JSON.stringify({ input: '*** Begin Patch\n*** Delete File: /w/old.ts\n*** End Patch\n' }))
    expect(changedFiles([turn(0, [json, freeform, exec].join('\n'))], '/w')).toEqual(['src/c.ts', 'src/b.ts', 'docs/a.md', 'old.ts'])
  })
})
