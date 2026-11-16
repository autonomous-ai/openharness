/**
 * The dial skill in a throwaway agent home each: written, checked and removed only as Harness's own, known by its
 * marker line, never over, through or instead of what the person put there. The person's ~/.claude and ~/.codex are
 * never touched.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DIAL_SKILL, DIAL_SKILL_DESCRIPTION, claudePluginEnabled, ownDirectory, removeSkill, skillHeld, skillsFolderOf, writeSkill } from './dialSkill.js'

const MARKER = '# Written by Harness. Turn off the agent in Harness Device to remove it.'
const uid = process.getuid!()

const cleanup: string[] = []
afterEach(() => {
  // Last first: a folder a test made read-only is opened again before its home is removed.
  for (const dir of cleanup.splice(0).reverse()) {
    if (existsSync(dir)) chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dial-home-'))
  cleanup.push(dir)
  return dir
}

/** A home with a real skills folder, resolved as the functions under test return it. */
function skillsAt(home = folder()): string {
  mkdirSync(join(home, 'skills'), { mode: 0o700 })
  return realpathSync(join(home, 'skills'))
}

/** [text] at the skill's path in [skills], as a person would put it there. */
function skillOf(skills: string, text: string): string {
  mkdirSync(join(skills, 'dial'), { recursive: true })
  const path = join(skills, 'dial', 'SKILL.md')
  writeFileSync(path, text)
  return path
}

function stamp(path: string): [number, number, number] {
  const info = lstatSync(path)
  return [info.ino, info.mode, info.mtimeMs]
}

describe('the dial skill', () => {
  // Unquoted, the description's `: ` ends the scalar and an engine skips the skill without a word.
  it('the skill\'s front matter is YAML a loader reads, with the marker', () => {
    const file = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(DIAL_SKILL)
    expect(file).not.toBeNull()
    expect(parse(file![1])).toEqual({ name: 'dial', description: DIAL_SKILL_DESCRIPTION })
    expect(DIAL_SKILL.split('\n')[3]).toBe(MARKER)
    expect(file![2]).toContain('\n    harness device notify "<what you need, in one line>"\n')
    expect(Buffer.byteLength(DIAL_SKILL)).toBeLessThanOrEqual(4096)
  })

  it('writes into an empty home, 0700 and 0600', () => {
    const home = folder()
    const skills = skillsFolderOf(home, true)
    expect(skills).toBe(realpathSync(join(home, 'skills')))
    expect(skillHeld(skills!)).toBe('none')
    expect(writeSkill(skills!)).toBe('written')
    const path = join(skills!, 'dial', 'SKILL.md')
    expect(readFileSync(path, 'utf8')).toBe(DIAL_SKILL)
    expect(statSync(skills!).mode & 0o777).toBe(0o700)
    expect(statSync(join(skills!, 'dial')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // The temp file it wrote first is gone.
    expect(readdirSync(join(skills!, 'dial'))).toEqual(['SKILL.md'])
    expect(skillHeld(skills!)).toBe('ours')
    const inode = statSync(path).ino
    expect(writeSkill(skills!)).toBe('same')
    expect(statSync(path).ino).toBe(inode)
  })

  it('writes over ours with older bytes', () => {
    // The marker is Harness's wherever it sits in the front matter.
    for (const older of [
      `---\nname: dial\ndescription: older\n${MARKER}\n---\n\nOlder.\n`,
      `---\n${MARKER}\nname: dial\n---\n`,
    ]) {
      const skills = skillsAt()
      const path = skillOf(skills, older)
      expect(skillHeld(skills), older).toBe('ours')
      expect(writeSkill(skills), older).toBe('written')
      expect(readFileSync(path, 'utf8'), older).toBe(DIAL_SKILL)
      expect(readdirSync(join(skills, 'dial')), older).toEqual(['SKILL.md'])
    }
  })

  it('leaves the person\'s file', () => {
    const cases: Array<[string, (skills: string) => string]> = [
      ['no marker', (skills) => skillOf(skills, '---\nname: dial\ndescription: mine\n---\n\nMine.\n')],
      ['the marker only in the body', (skills) => skillOf(skills, `---\nname: dial\ndescription: mine\n---\n\n${MARKER}\n`)],
      ['a CRLF copy', (skills) => skillOf(skills, DIAL_SKILL.replaceAll('\n', '\r\n'))],
      ['a link to a file of exactly the skill', (skills) => {
        const target = join(folder(), 'SKILL.md')
        writeFileSync(target, DIAL_SKILL)
        mkdirSync(join(skills, 'dial'))
        symlinkSync(target, join(skills, 'dial', 'SKILL.md'))
        return join(skills, 'dial', 'SKILL.md')
      }],
      ['a FIFO', (skills) => {
        mkdirSync(join(skills, 'dial'))
        execFileSync('mkfifo', [join(skills, 'dial', 'SKILL.md')])
        return join(skills, 'dial', 'SKILL.md')
      }],
      ['a marked file over 4 KiB', (skills) => skillOf(skills, DIAL_SKILL + 'x'.repeat(4096))],
      ['a folder at SKILL.md', (skills) => {
        mkdirSync(join(skills, 'dial', 'SKILL.md'), { recursive: true })
        return join(skills, 'dial', 'SKILL.md')
      }],
      ['a dial that is a link to a folder', (skills) => {
        symlinkSync(folder(), join(skills, 'dial'))
        return join(skills, 'dial')
      }],
      ['a dial that is a file', (skills) => {
        writeFileSync(join(skills, 'dial'), 'mine')
        return join(skills, 'dial')
      }],
    ]
    for (const [what, place] of cases) {
      const skills = skillsAt()
      const path = place(skills)
      const before = stamp(path)
      const isFile = lstatSync(path).isFile()
      const text = isFile ? readFileSync(path, 'utf8') : null
      const linked = lstatSync(path).isSymbolicLink() ? realpathSync(path) : null
      const inLink = linked && statSync(linked).isDirectory() ? readdirSync(linked) : null
      const siblings = readdirSync(skills)
      expect(skillHeld(skills), what).toBe('theirs')
      expect(writeSkill(skills), what).toBe('theirs')
      expect(removeSkill(skills), what).toBe('theirs')
      expect(stamp(path), what).toEqual(before)
      if (text !== null) expect(readFileSync(path, 'utf8'), what).toBe(text)
      if (linked && !inLink) expect(readFileSync(linked, 'utf8'), what).toBe(DIAL_SKILL)
      if (inLink) expect(readdirSync(linked!), what).toEqual(inLink)
      expect(readdirSync(skills), what).toEqual(siblings)
    }
  })

  it('removes only ours, then the empty dial folder, never skills', () => {
    const skills = skillsAt()
    const sibling = join(skills, 'other', 'SKILL.md')
    mkdirSync(join(skills, 'other'))
    writeFileSync(sibling, 'mine')
    expect(writeSkill(skills)).toBe('written')
    expect(removeSkill(skills)).toBe('removed')
    expect(readdirSync(skills)).toEqual(['other'])
    expect(readFileSync(sibling, 'utf8')).toBe('mine')
    expect(skillHeld(skills)).toBe('none')

    // Left empty, `skills` is still the person's agent folder: it stays.
    const alone = skillsAt()
    writeSkill(alone)
    expect(removeSkill(alone)).toBe('removed')
    expect(readdirSync(alone)).toEqual([])

    const withNotes = skillsAt()
    writeSkill(withNotes)
    writeFileSync(join(withNotes, 'dial', 'notes.md'), 'mine')
    expect(removeSkill(withNotes)).toBe('removed')
    expect(readdirSync(join(withNotes, 'dial'))).toEqual(['notes.md'])

    const empty = skillsAt()
    expect(removeSkill(empty)).toBe('none')
    expect(readdirSync(empty)).toEqual([])
  })

  it('a linked skills folder is followed, and two homes linked to one folder are one', () => {
    const shared = folder()
    const [first, second] = [folder(), folder()]
    symlinkSync(shared, join(first, 'skills'))
    symlinkSync(shared, join(second, 'skills'))
    const skills = skillsFolderOf(first, false)
    expect(skills).toBe(realpathSync(shared))
    expect(skillsFolderOf(second, false)).toBe(skills)
    expect(writeSkill(skills!)).toBe('written')
    expect(readFileSync(join(shared, 'dial', 'SKILL.md'), 'utf8')).toBe(DIAL_SKILL)
    expect(skillHeld(skillsFolderOf(second, true)!)).toBe('ours')
  })

  it('a skills folder that is not this user\'s directory is refused', () => {
    const file = folder()
    writeFileSync(join(file, 'skills'), 'mine')
    const dangling = folder()
    const gone = join(folder(), 'gone')
    symlinkSync(gone, join(dangling, 'skills'))
    const toFile = folder()
    const target = join(folder(), 'target')
    writeFileSync(target, 'mine')
    symlinkSync(target, join(toFile, 'skills'))
    for (const [what, home] of [['a file', file], ['a dangling link', dangling], ['a link to a file', toFile]]) {
      for (const make of [false, true]) {
        expect(skillsFolderOf(home, make), what).toBeNull()
        expect(readdirSync(home), what).toEqual(['skills'])
      }
    }
    expect(existsSync(gone)).toBe(false)
    expect(readFileSync(join(file, 'skills'), 'utf8')).toBe('mine')

    const other = folder()
    const skills = skillsAt(other)
    expect(skillsFolderOf(other, true, uid + 1)).toBeNull()
    expect(readdirSync(skills)).toEqual([])

    expect(ownDirectory(skills)).toBe('ok')
    expect(ownDirectory(skills, uid + 1)).toBe('owner')
    expect(ownDirectory(join(file, 'skills'))).toBe('missing')
    expect(ownDirectory(join(dangling, 'skills'))).toBe('missing')
    expect(ownDirectory(join(other, 'nothing'))).toBe('missing')
  })

  it('a missing home', () => {
    const parent = folder()
    const home = join(parent, 'agent', 'home')
    expect(skillsFolderOf(home, false)).toBeNull()
    expect(readdirSync(parent)).toEqual([])
    const skills = skillsFolderOf(home, true)
    expect(skills).toBe(realpathSync(join(home, 'skills')))
    expect(statSync(skills!).isDirectory()).toBe(true)
    expect(statSync(skills!).mode & 0o777).toBe(0o700)
    expect(readdirSync(skills!)).toEqual([])
  })

  it('a write or a removal that fails says failed', () => {
    // No dial folder can be made.
    const shut = skillsAt()
    chmodSync(shut, 0o500)
    cleanup.push(shut)
    expect(writeSkill(shut)).toBe('failed')
    expect(readdirSync(shut)).toEqual([])

    // No file can be made in the dial folder.
    const empty = skillsAt()
    mkdirSync(join(empty, 'dial'))
    chmodSync(join(empty, 'dial'), 0o500)
    cleanup.push(join(empty, 'dial'))
    expect(writeSkill(empty)).toBe('failed')
    expect(readdirSync(join(empty, 'dial'))).toEqual([])

    const older = skillsAt()
    const path = skillOf(older, `---\nname: dial\n${MARKER}\n---\n`)
    chmodSync(join(older, 'dial'), 0o500)
    cleanup.push(join(older, 'dial'))
    expect(writeSkill(older)).toBe('failed')
    expect(readFileSync(path, 'utf8')).toBe(`---\nname: dial\n${MARKER}\n---\n`)
    expect(readdirSync(join(older, 'dial'))).toEqual(['SKILL.md'])

    const held = skillsAt()
    writeSkill(held)
    chmodSync(join(held, 'dial'), 0o500)
    cleanup.push(join(held, 'dial'))
    expect(removeSkill(held)).toBe('failed')
    expect(skillHeld(held)).toBe('ours')
  })

  it('claudePluginEnabled', () => {
    const dir = folder()
    const at = (name: string, text: string): string => {
      writeFileSync(join(dir, name), text)
      return join(dir, name)
    }
    expect(claudePluginEnabled(at('on.json', '{"enabledPlugins":{"harness-device@openharness":true}}'))).toBe(true)
    expect(claudePluginEnabled(at('beside.json', '{"model":"opus","enabledPlugins":{"other@x":false,"harness-device@openharness":true}}'))).toBe(true)

    mkdirSync(join(dir, 'folder.json'))
    execFileSync('mkfifo', [join(dir, 'fifo.json')])
    const off: Array<[string, string]> = [
      ['a missing file', join(dir, 'missing.json')],
      ['bad JSON', at('bad.json', '{"enabledPlugins":{"harness-device@openharness":tr')],
      ['an array', at('array.json', '[{"enabledPlugins":{"harness-device@openharness":true}}]')],
      ['null', at('null.json', 'null')],
      ['the entry false', at('false.json', '{"enabledPlugins":{"harness-device@openharness":false}}')],
      ['the entry absent', at('absent.json', '{"enabledPlugins":{"other@x":true}}')],
      ['no plugins', at('none.json', '{}')],
      ['the entry "true"', at('string.json', '{"enabledPlugins":{"harness-device@openharness":"true"}}')],
      ['a file over 1 MiB', at('big.json', '{"enabledPlugins":{"harness-device@openharness":true}}' + ' '.repeat(1024 * 1024))],
      ['a folder', join(dir, 'folder.json')],
      ['a FIFO', join(dir, 'fifo.json')],
    ]
    for (const [what, path] of off) expect(claudePluginEnabled(path), what).toBe(false)
  })

  it('it imports only node modules', () => {
    const source = readFileSync(new URL('./dialSkill.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) expect(specifier.startsWith('node:'), specifier).toBe(true)
  })
})
