import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeTrusts, codexTrusts, preTrustClaudeProject, preTrustCodexProject } from './claudeTrust.js'

describe('preTrustClaudeProject', () => {
  it('records trust for a new folder the way Claude Code does, keeping everything else', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 4, projects: { '/old': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } }))
    expect(preTrustClaudeProject('/Users/x/harnesses/harness-3', home)).toBe('trusted')
    const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(after.numStartups).toBe(4)
    expect(after.projects['/old']).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true })
    expect(after.projects['/Users/x/harnesses/harness-3']).toEqual({ allowedTools: [], hasTrustDialogAccepted: true })
    expect(preTrustClaudeProject('/Users/x/harnesses/harness-3', home)).toBe('already')
  })

  it('merges into an entry that exists without trust, and does nothing without Claude Code', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    expect(preTrustClaudeProject('/w', home)).toBe('skipped')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { '/w': { allowedTools: ['Read'], hasClaudeMdExternalIncludesApproved: false } } }))
    expect(preTrustClaudeProject('/w', home)).toBe('trusted')
    const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(after.projects['/w']).toEqual({ allowedTools: ['Read'], hasClaudeMdExternalIncludesApproved: false, hasTrustDialogAccepted: true })
    writeFileSync(join(home, '.claude.json'), '{not json')
    expect(preTrustClaudeProject('/w', home)).toBe('skipped')
  })

  it('starts the projects map when Claude Code has none yet, and a second call changes nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 1 }))
    expect(preTrustClaudeProject('/Users/example/harnesses/harness-1', home)).toBe('trusted')
    const once = readFileSync(join(home, '.claude.json'), 'utf8')
    expect(JSON.parse(once)).toEqual({ numStartups: 1, projects: { '/Users/example/harnesses/harness-1': { allowedTools: [], hasTrustDialogAccepted: true } } })
    expect(preTrustClaudeProject('/Users/example/harnesses/harness-1', home)).toBe('already')
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(once)
    // the atomic write leaves no temporary file behind
    expect(readdirSync(home)).toEqual(['.claude.json'])
  })

  it('leaves a file of any other shape byte for byte as it was', () => {
    // Writing trust into an array, over a non-object projects value, or by spreading a string entry
    // into an object would each rewrite something the person has; the answer is to not touch it.
    for (const text of ['[]', 'null', '42', '{"projects":[]}', '{"projects":"none"}', '{"projects":null}', '{"projects":{"/w":"yes"}}', '{"projects":{"/w":[true]}}']) {
      const home = mkdtempSync(join(tmpdir(), 'trust-'))
      writeFileSync(join(home, '.claude.json'), text)
      expect(preTrustClaudeProject('/w', home), text).toBe('skipped')
      expect(readFileSync(join(home, '.claude.json'), 'utf8'), text).toBe(text)
    }
  })

  it('writes through a symlinked ~/.claude.json instead of replacing the link', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    mkdirSync(join(home, 'dotfiles'))
    writeFileSync(join(home, 'dotfiles', 'claude.json'), JSON.stringify({ projects: {} }))
    symlinkSync(join(home, 'dotfiles', 'claude.json'), join(home, '.claude.json'))
    expect(preTrustClaudeProject('/Users/example/harnesses/harness-2', home)).toBe('trusted')
    expect(lstatSync(join(home, '.claude.json')).isSymbolicLink()).toBe(true)
    const target = JSON.parse(readFileSync(join(home, 'dotfiles', 'claude.json'), 'utf8'))
    expect(target.projects['/Users/example/harnesses/harness-2'].hasTrustDialogAccepted).toBe(true)
    expect(readdirSync(join(home, 'dotfiles'))).toEqual(['claude.json'])
  })
})

describe('preTrustCodexProject', () => {
  const codexHome = (config?: string): string => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    if (config !== undefined) {
      mkdirSync(join(home, '.codex'))
      writeFileSync(join(home, '.codex', 'config.toml'), config)
    }
    return home
  }
  const configOf = (home: string): string => readFileSync(join(home, '.codex', 'config.toml'), 'utf8')

  it('records Codex trust as a projects table, once, and only when Codex is here', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    expect(preTrustCodexProject('/w', join(home, '.codex'))).toBe('skipped')
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[projects."/old"]\ntrust_level = "trusted"\n')
    expect(preTrustCodexProject('/Users/x/harnesses/harness-3', join(home, '.codex'))).toBe('trusted')
    const after = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(after).toContain('model = "gpt-5"')
    expect(after).toContain('[projects."/old"]\ntrust_level = "trusted"')
    expect(after.endsWith('[projects."/Users/x/harnesses/harness-3"]\ntrust_level = "trusted"\n')).toBe(true)
    expect(preTrustCodexProject('/Users/x/harnesses/harness-3', join(home, '.codex'))).toBe('already')
  })

  it('is idempotent: a second call leaves the file byte for byte as the first left it', () => {
    const home = codexHome('model = "gpt-5"')
    expect(preTrustCodexProject('/Users/example/harnesses/harness-1', join(home, '.codex'))).toBe('trusted')
    const once = configOf(home)
    expect(once).toBe('model = "gpt-5"\n\n[projects."/Users/example/harnesses/harness-1"]\ntrust_level = "trusted"\n')
    expect(preTrustCodexProject('/Users/example/harnesses/harness-1', join(home, '.codex'))).toBe('already')
    expect(configOf(home)).toBe(once)
    expect(readdirSync(join(home, '.codex'))).toEqual(['config.toml'])
  })

  it('knows the folder under any quoting or spacing of its table header', () => {
    for (const header of [`[projects.'/Users/example/w']`, `[ projects . "/Users/example/w" ]`, `  [projects."/Users/\\u0065xample/w"]  # trusted by hand`]) {
      const text = `${header}\ntrust_level = "untrusted"\n`
      const home = codexHome(text)
      expect(preTrustCodexProject('/Users/example/w', join(home, '.codex')), header).toBe('already')
      expect(configOf(home), header).toBe(text)
    }
  })

  it('does not count a header that is only a comment', () => {
    const home = codexHome('# [projects."/Users/example/w"]\n')
    expect(preTrustCodexProject('/Users/example/w', join(home, '.codex'))).toBe('trusted')
    expect(configOf(home)).toBe('# [projects."/Users/example/w"]\n\n[projects."/Users/example/w"]\ntrust_level = "trusted"\n')
  })

  it('leaves a config alone when appending a table could make it one Codex refuses to load', () => {
    for (const text of [
      // an inline table, and dotted keys: a later [projects."…"] would redefine them
      'projects = { "/Users/example/old" = { trust_level = "trusted" } }\n',
      'projects."/Users/example/w".trust_level = "trusted"\n',
      '[projects]\n"/Users/example/w" = { trust_level = "trusted" }\n',
      // a key in an escape JSON cannot read: it might be this very folder
      '[projects."/Users/example/\\U0001F600"]\ntrust_level = "trusted"\n',
    ]) {
      const home = codexHome(text)
      expect(preTrustCodexProject('/Users/example/w', join(home, '.codex')), text).toBe('skipped')
      expect(configOf(home), text).toBe(text)
    }
  })

  it('writes a header TOML can read for a folder with a quote or a DEL in its name, and finds it again', () => {
    const cwd = '/Users/example/a"b\x7f'
    const home = codexHome('')
    expect(preTrustCodexProject(cwd, join(home, '.codex'))).toBe('trusted')
    expect(configOf(home)).toBe('\n\n[projects."/Users/example/a\\"b\\u007f"]\ntrust_level = "trusted"\n')
    expect(preTrustCodexProject(cwd, join(home, '.codex'))).toBe('already')
  })

  it('writes through a symlinked config.toml instead of replacing the link', () => {
    const home = codexHome()
    mkdirSync(join(home, 'dotfiles'))
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, 'dotfiles', 'codex.toml'), 'model = "gpt-5"\n')
    symlinkSync(join(home, 'dotfiles', 'codex.toml'), join(home, '.codex', 'config.toml'))
    expect(preTrustCodexProject('/Users/example/w', join(home, '.codex'))).toBe('trusted')
    expect(lstatSync(join(home, '.codex', 'config.toml')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(home, 'dotfiles', 'codex.toml'), 'utf8')).toContain('[projects."/Users/example/w"]')
  })
})

describe('whether a source repo is already trusted (a worktree inherits only that)', () => {
  it('reads Claude trust from the folder or a folder above it, as Claude Code does', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    expect(claudeTrusts('/work/repo', home)).toBe(false)
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {
      '/work/repo': { hasTrustDialogAccepted: true },
      '/work/other': { hasTrustDialogAccepted: false },
      '/code/': { hasTrustDialogAccepted: true },
    } }))
    expect(claudeTrusts('/work/repo', home)).toBe(true)
    expect(claudeTrusts('/work/repo/sub', home)).toBe(true)
    expect(claudeTrusts('/code/anything', home)).toBe(true)
    expect(claudeTrusts('/work/other', home)).toBe(false)
    expect(claudeTrusts('/work/repo-evil', home)).toBe(false) // a prefix of the name is not a parent
    writeFileSync(join(home, '.claude.json'), '{not json')
    expect(claudeTrusts('/work/repo', home)).toBe(false)
  })

  it('reads Codex trust from exactly that folder\'s table', () => {
    const home = mkdtempSync(join(tmpdir(), 'trust-'))
    expect(codexTrusts('/work/repo', join(home, '.codex'))).toBe(false)
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'),
      '[projects."/work/repo"]\ntrust_level = "trusted"\n\n[projects."/work/other"]\ntrust_level = "untrusted"\n')
    expect(codexTrusts('/work/repo', join(home, '.codex'))).toBe(true)
    expect(codexTrusts('/work/other', join(home, '.codex'))).toBe(false)
    expect(codexTrusts('/work', join(home, '.codex'))).toBe(false)
  })
})

// The trust an engine reads is in ITS config: Codex's in `<CODEX_HOME>/config.toml`, Claude Code's in
// `<CLAUDE_CONFIG_DIR or home>/.claude.json`. Both used to be read and written in the default places
// alone, so a Codex agent on its own profile, or a person who moved either home in their shell profile,
// got the engine's trust prompt in a folder Harness had just made, or had trust written to a file their
// engine never reads.
describe('the config each engine actually reads', () => {
  afterEach(() => { vi.unstubAllEnvs() })
  const temp = (): string => mkdtempSync(join(tmpdir(), 'trust-'))

  it('a Codex agent on its own profile is trusted in that profile\'s config.toml', () => {
    const profile = temp()
    writeFileSync(join(profile, 'config.toml'), 'model = "gpt-5"\n')
    expect(codexTrusts('/w', profile)).toBe(false)
    expect(preTrustCodexProject('/w', profile)).toBe('trusted')
    expect(readFileSync(join(profile, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n\n[projects."/w"]\ntrust_level = "trusted"\n')
    expect(codexTrusts('/w', profile)).toBe(true)
  })

  it('with no profile, Codex is trusted in the CODEX_HOME the person moved, never in ~/.codex', () => {
    const home = temp()
    const moved = temp()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), '')
    writeFileSync(join(moved, 'config.toml'), '')
    vi.stubEnv('HOME', home)
    vi.stubEnv('CODEX_HOME', moved)
    expect(preTrustCodexProject('/w')).toBe('trusted')
    expect(codexTrusts('/w')).toBe(true)
    expect(readFileSync(join(moved, 'config.toml'), 'utf8')).toContain('[projects."/w"]')
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('')
  })

  it('Claude Code is trusted in the .claude.json of the CLAUDE_CONFIG_DIR the person moved, as Claude Code reads it', () => {
    const home = temp()
    const moved = temp()
    writeFileSync(join(home, '.claude.json'), '{}')
    writeFileSync(join(moved, '.claude.json'), '{}')
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', moved)
    expect(preTrustClaudeProject('/w')).toBe('trusted')
    expect(claudeTrusts('/w')).toBe(true)
    expect(JSON.parse(readFileSync(join(moved, '.claude.json'), 'utf8')).projects['/w'].hasTrustDialogAccepted).toBe(true)
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{}')
    // Not moved: the home folder's, as before.
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    expect(preTrustClaudeProject('/v')).toBe('trusted')
    expect(claudeTrusts('/v')).toBe(true)
  })
})
