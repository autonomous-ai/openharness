import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { adoptEngineHomes, claudeProjectsRoots, codexHomeRoots, launchClaudeConfigDir, launchCodexHome, movedEngineHomes, resetEngineHomes, sessionClaudeHome, sessionCodexHome } from './engineHomes.js'

// The login shell's environment, as the daemon captured it at start-up: none, unless a test says so.
const shell = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => shell.env }))

const saved = () => join(env.ADAPTER_DATA_DIR, 'engine-homes.json')
const defaults = { claudeHome: '/home/someone/.claude', codexHome: '/home/someone/.codex' }

describe('the homes the person moved', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'engine-homes-'))
    rmSync(saved(), { force: true })
    resetEngineHomes()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(saved(), { force: true })
    resetEngineHomes()
  })

  it('adopts each absolute home that is not the daemon\'s own, once, beside the defaults', () => {
    const claude = join(root, 'claude-work'), codex = join(root, 'codex-work')
    expect(adoptEngineHomes({ CLAUDE_CONFIG_DIR: claude, CODEX_HOME: `${codex}/` }, defaults)).toEqual({ claude, codex })
    // The same environment again moves nothing new.
    expect(adoptEngineHomes({ CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex }, defaults)).toEqual({ claude: null, codex: null })
    expect(claudeProjectsRoots('/own/projects')).toEqual(['/own/projects', join(claude, 'projects')])
    expect(codexHomeRoots('/own/codex')).toEqual(['/own/codex', codex])
    expect(movedEngineHomes()).toEqual({ claude: [claude], codex: [codex] })
  })

  it('takes no relative, `~`, empty or unset path, and not the daemon\'s own home', () => {
    for (const value of ['work/.claude', '~/.claude-work', '   ', undefined]) {
      expect(adoptEngineHomes({ CLAUDE_CONFIG_DIR: value, CODEX_HOME: value }, defaults)).toEqual({ claude: null, codex: null })
    }
    expect(adoptEngineHomes({ CLAUDE_CONFIG_DIR: '/home/someone/.claude/', CODEX_HOME: defaults.codexHome }, defaults)).toEqual({ claude: null, codex: null })
    expect(movedEngineHomes()).toEqual({ claude: [], codex: [] })
    expect(existsSync(saved())).toBe(false)
  })

  // The login shell is read after the registry checks the saved agents' transcripts: a home known only
  // from this boot's shell lost every agent bound in it at each restart.
  it('remembers what it adopted in the data folder, and knows it on the next boot before any root is asked for', () => {
    const claude = join(root, 'claude-work'), codex = join(root, 'codex-work')
    adoptEngineHomes({ CLAUDE_CONFIG_DIR: claude }, defaults)
    adoptEngineHomes({ CODEX_HOME: codex }, defaults)
    expect(JSON.parse(readFileSync(saved(), 'utf8'))).toEqual({ claude: [claude], codex: [codex] })
    resetEngineHomes()
    expect(claudeProjectsRoots('/own')).toEqual(['/own', join(claude, 'projects')])
    resetEngineHomes()
    expect(codexHomeRoots('/own')).toEqual(['/own', codex])
  })

  it('reads past a malformed or foreign file: only absolute paths it has not read already', () => {
    writeFileSync(saved(), JSON.stringify({ claude: ['/a/claude', 'relative', 7, '/a/claude'], codex: 'not a list' }))
    expect(movedEngineHomes()).toEqual({ claude: ['/a/claude'], codex: [] })
    resetEngineHomes()
    writeFileSync(saved(), '{ not json')
    expect(movedEngineHomes()).toEqual({ claude: [], codex: [] })
  })

  it('refreshes a previously read home list when another process adopts a new login', () => {
    writeFileSync(saved(), JSON.stringify({ codex: [join(root, 'previous')] }))
    expect(codexHomeRoots('/default')).toEqual(['/default', join(root, 'previous')])
    writeFileSync(saved(), JSON.stringify({ codex: [join(root, 'previous'), join(root, 'new-login')] }))
    expect(codexHomeRoots('/default')).toEqual(['/default', join(root, 'previous'), join(root, 'new-login')])
    rmSync(saved())
    expect(codexHomeRoots('/default')).toEqual(['/default', join(root, 'previous'), join(root, 'new-login')])
  })

  it('still adopts when the data folder cannot be written; the next boot adopts again', () => {
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'a file where the folder should be')
    const before = env.ADAPTER_DATA_DIR
    env.ADAPTER_DATA_DIR = join(blocked, 'data')
    try {
      const claude = join(root, 'claude-work')
      expect(adoptEngineHomes({ CLAUDE_CONFIG_DIR: claude }, defaults)).toEqual({ claude, codex: null })
      expect(claudeProjectsRoots('/own')).toEqual(['/own', join(claude, 'projects')])
    } finally {
      env.ADAPTER_DATA_DIR = before
    }
    mkdirSync(root, { recursive: true })
  })

  it('a bound conversation stays in its known home even when the current shell changes or a service has no shell cache', () => {
    const home = join(root, 'previous-login'), current = join(root, 'current-login')
    adoptEngineHomes({ CODEX_HOME: home }, defaults)
    shell.env = { CODEX_HOME: current }
    try {
      for (const folder of ['sessions', 'archived_sessions']) {
        const transcriptPath = join(home, folder, 'thread.jsonl')
        expect(sessionCodexHome({ transcriptPath })).toBe(home)
        expect(sessionCodexHome({ transcriptPath, codexHome: '/explicit-profile' })).toBe('/explicit-profile')
      }
      expect(sessionCodexHome({ transcriptPath: join(home, 'sessions-other', 'thread.jsonl') })).toBe(current)
      expect(sessionCodexHome({ transcriptPath: join(home, '..', 'elsewhere', 'thread.jsonl') })).toBe(current)
      shell.env = {}
      expect(sessionCodexHome({ transcriptPath: join(home, 'sessions', 'thread.jsonl') })).toBe(home)
    } finally { shell.env = {} }
  })

  it('Claude settings follow the bound home or current shell, with the settings default separate from folder trust', () => {
    const previous = join(root, 'previous-claude'), current = join(root, 'current-claude')
    adoptEngineHomes({ CLAUDE_CONFIG_DIR: previous }, defaults)
    shell.env = { CLAUDE_CONFIG_DIR: current }
    try {
      expect(sessionClaudeHome({})).toBe(current)
      expect(sessionClaudeHome({ transcriptPath: join(previous, 'projects', 'workspace', 'thread.jsonl') })).toBe(previous)
      expect(sessionClaudeHome({ transcriptPath: join(previous, 'projects-other', 'thread.jsonl') })).toBe(current)
      expect(sessionClaudeHome({ transcriptPath: join(previous, 'projects', '..', '..', 'thread.jsonl') })).toBe(current)
      shell.env = {}
      expect(sessionClaudeHome({ transcriptPath: join(previous, 'projects', 'workspace', 'thread.jsonl') })).toBe(previous)
      expect(sessionClaudeHome({})).toBe(dirname(env.CLAUDE_PROJECTS_DIR))
    } finally { shell.env = {} }
  })
})

// The home an agent launched now writes in, for what has to be in that engine's own config before it
// starts (its folder trust): the pane runs through the person's login shell, so the home that shell
// moves is the engine's, over the daemon's own environment; an agent's own Codex profile outranks both.
describe('the home an engine launched now uses', () => {
  afterEach(() => { shell.env = {}; vi.unstubAllEnvs() })

  it('Codex: the agent\'s own profile, else the CODEX_HOME the environment moves, else the daemon\'s', () => {
    expect(launchCodexHome('/profiles/work', { CODEX_HOME: '/moved' })).toBe('/profiles/work')
    expect(launchCodexHome(null, { CODEX_HOME: '/moved/' })).toBe('/moved')
    expect(launchCodexHome(undefined, {})).toBe(env.CODEX_HOME)
    // A relative or `~` path is not one the engine resolves the same way from every folder.
    expect(launchCodexHome(null, { CODEX_HOME: '~/codex' })).toBe(env.CODEX_HOME)
    expect(launchCodexHome(null, { CODEX_HOME: '  ' })).toBe(env.CODEX_HOME)
  })

  it('Claude Code: the CLAUDE_CONFIG_DIR the environment moves, else the home folder, as Claude Code resolves .claude.json', () => {
    expect(launchClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/claude-work' })).toBe('/claude-work')
    expect(launchClaudeConfigDir({ CLAUDE_CONFIG_DIR: 'relative' })).toBe(homedir())
    expect(launchClaudeConfigDir({})).toBe(homedir())
  })

  it('reads the login shell\'s environment over the daemon\'s own: the profile is what the pane runs', () => {
    vi.stubEnv('CODEX_HOME', '/daemon-codex')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/daemon-claude')
    expect(launchCodexHome(null)).toBe('/daemon-codex')
    expect(launchClaudeConfigDir()).toBe('/daemon-claude')
    shell.env = { CODEX_HOME: '/profile-codex', CLAUDE_CONFIG_DIR: '/profile-claude' }
    expect(launchCodexHome(null)).toBe('/profile-codex')
    expect(launchClaudeConfigDir()).toBe('/profile-claude')
  })
})
