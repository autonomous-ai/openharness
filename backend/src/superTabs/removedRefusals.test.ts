import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Project instructions, phase 4 is done when no refusal the instructions replaced is reachable: the server refuses only facts
// and access (design, "What the server still enforces"). ENGINE_UNAVAILABLE stays for signed-out and suspended engines.
const REMOVED = ['WORKER_DECISION_REQUIRED', 'LEAD_REQUIRED', 'REVIEW_OPEN', 'REVIEW_PENDING', 'REVIEW_TARGET', 'CHECKS_PENDING',
  'BRIEF_REQUIRED', 'INDEPENDENT_REVIEW', 'REVIEWER_NOT_ASSIGNABLE', 'REVIEW_GROUP', 'REVIEWER_NOT_LEAD', 'ROLE_LEAD', 'ROLE_NAME',
  'ROLE_UNAVAILABLE', 'ROLE_KIND', 'ROLE_IN_USE', 'ROLE_GONE', 'OVERRIDE_REASON_REQUIRED', 'ROUTE_REQUIRED', 'RULE_BROKEN',
  'REQUIREMENT_UNMET', 'REVIEW_REFUSED', 'STEPPED_UP', 'BUILD_REFUSED', 'MERGE_RECORDER', 'TELL_FORBIDDEN', 'DECISION_FORBIDDEN',
  'MENTION_FORBIDDEN', 'OWNER_MESSAGE_REQUIRED', 'WORK_REQUIRED', 'REVIEW_SHIPS_NOTHING']

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Every TypeScript source file under backend/src, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : []
  })
}

describe('the refusals project instructions removed', () => {
  it('reaches none of the refusals the instructions replaced', () => {
    const files = sources(SRC)
    // The walk itself is checked: it reads the command handlers, where these codes were thrown.
    expect(files.map(f => relative(SRC, f))).toEqual(expect.arrayContaining(['superTabs/commands.ts', 'superTabs/store.ts', 'routes/superTabs.ts']))
    const quoted = (code: string) => new RegExp(`['"\`]${code}['"\`]`)
    const found = files.flatMap(file => {
      const text = readFileSync(file, 'utf8')
      return REMOVED.filter(code => quoted(code).test(text)).map(code => `${code} in ${relative(SRC, file)}`)
    })
    expect(found).toEqual([])
    // The same search finds refusals that stay: settings and who coordinates stay the coordinator's or a person's.
    const commands = readFileSync(join(SRC, 'superTabs/commands.ts'), 'utf8')
    expect(['COORDINATOR_REQUIRED', 'LEAD_PROTECTED'].every(code => quoted(code).test(commands))).toBe(true)
  })
})
