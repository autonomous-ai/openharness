import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeHomeListed, listClaudeProfiles } from './claudeHomes.js'

describe("Claude's profile folder under the home", () => {
  let home = ''
  // Real path: macOS's tmpdir sits behind a /var -> /private/var link.
  beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-homes-home-'))) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it("a folder under <home>/.harness/claude-profiles is Harness's own", () => {
    expect(claudeHomeListed(join(home, '.harness', 'claude-profiles', '1'), 'm', { home, environment: {} })).toBe(true)
    expect(claudeHomeListed(join(home, '.harness', 'claude-profilesx', '1'), 'm', { home, environment: {} })).toBe(false)
  })

  it('it is listed, and labelled Claude <name>', () => {
    const folder = join(home, '.harness', 'claude-profiles', '2')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'settings.json'), '{}')
    expect(listClaudeProfiles([], { home, environment: {}, machineId: 'm' })).toContainEqual(expect.objectContaining({ path: folder, label: 'Claude 2' }))
  })
})
