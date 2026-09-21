import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanCodexTitle, codexThreadName, engineSessionTitle, namingTitle, resetCodexThreadNames } from './sessionTitle.js'

describe('namingTitle: the engine’s title, when it names the session', () => {
  const harness = { engine: 'claude', cwd: '/Users/example/harnesses/harness-43', defaultName: 'harness-43' }

  it('takes a conversation title as it is', () => {
    expect(namingTitle('Unitree Go2 squats and wave', harness)).toBe('Unitree Go2 squats and wave')
  })

  it('is no name while the title is only the engine, the folder or the default name', () => {
    for (const title of ['Claude Code', 'claude', 'CODEX', 'harness-43', 'Harness-43', '  ', '', null, undefined]) {
      expect(namingTitle(title, harness)).toBeNull()
    }
    expect(namingTitle('harness-43', { engine: 'claude', cwd: '/elsewhere/x', defaultName: 'harness-43' })).toBeNull()
    expect(namingTitle('project', { engine: 'claude', cwd: '/Users/example/project' })).toBeNull()
    expect(namingTitle('Something', {})).toBe('Something')
  })

  it('drops OpenCode’s and Kilo’s short-name prefix', () => {
    expect(namingTitle('OC | Greeting', { engine: 'opencode' })).toBe('Greeting')
    expect(namingTitle('Kilo | Refactor the parser', { engine: 'kilo' })).toBe('Refactor the parser')
    expect(namingTitle('OC | opencode', { engine: 'opencode' })).toBeNull()
  })

  it('reads a Codex title without its status words and folder', () => {
    const codex = { engine: 'codex', cwd: '/Users/example/harnesses/harness-36' }
    expect(namingTitle('Action Required | Build 555 LED flasher | harness-36', codex)).toBe('Build 555 LED flasher')
    expect(namingTitle('Build brick breaker game | harness-36', codex)).toBe('Build brick breaker game')
    expect(namingTitle('Working | harness-36', codex)).toBeNull()
    expect(namingTitle('codex | Ready', codex)).toBeNull()
  })
})

describe('cleanCodexTitle', () => {
  it('keeps every part that is not a status word, the banner, the app name or the folder', () => {
    expect(cleanCodexTitle('[ ! ] Action Required | Fix the flaky test | repo', '/src/repo')).toBe('Fix the flaky test')
    expect(cleanCodexTitle('[ . ] Action Required | Fix it', null)).toBe('Fix it')
    expect(cleanCodexTitle('Starting | Thinking | Waiting | Ready | Working', undefined)).toBe('')
    expect(cleanCodexTitle('Compare A | B options | main', '/src/other')).toBe('Compare A | B options | main')
  })
})

describe('codexThreadName: Codex’s own name for a thread', () => {
  let home: string
  const savedHome = process.env.CODEX_HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    resetCodexThreadNames()
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedHome
    resetCodexThreadNames()
  })
  const index = (lines: string[]) => writeFileSync(join(home, 'session_index.jsonl'), lines.join('\n') + '\n')

  it('reads the latest name for the session and skips torn or unnamed lines', () => {
    index([
      JSON.stringify({ id: 't1', thread_name: 'First name' }),
      '{"id":"t2","thread_na',
      JSON.stringify({ id: 't3', thread_name: '   ' }),
      JSON.stringify({ id: 't4' }),
      '',
      JSON.stringify({ id: 't1', thread_name: ' Renamed thread ' }),
    ])
    expect(codexThreadName('t1', home)).toBe('Renamed thread')
    expect(codexThreadName('t2', home)).toBeNull()
    expect(codexThreadName('t3', home)).toBeNull()
    expect(codexThreadName('t9', home)).toBeNull()
  })

  it('rereads the index only when it changes', () => {
    index([JSON.stringify({ id: 't1', thread_name: 'Before' })])
    expect(codexThreadName('t1', home)).toBe('Before')
    appendFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: 't1', thread_name: 'After /rename' }) + '\n')
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(home, 'session_index.jsonl'), later, later)
    expect(codexThreadName('t1', home)).toBe('After /rename')
  })

  it('uses CODEX_HOME when the agent has no profile folder, and is no name without a file or a session', () => {
    index([JSON.stringify({ id: 't1', thread_name: 'From the env home' })])
    process.env.CODEX_HOME = home
    expect(codexThreadName('t1')).toBe('From the env home')
    expect(codexThreadName(null, home)).toBeNull()
    expect(codexThreadName('t1', join(home, 'missing'))).toBeNull()
  })

  it('is no name when the index cannot be read', () => {
    mkdirSync(join(home, 'session_index.jsonl')) // stat succeeds, reading a directory fails
    expect(codexThreadName('t1', home)).toBeNull()
  })

  it('falls back to ~/.codex when neither the agent nor the environment names a Codex home', () => {
    const savedUserHome = process.env.HOME
    delete process.env.CODEX_HOME
    process.env.HOME = home
    try {
      mkdirSync(join(home, '.codex'))
      writeFileSync(join(home, '.codex', 'session_index.jsonl'), JSON.stringify({ id: 't1', thread_name: 'Default home' }) + '\n')
      expect(codexThreadName('t1')).toBe('Default home')
    } finally {
      process.env.HOME = savedUserHome
    }
  })
})

describe('engineSessionTitle: what the terminal sweep records', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'codex-home-')); resetCodexThreadNames() })
  afterEach(() => { rmSync(home, { recursive: true, force: true }); resetCodexThreadNames() })

  it('prefers Codex’s thread name, then the terminal title, for Codex; the terminal title for everyone else', () => {
    writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: 's1', thread_name: 'Design a cable clip' }) + '\n')
    expect(engineSessionTitle({ engine: 'codex', sessionId: 's1', codexHome: home }, 'Working | harness-40')).toBe('Design a cable clip')
    expect(engineSessionTitle({ engine: 'codex', sessionId: 's2', codexHome: home }, 'Working | harness-40')).toBe('Working | harness-40')
    expect(engineSessionTitle({ engine: 'codex', sessionId: 's2', codexHome: home }, undefined)).toBeNull()
    expect(engineSessionTitle({ engine: 'claude', sessionId: 's1', codexHome: home }, '✳ Plan the launch')).toBe('✳ Plan the launch')
  })
})
