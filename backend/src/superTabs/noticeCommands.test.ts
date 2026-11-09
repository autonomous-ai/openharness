import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { missingVerbs, SUPER_TAB_VERBS } from './cliVerbs.test-support.js'

// Notices and answers tell an agent to run `harness super-tab VERB`. The decisions notices still told it to run `decisions --answered`
// weeks after the CLI dropped that verb, so an agent that followed them was refused. Anything the backend writes names only the
// verbs the CLI has (cliVerbs.test-support.ts).
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Every TypeScript source file under backend/src, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.test-support.ts') ? [path] : []
  })
}

describe('the super-tab verbs a text names', () => {
  it('finds a verb the CLI no longer has, after any option that comes before it', () => {
    expect(missingVerbs('Read the answer with: harness super-tab decisions --answered')).toEqual(['decisions'])
    expect(missingVerbs('Run harness super-tab --tab TAB --agent AGENT route GROUP, then harness super-tab route again')).toEqual(['route'])
    expect(missingVerbs('harness super-tab decisions and harness super-tab propose and harness super-tab mine')).toEqual(['decisions', 'propose', 'mine'])
  })

  it.each(SUPER_TAB_VERBS)('accepts %s, which the CLI has', verb => {
    expect(missingVerbs(`Run harness super-tab ${verb} GROUP, or harness super-tab --tab TAB ${verb} GROUP.`)).toEqual([])
  })

  it('names none that the CLI lacks in any text the backend writes', () => {
    const named = sources(SRC).flatMap(file => missingVerbs(readFileSync(file, 'utf8')).map(verb => `${relative(SRC, file)}: harness super-tab ${verb}`))
    expect(named).toEqual([])
  })
})
