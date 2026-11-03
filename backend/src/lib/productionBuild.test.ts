import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// build.mjs ships every .ts under src except *.test.ts and *.test-support.ts into dist. Code that only tests or CI use
// (anything importing Vitest) must carry one of those names, or it lands in the production build (review of #2804).
const src = fileURLToPath(new URL('..', import.meta.url))
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])

describe('the production build', () => {
  it('ships no file that imports Vitest', () => {
    const shipped = files(src).filter(path => !path.endsWith('.test.ts') && !path.endsWith('.test-support.ts'))
    expect(shipped.length).toBeGreaterThan(50)
    const testOnly = shipped.filter(path => /from ['"]vitest(\/[\w-]+)?['"]/.test(readFileSync(path, 'utf8')))
    expect(testOnly.map(path => relative(src, path))).toEqual([])
  })
})
