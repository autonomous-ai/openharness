import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { adoptEngineHomes, claudeProjectsRoots, codexHomeRoots, movedEngineHomes, resetEngineHomes } from './engineHomes.js'

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
})
