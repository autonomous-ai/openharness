import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { missingVerbs, superTabVerbs } from './cliVerbs.test-support.js'

// Notices and answers tell an agent to run `harness super-tab VERB`. The decisions notices still told it to run `decisions --answered`
// weeks after the CLI dropped that verb, so an agent that followed them was refused. Anything the backend writes names only the
// verbs the CLI has, read from the CLI's own usage line (cliVerbs.test-support.ts).
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Every TypeScript source file under backend/src, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.test-support.ts') ? [path] : []
  })
}

describe('the super-tab verbs of the CLI', () => {
  it('are read from its usage line, each alternative\'s first word', () => {
    expect(superTabVerbs("const USAGE = 'harness super-tab [--tab ID] [--port N --machine ID] status [--archived [PAGE]] | post GROUP TEXT OPERATION_ID [--to AGENT]... | type AGENT [TEXT]'"))
      .toEqual(['status', 'post', 'type'])
    // Today's CLI: the verbs agents are told to run are among them.
    expect(superTabVerbs()).toEqual(expect.arrayContaining(['status', 'messages', 'message', 'post', 'answer']))
  })
})

describe('the super-tab verbs a text names', () => {
  const verbs = ['status', 'messages', 'message', 'post', 'answer']
  it('finds a verb the CLI no longer has, after any option that comes before it, however it is spaced', () => {
    expect(missingVerbs('Read the answer with: harness super-tab decisions --answered', verbs)).toEqual(['decisions'])
    expect(missingVerbs('Run harness super-tab --tab TAB --agent AGENT route GROUP, then harness super-tab route again', verbs)).toEqual(['route'])
    expect(missingVerbs('harness super-tab --tab=TAB --port 1 --machine m decisions', verbs)).toEqual(['decisions'])
    expect(missingVerbs('Read it with: harness\n  super-tab decisions', verbs)).toEqual(['decisions'])
    expect(missingVerbs('harness super-tab decisions and harness super-tab propose and harness super-tab mine', verbs)).toEqual(['decisions', 'propose', 'mine'])
  })

  it.each(['status', 'messages', 'message', 'post', 'answer'])('accepts %s, which the CLI has', verb => {
    expect(missingVerbs(`Run harness super-tab ${verb} GROUP, or harness super-tab --tab TAB ${verb} GROUP.`, verbs)).toEqual([])
  })

  it('names none that the CLI lacks in any text the backend writes', () => {
    const files = sources(SRC)
    // The walk reads the notices' own files: an empty or misplaced walk would pass anything.
    expect(files.map(file => relative(SRC, file))).toEqual(expect.arrayContaining(['superTabs/noticeDigest.ts', 'superTabs/inbox.ts']))
    const cli = superTabVerbs()
    const named = files.flatMap(file => missingVerbs(readFileSync(file, 'utf8'), cli).map(verb => `${relative(SRC, file)}: harness super-tab ${verb}`))
    expect(named).toEqual([])
  })
})
