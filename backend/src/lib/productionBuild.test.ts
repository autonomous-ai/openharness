import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { devImports, testFileImports } from './devImports.test-support.js'

// build.mjs ships every .ts under src except *.test.ts and *.test-support.ts into dist, and production installs no
// devDependency. Code that imports one (Vitest, the in-memory MongoDB, ...) must carry one of those names (reviews of #2804
// and #2822).
const src = fileURLToPath(new URL('..', import.meta.url))
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])
const devDependencies = Object.keys((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as
  { devDependencies: Record<string, string> }).devDependencies)

describe('the production build', () => {
  it('ships no file that imports a devDependency', () => {
    const shipped = files(src).filter(path => !path.endsWith('.test.ts') && !path.endsWith('.test-support.ts'))
    expect(shipped.length).toBeGreaterThan(50)
    const testOnly = shipped.flatMap(path => devImports(readFileSync(path, 'utf8'), devDependencies).map(name => `${relative(src, path)}: ${name}`))
    expect(testOnly).toEqual([])
  })

  it('ships no file that imports a test or test-support file, which the build leaves out', () => {
    const shipped = files(src).filter(path => !path.endsWith('.test.ts') && !path.endsWith('.test-support.ts'))
    expect(shipped.flatMap(path => testFileImports(readFileSync(path, 'utf8')).map(name => `${relative(src, path)}: ${name}`))).toEqual([])
  })

  it('finds every form of import of a devDependency, and none that is erased or another package', () => {
    const dev = ['vitest', 'mongodb-memory-server-core', 'mongodb', '@vitest/coverage-v8']
    expect(devImports(`import { it } from 'vitest'`, dev)).toEqual(['vitest'])
    expect(devImports(`import 'vitest'`, dev)).toEqual(['vitest'])
    expect(devImports(`const m = await import("mongodb-memory-server-core")`, dev)).toEqual(['mongodb-memory-server-core'])
    expect(devImports(`export { x } from 'vitest/node'`, dev)).toEqual(['vitest'])
    expect(devImports(`import * as c from '@vitest/coverage-v8/dist/x.js'`, dev)).toEqual(['@vitest/coverage-v8'])
    expect(devImports(`import type { Db } from 'mongodb'`, dev)).toEqual([])
    expect(devImports(`import { type Db } from 'mongodb-extra'\nimport { PrismaClient } from '@prisma/client'`, dev)).toEqual([])
    expect(devImports(`// import 'vitest' in a comment is still flagged: keep test-only words out of shipped files`, dev)).toEqual(['vitest'])
    // require-style forms and a template-literal import (review of #2836)
    expect(devImports(`const v = require('vitest')`, dev)).toEqual(['vitest'])
    expect(devImports(`const m = createRequire(import.meta.url)('mongodb')`, dev)).toEqual(['mongodb'])
    expect(devImports(`import m = require('mongodb')`, dev)).toEqual(['mongodb'])
    expect(devImports('const m = await import(`mongodb-memory-server-core`)', dev)).toEqual(['mongodb-memory-server-core'])
    // type-only imports and exports the build erases, over several lines too
    expect(devImports(`import type {\n  Db,\n  MongoClient,\n} from 'mongodb'`, dev)).toEqual([])
    expect(devImports(`export type { Db } from 'mongodb'\nexport type {\n  Suite,\n} from 'vitest'`, dev)).toEqual([])
    expect(devImports(`import type {\n  Db,\n} from 'mongodb'\nimport { it } from 'vitest'`, dev)).toEqual(['vitest'])
  })

  it('finds an import of a test or test-support file in every form', () => {
    expect(testFileImports(`import { MemoryStamps } from '../superTabs/cache.test-support.js'`)).toEqual(['../superTabs/cache.test-support.js'])
    expect(testFileImports(`const f = await import('./fixtures.test-support')`)).toEqual(['./fixtures.test-support'])
    expect(testFileImports(`export * from './shards.test.js'`)).toEqual(['./shards.test.js'])
    expect(testFileImports(`const x = require('./x.test-support.js')`)).toEqual(['./x.test-support.js'])
    expect(testFileImports(`import type { Seed } from './seed.test-support.js'`)).toEqual([])
    expect(testFileImports(`import { tested } from './tested.js'\nimport { testSupport } from './test-support-names.js'`)).toEqual([])
  })
})
