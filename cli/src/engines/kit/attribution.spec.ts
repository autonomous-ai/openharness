/**
 * The pull request line of a harness another agent started, as Claude Code's and Codex's launch contracts declare it
 * (claude/launch.ts, codex/launch.ts) and the kit applies it (kit/attribution.ts), composed as a launch asks for it
 * (launches.ts `attributionArgs`). The files are a map, never this machine's settings.
 *
 * What is worth pinning is where it must add NOTHING: the person hid the engine's attribution, or set a value that
 * the line would replace and that cannot be kept exactly.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstructionAttribution, SettingAttribution } from '../facets/launch.js'
import { launch as claude } from '../claude/launch.js'
import { launch as codex } from '../codex/launch.js'
import { attributionArgs } from '../launches.js'
import { attributionArgsIn, type AttributionFiles } from './attribution.js'
import { readConfig, topLevelEntry } from './launchArgs.js'

const shell = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }))
vi.mock('../../lib/loginShellEnv.js', () => ({ loginShellEnvironment: () => shell.env }))
afterEach(() => { shell.env = {} })

const LINE = '🤝 Started by another agent in [Harness](https://example.test) — test.'
const CLAUDE_OWN = '🤖 Generated with [Claude Code](https://claude.com/claude-code)'
const claudeContract = claude.attribution as SettingAttribution
const codexContract = codex.attribution as InstructionAttribution

/** The files a launch reads, by path; a path not in the map is absent. */
function filesOf(files: Record<string, string>, place: Partial<AttributionFiles> = {}): AttributionFiles & { asked: string[] } {
  const asked: string[] = []
  return {
    home: '/home/me/.claude', personal: '/home/me', cwd: '/home/me/code/app', ...place, asked,
    read: (path) => { asked.push(path); return files[path] ?? null },
  }
}

/** The `attribution.pr` a Claude Code launch is given, or null for no `--settings`. */
function claudePr(files: Record<string, string>, place: Partial<AttributionFiles> = {}): string | null {
  const args = attributionArgsIn(claudeContract, LINE, filesOf(files, place))
  if (!args.length) return null
  expect(args[0]).toBe('--settings')
  expect(args).toHaveLength(2)
  const settings = JSON.parse(args[1]!) as { attribution: Record<string, unknown> }
  // Only the pull request's text: the person's commit attribution is theirs, kept by the engine's merge.
  expect(Object.keys(settings)).toEqual(['attribution'])
  expect(Object.keys(settings.attribution)).toEqual(['pr'])
  return settings.attribution.pr as string
}

const USER = '/home/me/.claude/settings.json'
const PROJECT = '/home/me/code/app/.claude/settings.json'
const LOCAL = '/home/me/code/app/.claude/settings.local.json'
const json = (value: unknown): string => JSON.stringify(value)

describe('Claude Code: attribution.pr', () => {
  it('keeps Claude Code\'s own line first, then the line, where the person set nothing', () => {
    expect(claudePr({})).toBe(`${CLAUDE_OWN}\n${LINE}`)
    expect(claudePr({ [USER]: json({ hooks: {} }) })).toBe(`${CLAUDE_OWN}\n${LINE}`)
  })

  it('keeps the person\'s own pull request text, from whichever file wins', () => {
    expect(claudePr({ [USER]: json({ attribution: { pr: 'Made by me' } }) })).toBe(`Made by me\n${LINE}`)
    // Project over user, local over project, as Claude Code merges them.
    expect(claudePr({ [USER]: json({ attribution: { pr: 'user' } }), [PROJECT]: json({ attribution: { pr: 'project' } }) })).toBe(`project\n${LINE}`)
    expect(claudePr({ [PROJECT]: json({ attribution: { pr: 'project' } }), [LOCAL]: json({ attribution: { pr: 'local' } }) })).toBe(`local\n${LINE}`)
    // Merged key by key: a commit text in one file and nothing for pull requests elsewhere is still Claude's line.
    expect(claudePr({ [USER]: json({ attribution: { commit: 'Co-Authored-By: me' } }), [PROJECT]: json({ attribution: { sessionUrl: false } }) }))
      .toBe(`${CLAUDE_OWN}\n${LINE}`)
  })

  it('adds nothing where the person hid the attribution', () => {
    expect(claudePr({ [USER]: json({ attribution: false }) })).toBeNull()
    expect(claudePr({ [USER]: json({ attribution: { pr: '' } }) })).toBeNull()
    expect(claudePr({ [USER]: json({ attribution: { pr: 'user' } }), [LOCAL]: json({ attribution: { pr: '' } }) })).toBeNull()
    expect(claudePr({ [USER]: json({ attribution: { pr: 'user' } }), [PROJECT]: json({ attribution: false }) })).toBeNull()
  })

  it('adds nothing under the older includeCoAuthoredBy: false, which setting pr would end', () => {
    // Setting `pr` makes Claude Code ignore `includeCoAuthoredBy` and bring back its commit trailer.
    expect(claudePr({ [USER]: json({ includeCoAuthoredBy: false }) })).toBeNull()
    expect(claudePr({ [USER]: json({ includeCoAuthoredBy: false, attribution: { sessionUrl: false } }) })).toBeNull()
    // Once `attribution` names a commit or pull request text, Claude Code already ignores it.
    expect(claudePr({ [USER]: json({ includeCoAuthoredBy: false, attribution: { commit: '' } }) })).toBe(`${CLAUDE_OWN}\n${LINE}`)
    expect(claudePr({ [USER]: json({ includeCoAuthoredBy: false }), [PROJECT]: json({ attribution: { pr: 'p' } }) })).toBe(`p\n${LINE}`)
    expect(claudePr({ [USER]: json({ includeCoAuthoredBy: true }) })).toBe(`${CLAUDE_OWN}\n${LINE}`)
  })

  it('an object after false, a file that is not an object, and one that does not parse, as Claude Code reads them', () => {
    expect(claudePr({ [USER]: json({ attribution: false }), [PROJECT]: json({ attribution: { pr: 'back' } }) })).toBe(`back\n${LINE}`)
    expect(claudePr({ [USER]: '[1, 2]', [PROJECT]: '{ not json', [LOCAL]: 'null' })).toBe(`${CLAUDE_OWN}\n${LINE}`)
    expect(claudePr({ [USER]: json({ attribution: { pr: 42 } }) })).toBe(`${CLAUDE_OWN}\n${LINE}`)
  })

  it('adds the line once: text that already has it is left as it is', () => {
    expect(claudePr({ [USER]: json({ attribution: { pr: `Mine\n${LINE}` } }) })).toBeNull()
  })

  it('reads only the person\'s own settings for a harness with no folder', () => {
    const files = filesOf({ [USER]: json({ attribution: { pr: 'u' } }) }, { cwd: null })
    expect(attributionArgsIn(claudeContract, LINE, files)).toEqual(['--settings', json({ attribution: { pr: `u\n${LINE}` } })])
    expect(files.asked).toEqual([USER])
  })
})

const CODEX_CONFIG = '/home/me/.codex/config.toml'
const instructionOf = (line: string): string => codexContract.instruction.split('{line}').join(line)

/** The `developer_instructions` a Codex launch is given, or null for no `-c`. */
function codexInstructions(files: Record<string, string>, place: Partial<AttributionFiles> = {}): string | null {
  const args = attributionArgsIn(codexContract, LINE, filesOf(files, { home: '/home/me/.codex', ...place }))
  if (!args.length) return null
  expect(args[0]).toBe('-c')
  expect(args).toHaveLength(2)
  const [key, value] = [args[1]!.slice(0, args[1]!.indexOf('=')), args[1]!.slice(args[1]!.indexOf('=') + 1)]
  expect(key).toBe('developer_instructions')
  // A JSON string, which TOML reads as the same string.
  return JSON.parse(value) as string
}

describe('Codex: developer_instructions', () => {
  it('tells Codex to add the line to a pull request, as it is told its own', () => {
    expect(codexInstructions({})).toBe(instructionOf(LINE))
    expect(instructionOf(LINE)).toContain(`\`${LINE}\``)
    expect(instructionOf(LINE)).toContain('Do not add it to commit messages.')
  })

  it('keeps the person\'s own instructions first', () => {
    expect(codexInstructions({ [CODEX_CONFIG]: 'model = "gpt-5"\ndeveloper_instructions = "Be terse."\n' })).toBe(`Be terse.\n\n${instructionOf(LINE)}`)
    expect(codexInstructions({ [CODEX_CONFIG]: "developer_instructions = 'Say \"done\".' # mine\n" })).toBe(`Say "done".\n\n${instructionOf(LINE)}`)
    expect(codexInstructions({ [CODEX_CONFIG]: 'developer_instructions = ""\n' })).toBe(instructionOf(LINE))
    // A profile's own key is that profile's, not the top level's.
    expect(codexInstructions({ [CODEX_CONFIG]: '[profiles.work]\ndeveloper_instructions = "Work."\n' })).toBe(instructionOf(LINE))
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
    expect(codexInstructions({ '/home/me/code/app/.codex/config.toml': 'model = "gpt-5"\n' })).toBe(instructionOf(LINE))
  })

  it('looks for a folder\'s config up to the home folder, not in it, and past it for a folder outside it', () => {
    const inside = filesOf({}, { home: '/home/me/.codex' })
    attributionArgsIn(codexContract, LINE, inside)
    expect(inside.asked).toEqual(['/home/me/code/app/.codex/config.toml', '/home/me/code/.codex/config.toml', CODEX_CONFIG])
    const outside = filesOf({ '/srv/.codex/config.toml': 'developer_instructions = "srv"\n' }, { home: '/home/me/.codex', cwd: '/srv/app' })
    expect(attributionArgsIn(codexContract, LINE, outside)).toEqual([])
    expect(outside.asked).toEqual(['/srv/app/.codex/config.toml', '/srv/.codex/config.toml'])
    // A home moved into the project: its config is the person's own, read as theirs.
    const moved = filesOf({ '/home/me/code/app/.codex/config.toml': 'developer_instructions = "Mine."\n' }, { home: '/home/me/code/app/.codex' })
    expect(JSON.parse(attributionArgsIn(codexContract, LINE, moved)[1]!.split('=').slice(1).join('='))).toBe(`Mine.\n\n${instructionOf(LINE)}`)
    const nowhere = filesOf({}, { home: '/home/me/.codex', cwd: null })
    attributionArgsIn(codexContract, LINE, nowhere)
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

describe('attributionArgs, composed from the launch contracts', () => {
  it('nothing for an engine that declares no way to add the line', () => {
    expect(attributionArgs('opencode', LINE, { cwd: '/w', read: () => { throw new Error('read nothing') } })).toEqual([])
    expect(attributionArgs('terminal', LINE, { cwd: null })).toEqual([])
  })

  it('Claude Code\'s settings in the CLAUDE_CONFIG_DIR the launch sets, else ~/.claude', () => {
    const asked: string[] = []
    const read = (path: string): string | null => { asked.push(path); return null }
    attributionArgs('claude', LINE, { cwd: '/w', environment: { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg/claude' }, read })
    attributionArgs('claude', LINE, { cwd: null, environment: { HOME: '/home/me' }, read })
    // The daemon's launch environment when the launch has none of its own: the login shell's over the daemon's.
    shell.env = { HOME: '/home/shell', CLAUDE_CONFIG_DIR: '/shell/claude' }
    attributionArgs('claude', LINE, { cwd: null, read })
    expect(asked).toEqual(['/cfg/claude/settings.json', '/w/.claude/settings.json', '/w/.claude/settings.local.json',
      '/home/me/.claude/settings.json', '/shell/claude/settings.json'])
  })

  it('Codex\'s config in the agent\'s profile, else the CODEX_HOME the launch sets', () => {
    const asked: string[] = []
    const read = (path: string): string | null => { asked.push(path); return null }
    attributionArgs('codex', LINE, { cwd: null, profile: '/profiles/work', environment: { HOME: '/home/me', CODEX_HOME: '/moved' }, read })
    attributionArgs('codex', LINE, { cwd: null, environment: { HOME: '/home/me', CODEX_HOME: '/moved' }, read })
    expect(asked).toEqual(['/profiles/work/config.toml', '/moved/config.toml'])
  })

  // PowerShell 5's `Set-Content -Encoding utf8` saves settings.json with a BOM, which Claude Code reads past
  // (lib/settingsText.ts): the person's choice in it still holds.
  it('reads a settings file saved with a BOM as Claude Code does', () => {
    const home = mkdtempSync(join(tmpdir(), 'attribution-'))
    try {
      writeFileSync(join(home, 'settings.json'), `\uFEFF${json({ includeCoAuthoredBy: false })}`)
      expect(attributionArgsIn(claudeContract, LINE, { home, personal: home, cwd: null, read: readConfig })).toEqual([])
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('reads the real file when no reader is given', () => {
    const args = attributionArgs('claude', LINE, { cwd: null, environment: { HOME: '/nonexistent-home', CLAUDE_CONFIG_DIR: '/nonexistent-claude' } })
    expect(args).toEqual(['--settings', json({ attribution: { pr: `${CLAUDE_OWN}\n${LINE}` } })])
  })
})
