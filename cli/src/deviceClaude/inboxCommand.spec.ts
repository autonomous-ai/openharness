import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inboxSessionOf } from './inboxCommand.js'

// harness.exe starts the follower on inbox.mjs for the lines it takes for the follower's (pty/src/command.rs
// `follows_inbox`), and inbox.mjs answers {"off":true} to any line this match refuses: the two read one list of lines,
// so they cannot drift apart (docs/plans/2026-11-27-windows-follower-ram-design.md, section 3).
const fixture = JSON.parse(
  readFileSync(new URL('../../../pty/tests/fixtures/follower_lines.json', import.meta.url), 'utf8'),
) as { follower: string[][]; other: string[][] }

/** The entries' rule (entry.ts, inboxEntry.ts): `device` first, then inboxSessionOf on the words after it. */
const follows = (line: string[]): boolean => line[0] === 'device' && inboxSessionOf(line.slice(1)) !== null

describe('the follower\'s line, as harness.exe matches it', () => {
  it.each(fixture.follower.map((line) => [line]))('takes %j', (line) => {
    expect(follows(line)).toBe(true)
  })

  it.each(fixture.other.map((line) => [line]))('leaves %j to the CLI', (line) => {
    expect(follows(line)).toBe(false)
  })
})
