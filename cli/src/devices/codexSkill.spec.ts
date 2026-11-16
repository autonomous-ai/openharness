/**
 * The dial skill in a throwaway Codex home each: written, read and removed only as Harness's own, never over or instead
 * of a skill the person made. The person's ~/.codex is never touched.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DIAL_SKILL, DIAL_SKILL_DESCRIPTION, codexDisable, codexEnable, codexSkillPath, codexStatus, type CodexSkillDeps } from './codexSkill.js'

const ALREADY = 'Codex already has a skill named dial that Harness did not write.'
const WRITE_FAILED = 'Could not write the Codex skill.'

const cleanup: string[] = []
afterEach(() => {
  // Last first: a folder a test made read-only is opened again before its home is removed.
  for (const dir of cleanup.splice(0).reverse()) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'))
  cleanup.push(dir)
  return dir
}

/** Codex on this Mac, its home a throwaway folder. */
function codexAt(home = folder()): CodexSkillDeps {
  return { home, installed: true, platform: 'darwin' }
}

/** [text] at the skill's path in [home], as a person would put it there. */
function skillOf(home: string, text: string): string {
  const path = codexSkillPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('the dial skill in Codex', () => {
  it('enable writes exactly the skill, once', () => {
    const codex = codexAt()
    expect(codexStatus(codex)).toEqual({ supported: true, installed: true, enabled: false })
    expect(codexEnable(codex)).toEqual({ ok: true })
    const path = codexSkillPath(codex.home)
    expect(path).toBe(join(codex.home, 'skills', 'dial', 'SKILL.md'))
    expect(readFileSync(path, 'utf8')).toBe(DIAL_SKILL)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    // The temp file it wrote first is gone.
    expect(readdirSync(dirname(path))).toEqual(['SKILL.md'])
    expect(codexStatus(codex)).toEqual({ supported: true, installed: true, enabled: true })
    const inode = statSync(path).ino
    expect(codexEnable(codex)).toEqual({ ok: true })
    expect(statSync(path).ino).toBe(inode)
  })

  // Written unquoted, the description's `: ` ends the scalar: Codex never loads the skill and says nothing.
  it('the skill\'s front matter is YAML a loader reads', () => {
    const file = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(DIAL_SKILL)
    expect(file).not.toBeNull()
    expect(parse(file![1])).toEqual({ name: 'dial', description: DIAL_SKILL_DESCRIPTION })
    expect(file![2]).toContain('\n    harness device notify "<what you need, in one line>"\n')
    expect(DIAL_SKILL).toMatch(/[^\n]\n$/)
  })

  it('disable removes exactly the skill', () => {
    const codex = codexAt()
    const sibling = join(codex.home, 'skills', 'other', 'SKILL.md')
    mkdirSync(dirname(sibling), { recursive: true })
    writeFileSync(sibling, 'mine')
    codexEnable(codex)
    expect(codexDisable(codex)).toEqual({ ok: true })
    expect(existsSync(join(codex.home, 'skills', 'dial'))).toBe(false)
    expect(readdirSync(join(codex.home, 'skills'))).toEqual(['other'])
    expect(readFileSync(sibling, 'utf8')).toBe('mine')
    expect(codexStatus(codex).enabled).toBe(false)

    // Left empty, `skills` is still the person's Codex folder: it stays.
    const alone = codexAt()
    codexEnable(alone)
    expect(codexDisable(alone)).toEqual({ ok: true })
    expect(readdirSync(join(alone.home, 'skills'))).toEqual([])

    const withNotes = codexAt()
    codexEnable(withNotes)
    writeFileSync(join(withNotes.home, 'skills', 'dial', 'notes.md'), 'mine')
    expect(codexDisable(withNotes)).toEqual({ ok: true })
    expect(readdirSync(join(withNotes.home, 'skills', 'dial'))).toEqual(['notes.md'])
  })

  it('a skill Harness did not write is left alone', () => {
    const linked = codexAt()
    // A link to a file of exactly the skill's text is still the person's.
    const target = join(folder(), 'SKILL.md')
    writeFileSync(target, DIAL_SKILL)
    mkdirSync(dirname(codexSkillPath(linked.home)), { recursive: true })
    symlinkSync(target, codexSkillPath(linked.home))
    const folded = codexAt()
    mkdirSync(codexSkillPath(folded.home), { recursive: true })
    const cases: Array<[string, CodexSkillDeps]> = [
      ['another text', codexAt()],
      ['an edited copy', codexAt()],
      ['a link', linked],
      ['a folder', folded],
    ]
    skillOf(cases[0][1].home, '---\nname: dial\ndescription: mine\n---\n\nMine.\n')
    skillOf(cases[1][1].home, DIAL_SKILL.replace('At most once', 'At most twice'))
    for (const [what, codex] of cases) {
      const path = codexSkillPath(codex.home)
      const before = lstatSync(path)
      const text = before.isDirectory() ? null : readFileSync(path, 'utf8')
      expect(codexEnable(codex), what).toEqual({ ok: false, error: ALREADY })
      expect(codexStatus(codex).enabled, what).toBe(false)
      expect(codexDisable(codex), what).toEqual({ ok: true })
      const after = lstatSync(path)
      expect([after.ino, after.mode, after.mtimeMs], what).toEqual([before.ino, before.mode, before.mtimeMs])
      if (text !== null) expect(readFileSync(path, 'utf8'), what).toBe(text)
    }
    expect(readFileSync(target, 'utf8')).toBe(DIAL_SKILL)
  })

  it('a home with no skills folder gets one; a skills that is a file is one error', () => {
    const fresh = codexAt(join(folder(), 'codex'))
    expect(codexEnable(fresh)).toEqual({ ok: true })
    expect(readFileSync(codexSkillPath(fresh.home), 'utf8')).toBe(DIAL_SKILL)

    const blocked = codexAt()
    writeFileSync(join(blocked.home, 'skills'), 'mine')
    expect(codexStatus(blocked).enabled).toBe(false)
    expect(codexEnable(blocked)).toEqual({ ok: false, error: WRITE_FAILED })
    expect(readFileSync(join(blocked.home, 'skills'), 'utf8')).toBe('mine')
    expect(readdirSync(blocked.home)).toEqual(['skills'])
    expect(codexDisable(blocked)).toEqual({ ok: true })
  })

  it('a skill that cannot be removed is an error, and stays on', () => {
    const codex = codexAt()
    codexEnable(codex)
    const dial = dirname(codexSkillPath(codex.home))
    chmodSync(dial, 0o500)
    cleanup.push(dial)
    expect(codexDisable(codex)).toEqual({ ok: false, error: 'Could not remove the Codex skill.' })
    expect(codexStatus(codex).enabled).toBe(true)
  })

  it('not on this computer, or on Windows', () => {
    const missing = { ...codexAt(), installed: false }
    expect(codexEnable(missing)).toEqual({ ok: false, error: 'Codex is not on this computer.' })
    expect(codexStatus(missing)).toEqual({ supported: true, installed: false, enabled: false })
    const windows: CodexSkillDeps = { ...codexAt(), platform: 'win32' }
    expect(codexEnable(windows)).toEqual({ ok: false, error: 'The dial reaches Codex on macOS and Linux.' })
    expect(codexStatus(windows)).toEqual({ supported: false, installed: true, enabled: false })
    expect(codexStatus({ ...codexAt(), platform: 'linux' }).supported).toBe(true)
    for (const codex of [missing, windows]) expect(readdirSync(codex.home)).toEqual([])
  })
})
