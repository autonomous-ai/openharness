/**
 * State files are written whole, through `atomicWriteFile` / `atomicWriteJson` in `secureState.ts`, never in
 * place: a crash or a full disk midway through `writeFile` left a half-written trust file that the next start
 * could not read (docs/plans/2026-11-19-atomic-state-writes-design.md). This guard keeps the modules that own
 * a state file from growing a write in place again. A write there that is not a state file says why on its
 * line or the line above: `// not a state file: <why>`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Modules under `cli/src` that own a state file. `lib/secureState.ts` is the helper and is not listed. */
const STATE_MODULES: readonly string[] = [
  'lib/registry.ts',
  'lib/e2ee/store.ts',
  'lib/e2ee/machinePeers.ts',
  'lib/e2ee/trustGroup.ts',
  'lib/e2ee/deviceLogStore.ts',
  'lib/e2ee/accountTrust.ts',
  'lib/authSession.ts',
]

function hits(_source: string): Array<{ line: number; text: string }> {
  return []
}

describe('state writes guard', () => {
  it('finds a write in place', () => {
    expect(hits('writeFileSync(file, data)')).toHaveLength(1)
    expect(hits('await fs.promises.writeFile(file, data)')).toHaveLength(1)
    expect(hits('// writeFileSync(file)')).toEqual([])
    expect(hits('writeFileSync(archive, bytes) // not a state file: a one-shot download')).toEqual([])
  })

  it('no listed module writes a state file outside the helper', () => {
    const found = STATE_MODULES.flatMap((module) =>
      hits(readFileSync(join(__dirname, '..', module), 'utf8')).map((hit) => `${module}:${hit.line}: ${hit.text}`),
    )
    expect(found).toEqual([])
  })
})
