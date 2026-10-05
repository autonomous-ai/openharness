/**
 * L2 BORROW, the edges (daemons/LEARNING.md): front matter as engines really write it, long paragraphs, the
 * size and depth bounds, files that cannot be read, Hermes' hub lock in its several shapes, a project
 * reached through a symlink, a whole-file Codex memory, and the pass's accounting when the store itself
 * refuses or remembers a skip the journal lost. Every engine home is a temp folder; nothing real is read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mangleClaudeProjectDir } from '../../../../cli/src/lib/claudeProject.js'
import {
  BORROW_MAX_FILE_BYTES, LessonBorrower, borrowSignal, hermesProvenance, parseFrontmatter, readClaudeMemory, readCodexMemories, readHermesSkills,
} from './borrow.js'
import { LessonStore } from './store.js'
import { projectHash } from './types.js'

const DAY = 24 * 60 * 60_000
const NOW = Date.UTC(2026, 9, 3, 15, 0)
let dir: string
let hermes: string
let claudeProjects: string
let codex: string
let ws: string
let store: LessonStore
const locked: string[] = []
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'learn-borrow-more-')))
  hermes = join(dir, 'home', '.hermes')
  claudeProjects = join(dir, 'home', '.claude', 'projects')
  codex = join(dir, 'home', '.codex')
  ws = join(dir, 'code', 'api')
  mkdirSync(ws, { recursive: true })
  let n = 0
  store = new LessonStore({ root: join(dir, 'home', '.harness', 'lessons'), now: () => NOW, newId: () => `c0${(++n).toString(16).padStart(4, '0')}`, git: null })
})
afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o755)
  rmSync(dir, { recursive: true, force: true })
})

function write(path: string, text: string, ageDays = 1): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  const at = new Date(NOW - ageDays * DAY)
  utimesSync(path, at, at)
}
const skillMd = (name: string, description: string, body = `Do ${name} carefully.\nCheck the result.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
const agentMarks = (...names: string[]) => write(join(hermes, 'skills', '.usage.json'), JSON.stringify(Object.fromEntries(names.map((n) => [n, { created_by: 'agent' }]))))

describe('front matter as engines write it', () => {
  it('skips lines that are not a key, folds a > block across blank lines, keeps a | block\'s lines', () => {
    const text = [
      '---', '# a comment', 'name: deploy', '  - stray', 'description: >', '  Deploy the api.', '', '  Then smoke test it.',
      'notes: |', '  line one', '  line two', 'when: always', '---', 'Body.',
    ].join('\n')
    expect(parseFrontmatter(text)).toEqual({
      fields: { name: 'deploy', description: 'Deploy the api.  Then smoke test it.', notes: 'line one\nline two', when: 'always' },
      body: 'Body.',
    })
  })

  it('a double-quoted value that is not valid JSON keeps its text; CRLF and a BOM are read as plain lines', () => {
    expect(parseFrontmatter('---\nname: "bad \\q escape"\n---\nx').fields.name).toBe('bad \\q escape')
    expect(parseFrontmatter('﻿---\r\nname: win\r\n---\r\nbody\r\n')).toEqual({ fields: { name: 'win' }, body: 'body\n' })
  })
})

describe('what a candidate carries', () => {
  it('a skill with no name in its front matter is named by its folder; no description: its first line of prose', () => {
    write(join(hermes, 'skills', 'release-notes', 'SKILL.md'), '---\ntags: x\n---\n# Release notes\n\n> Write them from the merged PRs.\n')
    agentMarks('release-notes')
    expect(readHermesSkills(hermes, NOW)).toEqual([expect.objectContaining({ name: 'release-notes', description: 'Release notes' })])
  })

  it('an empty body and no description: the name stands in for the description', () => {
    write(join(hermes, 'skills', 'bare', 'SKILL.md'), '---\nname: bare\n---\n')
    agentMarks('bare')
    expect(readHermesSkills(hermes, NOW)).toEqual([expect.objectContaining({ name: 'bare', description: 'bare', body: '' })])
  })

  it('a description longer than 280 characters is cut at a word, with an ellipsis', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    write(join(hermes, 'skills', 'long', 'SKILL.md'), skillMd('long', words))
    agentMarks('long')
    const [candidate] = readHermesSkills(hermes, NOW)
    expect(candidate!.description.length).toBeLessThanOrEqual(280)
    expect(candidate!.description).toMatch(/^word0 word1 .* word\d+\.\.\.$/)
    expect(words.startsWith(candidate!.description.slice(0, -3))).toBe(true)
  })

  it('a paragraph written as one long line is wrapped at words, so the guard reads it as a lesson; code stays as written', () => {
    const para = Array.from({ length: 120 }, (_, i) => `step${i}`).join(' ')
    const bullet = `- ${Array.from({ length: 90 }, (_, i) => `item${i}`).join(' ')}`
    const unbreakable = 'x'.repeat(450)
    write(join(hermes, 'skills', 'wrapped', 'SKILL.md'), skillMd('wrapped', 'Long lines.', [para, bullet, unbreakable].join('\n')))
    agentMarks('wrapped')
    const [candidate] = readHermesSkills(hermes, NOW)
    const lines = candidate!.body.split('\n')
    expect(lines.filter((l) => l.startsWith('step')).join(' ')).toBe(para)
    // A bullet's continuation lines are indented under it, and every word is still there, in order.
    const bulletLines = lines.filter((l) => l.startsWith('- item') || /^ {2}item/.test(l))
    expect(bulletLines.length).toBeGreaterThan(2)
    expect(bulletLines.slice(1).every((l) => l.startsWith('  item'))).toBe(true)
    expect(bulletLines.map((l) => l.trim()).join(' ')).toBe(bullet)
    // A word longer than a line is left whole.
    expect(lines).toContain(unbreakable)
    expect(lines.filter((l) => l !== unbreakable).every((l) => l.length <= 200)).toBe(true)
  })

  it('a long line inside a code fence is never wrapped', () => {
    const code = `echo ${'a '.repeat(250)}`.trimEnd()
    write(join(hermes, 'skills', 'fenced', 'SKILL.md'), skillMd('fenced', 'Code.', ['```sh', code, '```'].join('\n')))
    agentMarks('fenced')
    expect(readHermesSkills(hermes, NOW)[0]!.body).toBe(['```sh', code, '```'].join('\n'))
  })
})

describe('bounds and files that cannot be read', () => {
  it(`a SKILL.md or memory file over ${BORROW_MAX_FILE_BYTES / 1024} KB is not a lesson`, () => {
    const big = `${'x '.repeat(BORROW_MAX_FILE_BYTES / 2 + 10)}\n`
    write(join(hermes, 'skills', 'huge', 'SKILL.md'), skillMd('huge', 'Too big.', big))
    agentMarks('huge')
    expect(readHermesSkills(hermes, NOW)).toEqual([])
    const mem = join(claudeProjects, mangleClaudeProjectDir(ws), 'memory')
    write(join(mem, 'huge.md'), big)
    write(join(mem, 'small.md'), 'Run the api tests alone.\n')
    expect(readClaudeMemory(claudeProjects, [ws]).map((c) => c.name)).toEqual(['small'])
    write(join(codex, 'memories', 'huge.md'), `## huge\n${big}`)
    expect(readCodexMemories(codex)).toEqual([])
  })

  it('a folder it may not read is passed over without an error', () => {
    write(join(hermes, 'skills', 'open', 'SKILL.md'), skillMd('open', 'Readable.'))
    write(join(hermes, 'skills', 'closed', 'inner', 'SKILL.md'), skillMd('inner', 'Unreadable.'))
    agentMarks('open', 'inner')
    chmodSync(join(hermes, 'skills', 'closed'), 0o000)
    locked.push(join(hermes, 'skills', 'closed'))
    expect(readHermesSkills(hermes, NOW).map((c) => c.name)).toEqual(['open'])
  })

  it('walks at most four folders deep under skills/', () => {
    write(join(hermes, 'skills', 'a', 'b', 'c', 'd', 'SKILL.md'), skillMd('four-deep', 'Found.'))
    write(join(hermes, 'skills', 'x', 'y', 'z', 'w', 'v', 'SKILL.md'), skillMd('five-deep', 'Too deep.'))
    agentMarks('four-deep', 'five-deep')
    expect(readHermesSkills(hermes, NOW).map((c) => [c.name, c.source])).toEqual([['four-deep', 'skills/a/b/c/d/SKILL.md']])
  })

  it('reads at most 200 skill folders, 200 Claude memories and 200 Codex sections', () => {
    for (let i = 0; i < 205; i++) write(join(hermes, 'skills', `s${String(i).padStart(3, '0')}`, 'SKILL.md'), skillMd(`s${i}`, `Skill ${i}.`))
    write(join(hermes, 'skills', '.usage.json'), JSON.stringify({}))
    expect(readHermesSkills(hermes, NOW)).toHaveLength(200)
    const mem = join(claudeProjects, mangleClaudeProjectDir(ws), 'memory')
    for (let i = 0; i < 205; i++) write(join(mem, `m${i}.md`), `Memory ${i}.\n`)
    expect(readClaudeMemory(claudeProjects, [ws])).toHaveLength(200)
    write(join(codex, 'memories', 'MEMORY.md'), Array.from({ length: 205 }, (_, i) => `## Section ${i}\nFact ${i}.\n`).join('\n'))
    const sections = readCodexMemories(codex)
    expect(sections).toHaveLength(200)
    expect(sections.at(-1)!.name).toBe('Section 199')
  })
})

describe('Hermes\' own marks, in every shape', () => {
  it('reads installed names from the hub lock whether it lists objects, strings or keyed maps; stops four levels down', () => {
    const skills = join(hermes, 'skills')
    write(join(skills, '.hub', 'lock.json'), JSON.stringify({
      skills: [{ name: 'from-list' }, 'as-string', { version: 2 }, 7],
      packages: { 'keyed-pkg': { v: 1 } },
      other: { installed: ['not-read-under-other-key'] },
      entries: { entries: { entries: { entries: { 'deep-3': {}, installed: { 'too-deep': {} } } } } },
    }))
    const installed = hermesProvenance(skills).installed
    for (const name of ['from-list', 'as-string', 'keyed-pkg', 'deep-3']) expect(installed.has(name)).toBe(true)
    for (const name of ['too-deep', 'not-read-under-other-key']) expect(installed.has(name)).toBe(false)
  })

  it('an entry that is not an object is no mark; archived_at or state retired means retired', () => {
    const skills = join(hermes, 'skills')
    write(join(skills, '.usage.json'), JSON.stringify({
      nothing: null, count: 3, gone: { created_by: 'agent', archived_at: '2026-01-01' }, old: { agent_created: true, state: 'retired' },
      kept: { created_by: 'agent', archived_at: null },
    }))
    const marks = hermesProvenance(skills)
    expect(marks.known).toBe(true)
    expect([...marks.agent].sort()).toEqual(['gone', 'kept', 'old'])
    expect([...marks.retired].sort()).toEqual(['gone', 'old'])
  })

  it('a .usage.json that is not JSON, or is a list, keeps no marks: recent skills are read', () => {
    write(join(hermes, 'skills', 'recent', 'SKILL.md'), skillMd('recent', 'New.'), 2)
    write(join(hermes, 'skills', 'stale', 'SKILL.md'), skillMd('stale', 'Old.'), 60)
    write(join(hermes, 'skills', '.usage.json'), '{ not json')
    expect(hermesProvenance(join(hermes, 'skills')).known).toBe(false)
    expect(readHermesSkills(hermes, NOW).map((c) => c.name)).toEqual(['recent'])
    write(join(hermes, 'skills', '.usage.json'), JSON.stringify(['recent']))
    expect(readHermesSkills(hermes, NOW).map((c) => c.name)).toEqual(['recent'])
  })

  it('a .usage.json that is a symlink is not followed', () => {
    const outside = join(dir, 'outside-usage.json')
    write(outside, JSON.stringify({ 'by-hand': { created_by: 'agent' } }))
    write(join(hermes, 'skills', 'by-hand', 'SKILL.md'), skillMd('by-hand', 'Written by the person.'), 60)
    symlinkSync(outside, join(hermes, 'skills', '.usage.json'))
    expect(hermesProvenance(join(hermes, 'skills')).known).toBe(false)
    expect(readHermesSkills(hermes, NOW)).toEqual([])
  })
})

describe('Claude Code memory through a link, Codex whole-file memories', () => {
  it('a project reached through a symlink finds the memory kept under its real path, once', () => {
    const link = join(dir, 'link-to-api')
    symlinkSync(ws, link)
    write(join(claudeProjects, mangleClaudeProjectDir(ws), 'memory', 'deploy.md'), '---\ndescription: Deploy from main.\n---\nTag first.\n')
    const found = readClaudeMemory(claudeProjects, [link, ws, join(dir, 'gone')])
    expect(found.map((c) => [c.name, c.source])).toEqual([['deploy', 'memory/deploy.md']])
    expect([projectHash(link), projectHash(ws)]).toContain(found[0]!.project)
    expect(found[0]!.description).toBe('Deploy from main.')
  })

  it('a Codex memory file with its own name and description is one candidate; with a name alone, its sections are', () => {
    write(join(codex, 'memories', 'release.md'), '---\nname: release-api\ndescription: How api is released.\n---\n## Tag\nTag from main.\n')
    write(join(codex, 'memories', 'half.md'), '---\nname: half\n---\n## Lint\nRun the linter.\n')
    write(join(codex, 'memories', '.hidden.md'), '## x\ny\n')
    write(join(codex, 'memories', 'notes.txt'), '## x\ny\n')
    const found = readCodexMemories(codex)
    expect(found.map((c) => [c.name, c.source]).sort()).toEqual([['Lint', 'memories/half.md#lint'], ['release-api', 'memories/release.md']])
    expect(found.find((c) => c.name === 'release-api')).toMatchObject({ description: 'How api is released.', body: '## Tag\nTag from main.' })
  })
})

describe('the pass, its accounting', () => {
  const borrower = (sources: Record<string, string | null>, home?: string) =>
    new LessonBorrower({ store, sources, projects: () => [ws], machine: () => 'desk', now: () => NOW, ...(home ? { home } : {}) })

  it('reads only the stores it is given', () => {
    write(join(hermes, 'skills', 'h', 'SKILL.md'), skillMd('hermes-skill', 'From hermes.'))
    agentMarks('hermes-skill')
    write(join(codex, 'memories', 'skills', 'c', 'SKILL.md'), skillMd('codex-skill', 'From codex.'))
    expect(borrower({ hermesHome: null, claudeProjectsDir: null, codexHome: codex }).candidates().map((c) => c.name)).toEqual(['codex-skill'])
    expect(borrower({}).candidates()).toEqual([])
  })

  it('a candidate whose provenance the store refuses is counted as refused, not as known', () => {
    // The folder name travels as provenance: a name that switches a safety off is refused by the store's own guard.
    write(join(hermes, 'skills', '--no-verify', 'SKILL.md'), skillMd('commit-fast', 'Commit quickly.', 'Commit when the tests pass.'))
    agentMarks('commit-fast')
    const pass = borrower({ hermesHome: hermes })
    const result = pass.pass('tim')
    expect(result.added).toEqual([])
    expect(result.passed).toEqual({ refused: 1 })
    expect(store.list()).toEqual([])
  })

  it('a skip the journal lost is still remembered: never added again, counted as skipped', () => {
    write(join(codex, 'memories', 'skills', 'bump', 'SKILL.md'), skillMd('bump-version', 'Bump the version.'))
    const b = borrower({ codexHome: codex }, join(dir, 'home'))
    const [first] = b.pass('tim').added
    expect(store.skip(first!.id)).toMatchObject({ ok: true })
    rmSync(join(store.root, 'journal.jsonl'))
    expect(store.list()).toEqual([])
    const again = b.pass('tim')
    expect(again).toMatchObject({ added: [], considered: 1, passed: { skipped: 1 } })
    expect(store.pending()).toEqual([])
  })

  it('without a home, a candidate\'s home path is still redacted by its usual shape', () => {
    write(join(codex, 'memories', 'skills', 'paths', 'SKILL.md'), skillMd('paths', 'Paths.', 'Read /Users/someone/code/api/README.md first.'))
    const [added] = borrower({ codexHome: codex }).pass('tim').added
    expect(added!.body).toBe('Read ~/code/api/README.md first.')
  })

  it('a borrowed signal with nothing said carries only where it came from', () => {
    const signal = borrowSignal({ engine: 'hermes', source: 'skills/x/SKILL.md', project: null, projectName: null, name: 'x', description: '', body: 'b', modified: NOW }, 'desk', NOW)
    expect(signal.evidence).toEqual(['borrowed from hermes: skills/x/SKILL.md'])
    expect(signal.key).toBe(borrowSignal({ engine: 'hermes', source: 'skills/x/SKILL.md', project: null, projectName: null, name: 'y', description: 'other', body: 'c', modified: 1 }, 'm', 2).key)
  })
})
