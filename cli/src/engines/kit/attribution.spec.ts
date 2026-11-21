/** Worker-owned instruction parsing preserves every user/workspace config boundary. */
import { describe, expect, it } from 'vitest'
import { launch as codex } from '../codex/launch.js'
import { instructionValueIn, type AttributionFiles } from './attribution.js'
import { topLevelEntry } from './launchArgs.js'
const LINE = 'An optional instruction.'
const codexContract = codex.harnessInstructions!.kind === 'config' ? codex.harnessInstructions!.config : (() => { throw Error('config contract required') })()
const CODEX_CONFIG = '/home/me/.codex/config.toml'
function filesOf(files: Record<string, string>, place: Partial<AttributionFiles> = {}): AttributionFiles & { asked: string[] } {
  const asked: string[] = []
  return { home: '/home/me/.codex', personal: '/home/me', cwd: '/home/me/code/app', ...place, asked,
    read: path => { asked.push(path); return files[path] ?? null } }
}
function codexInstructions(files: Record<string, string>, place: Partial<AttributionFiles> = {}): string | null {
  return instructionValueIn(codexContract, [{ text: LINE, mark: LINE }], filesOf(files, place))
}

describe('Codex: developer_instructions', () => {
  it('prepares the instruction where the person set none', () => { expect(codexInstructions({})).toBe(LINE) })

  it('keeps the person\'s own instructions first', () => {
    expect(codexInstructions({ [CODEX_CONFIG]: 'model = "gpt-5"\ndeveloper_instructions = "Be terse."\n' })).toBe(`Be terse.\n\n${LINE}`)
    expect(codexInstructions({ [CODEX_CONFIG]: "developer_instructions = 'Say \"done\".' # mine\n" })).toBe(`Say "done".\n\n${LINE}`)
    expect(codexInstructions({ [CODEX_CONFIG]: 'developer_instructions = ""\n' })).toBe(LINE)
    // A profile's own key is that profile's, not the top level's.
    expect(codexInstructions({ [CODEX_CONFIG]: '[profiles.work]\ndeveloper_instructions = "Work."\n' })).toBe(LINE)
  })

  it('adds nothing where it cannot keep the person\'s instructions exactly', () => {
    expect(codexInstructions({ [CODEX_CONFIG]: 'developer_instructions = """\nBe terse.\n"""\n' })).toBeNull()
    expect(codexInstructions({ [CODEX_CONFIG]: "developer_instructions = '''\nBe terse.\n'''\n" })).toBeNull()
    expect(codexInstructions({ [CODEX_CONFIG]: 'developer_instructions = "Line one\\nline two"\n' })).toBeNull()
    expect(codexInstructions({ [CODEX_CONFIG]: 'developer_instructions = 42\n' })).toBeNull()
  })

  it('adds nothing where a folder\'s own config sets them, which `-c` would replace', () => {
    expect(codexInstructions({ '/home/me/code/app/.codex/config.toml': 'developer_instructions = "Project rules."\n' })).toBeNull()
    expect(codexInstructions({ '/home/me/code/.codex/config.toml': 'developer_instructions = """\nx\n"""\n' })).toBeNull()
    expect(codexInstructions({ '/home/me/code/app/.codex/config.toml': 'model = "gpt-5"\n' })).toBe(LINE)
  })

  it('looks for a folder\'s config up to the home folder, not in it, and past it for a folder outside it', () => {
    const inside = filesOf({}, { home: '/home/me/.codex' })
    instructionValueIn(codexContract, [{ text: LINE, mark: LINE }], inside)
    expect(inside.asked).toEqual(['/home/me/code/app/.codex/config.toml', '/home/me/code/.codex/config.toml', CODEX_CONFIG])
    const outside = filesOf({ '/srv/.codex/config.toml': 'developer_instructions = "srv"\n' }, { home: '/home/me/.codex', cwd: '/srv/app' })
    expect(instructionValueIn(codexContract, [{ text: LINE, mark: LINE }], outside)).toBeNull()
    expect(outside.asked).toEqual(['/srv/app/.codex/config.toml', '/srv/.codex/config.toml'])
    // A home moved into the project: its config is the person's own, read as theirs.
    const moved = filesOf({ '/home/me/code/app/.codex/config.toml': 'developer_instructions = "Mine."\n' }, { home: '/home/me/code/app/.codex' })
    expect(instructionValueIn(codexContract, [{ text: LINE, mark: LINE }], moved)).toBe(`Mine.\n\n${LINE}`)
    const nowhere = filesOf({}, { home: '/home/me/.codex', cwd: null })
    instructionValueIn(codexContract, [{ text: LINE, mark: LINE }], nowhere)
    expect(nowhere.asked).toEqual([CODEX_CONFIG])
  })

  it('adds the line once', () => {
    expect(codexInstructions({ [CODEX_CONFIG]: `developer_instructions = "Always end with ${LINE}"\n` })).toBeNull()
  })
})

describe('topLevelEntry', () => {
  it('absent, set or unreadable, at the top level only', () => {
    expect(topLevelEntry('', 'k')).toEqual({ state: 'absent' })
    expect(topLevelEntry('# k = "x"\nother = 1', 'k')).toEqual({ state: 'absent' })
    expect(topLevelEntry('[t]\nk = "x"', 'k')).toEqual({ state: 'absent' })
    expect(topLevelEntry('k="x"', 'k')).toEqual({ state: 'set', value: 'x' })
    expect(topLevelEntry("k = 'a # b' # c", 'k')).toEqual({ state: 'set', value: 'a # b' })
    expect(topLevelEntry('k = "a\\"b"', 'k')).toEqual({ state: 'unreadable' })
    expect(topLevelEntry('k = true', 'k')).toEqual({ state: 'unreadable' })
    // Another key that starts with the same letters is not it.
    expect(topLevelEntry('kk = "x"', 'k')).toEqual({ state: 'absent' })
  })
})
