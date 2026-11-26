import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIAL_SKILL_DESCRIPTION } from '../../src/devices/dialSkill.js'

const CROWD = join(import.meta.dirname, 'crowd')

// The process skills whose descriptions claim priority as real ones do, so the crowd competes for the model's
// attention and not only for the listing's length. Resizing the crowd keeps them as written.
const PROCESS_SKILLS = ['session-start-routine', 'design-before-building', 'test-first-development', 'verify-before-done', 'root-cause-first']

interface CrowdSkill {
  folder: string
  text: string
  name: string | null
  /** The description as the YAML parser reads it, or null when it is missing or not a JSON-quoted string. */
  description: string | null
  body: string
}

function skills(): CrowdSkill[] {
  const dir = join(CROWD, 'skills')
  return readdirSync(dir).map((folder) => {
    const text = readFileSync(join(dir, folder, 'SKILL.md'), 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
    const front = match?.[1] ?? ''
    const name = /^name: (.+)$/m.exec(front)?.[1] ?? null
    const quoted = /^description: (".*")$/m.exec(front)?.[1]
    let description: string | null = null
    try {
      description = quoted ? JSON.parse(quoted) : null
    } catch {
      // A description that is not valid JSON stays null and fails the test.
    }
    return { folder, text, name, description, body: match?.[2] ?? '' }
  })
}

function instructions(): string {
  return readFileSync(join(CROWD, 'instructions.md'), 'utf8')
}

/** The skills Claude Code bundles, as the captured stream's init lists them, the dial aside. */
function bundledSkills(): string[] {
  const stream = readFileSync(join(import.meta.dirname, 'test-data', 'claude-stream.jsonl'), 'utf8')
  const init = stream.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((e) => e.type === 'system' && e.subtype === 'init')
  return (init.skills as string[]).filter((name) => name !== 'dial')
}

// A crowd that asks, notifies or names the dial would be a rival channel, not dilution.
const FORBIDDEN = [
  /\bdials?\b/i,
  /\bharness\w*/i,
  /\bnotif\w*/i,
  /\bneeds you\b/i,
  /\bslack\b/i,
  /\bpager\w*/i,
  /\bsms\b/i,
  /\bask (the|your) (user|person|human)\b/i,
  /\bwait for the user\b/i,
  /\bcheck in with\b/i,
]

// The choices the need scenarios leave to the person, and their options. A crowd that tells the model to make them, or
// names the options, would settle a scenario's ask in the person's stead.
const SETTLES_AN_ASK = [
  /\b(pick|decid|decision|choos|chose|choice)\w*/i,
  /\bback ?off/i,
  /exponential/i,
  /jitter/i,
  /\bTTL\b/,
  /\bLRU\b/,
  /invalidat/i,
  /--json/,
  /\brate[ -]limit/i,
  /page size/i,
  /delimiter|semicolon/i,
  /\b(MIT|ISC|Apache|[AL]?GPL|BSD|MPL|Unlicense)\b/,
]

function claimsPriority(description: string): boolean {
  return /MUST/.test(description) || /any conversation|before any|always use/i.test(description)
}

describe('the crowd', () => {
  it('every skill has front matter naming its folder, a JSON-quoted description of at most 1,536 characters and a one-paragraph body', () => {
    const all = skills()
    expect(all.length).toBeGreaterThan(0)
    for (const s of all) {
      expect(s.name, s.folder).toBe(s.folder)
      expect(s.description, s.folder).not.toBeNull()
      expect(s.description!.length, s.folder).toBeLessThanOrEqual(1536)
      const body = s.body.trim()
      expect(body, s.folder).not.toBe('')
      expect(body, s.folder).not.toMatch(/\n\s*\n/)
    }
  })

  it('no skill is named dial or after a skill Claude Code bundles', () => {
    const taken = new Set(['dial', ...bundledSkills()])
    expect(skills().map((s) => s.folder).filter((name) => taken.has(name))).toEqual([])
  })

  it('no file names the dial or Harness, or asks, notifies or messages anyone', () => {
    const files = [{ file: 'instructions.md', text: instructions() }, ...skills().map((s) => ({ file: s.folder, text: s.text }))]
    const hits = files.flatMap(({ file, text }) => FORBIDDEN.filter((word) => word.test(text)).map((word) => `${file}: ${word}`))
    expect(hits).toEqual([])
  })

  // A skill's name stays as it is: renaming one would change the listing the crowd is sized by.
  it('no description, body or rule makes a choice a need scenario leaves to the person', () => {
    const texts = [
      { file: 'instructions.md', text: instructions() },
      ...skills().flatMap((s) => [{ file: `${s.folder} description`, text: s.description ?? '' }, { file: `${s.folder} body`, text: s.body }]),
    ]
    const hits = texts.flatMap(({ file, text }) => SETTLES_AN_ASK.filter((word) => word.test(text)).map((word) => `${file}: ${word}`))
    expect(hits).toEqual([])
  })

  it('four to six skills claim priority, and only they', () => {
    expect(PROCESS_SKILLS.length).toBeGreaterThanOrEqual(4)
    expect(PROCESS_SKILLS.length).toBeLessThanOrEqual(6)
    const claiming = skills().filter((s) => claimsPriority(s.description ?? '')).map((s) => s.folder)
    expect(claiming.sort()).toEqual([...PROCESS_SKILLS].sort())
  })

  it("the crowd's own listing lines, with the dial's, come to at most 20,000 characters", () => {
    const lines = [`- dial: ${DIAL_SKILL_DESCRIPTION}`, ...skills().map((s) => `- ${s.name}: ${s.description}`)]
    expect(lines.join('\n').length).toBeLessThanOrEqual(20_000)
  })

  it('instructions.md is 55 to 65 lines and opens with # Team engineering rules', () => {
    const lines = instructions().replace(/\n$/, '').split('\n')
    expect(lines[0]).toBe('# Team engineering rules')
    expect(lines.length).toBeGreaterThanOrEqual(55)
    expect(lines.length).toBeLessThanOrEqual(65)
  })
})
