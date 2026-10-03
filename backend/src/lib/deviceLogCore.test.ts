import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyDevLogEntries, DevLogError, devLogHash, emptyDevLogState } from './deviceLogCore.js'

// The same fixture the CLI and both Dart ports are held to (cli/scripts/gen-devlog-vectors.ts).
const vectors = JSON.parse(readFileSync(join(import.meta.dirname, 'deviceLog.vectors.json'), 'utf-8'))

describe('device log core against the shared vectors', () => {
  it('applies every valid entry to the fixture hashes, head and active set', () => {
    const { state } = applyDevLogEntries(emptyDevLogState(vectors.acct), vectors.valid.entries)
    expect(state.hashes).toEqual(vectors.valid.hashes)
    expect(state.head).toEqual(vectors.valid.head)
    expect(Object.keys(state.active).sort()).toEqual(vectors.valid.active)
    expect(state.removed).toEqual(vectors.valid.removed)
    vectors.valid.entries.forEach((e: never, i: number) => expect(devLogHash(e)).toBe(vectors.valid.hashes[i]))
  })

  for (const c of vectors.invalid as Array<{ name: string; after: number; entry: unknown; code: string }>) {
    it(`refuses: ${c.name} (${c.code})`, () => {
      const base = applyDevLogEntries(emptyDevLogState(vectors.acct), vectors.valid.entries.slice(0, c.after)).state
      let code: string | null = null
      try { applyDevLogEntries(base, [c.entry]) } catch (err) { code = err instanceof DevLogError ? err.code : String(err) }
      expect(code).toBe(c.code)
    })
  }
})
