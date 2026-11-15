import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanCodexTitle, cleanOmpTitle, codexThreadName, engineSessionTitle, namingTitle, ompSessionTitle, resetCodexThreadNames } from './sessionTitle.js'

// The real filesystem, with exports a case can watch: how much of an index is read.
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

/** The bytes read from files while `run` runs, whole or in part. */
function bytesRead(run: () => void): number {
  let bytes = 0
  const whole = fs.readFileSync, part = fs.readSync
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const read = whole(...args)
    bytes += read.length
    return read
  }) as typeof fs.readFileSync)
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const read = part(...args)
    bytes += read
    return read
  }) as typeof fs.readSync)
  try { run() } finally { vi.restoreAllMocks() }
  return bytes
}

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

  it.each([
    'renaming',
    'renaming...',
    'Renaming…',
    'renaming... ⠹',
    'renaming... ⠴',
    'renaming… ⠦',
    'renaming ⠋',
    'Working... ⠹',
    '[ ! ] Action Required…',
    'renaming... ⠹ | golden-koala',
  ])('ignores the temporary Codex status %s', (title) => {
    expect(namingTitle(title, { engine: 'codex', cwd: '/src/golden-koala' })).toBeNull()
  })

  it('keeps conversation titles about renaming and strips only the separate status', () => {
    const codex = { engine: 'codex', cwd: '/src/golden-koala' }
    expect(namingTitle('Renaming branches safely', codex)).toBe('Renaming branches safely')
    expect(namingTitle('Working with multiple machines', codex)).toBe('Working with multiple machines')
    expect(namingTitle('renaming... ⠹ | Improve multiple-machine experience | golden-koala', codex))
      .toBe('Improve multiple-machine experience')
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

  // Asked of every Codex session at each terminal sweep: read whole, an index grows with every thread ever named.
  it('reads a long index from its end, then only what Codex appends', () => {
    const line = (id: string, name: string) => JSON.stringify({ id, thread_name: name }) + '\n'
    let text = line('t-first', 'Named long ago')
    for (let i = 0; text.length < 2 * 1024 * 1024; i++) text += line(`t${i}`, `Thread number ${i}`)
    text += line('t-last', 'Named just now')
    writeFileSync(join(home, 'session_index.jsonl'), text)
    let name: string | null = null
    expect(bytesRead(() => { name = codexThreadName('t-last', home) })).toBeLessThanOrEqual(1024 * 1024)
    expect(name).toBe('Named just now')
    // Older than the end it read: no name from the index (the registry keeps the one it was given then).
    expect(bytesRead(() => { name = codexThreadName('t-first', home) })).toBe(0)
    expect(name).toBeNull()
    const renamed = line('t-first', 'After /rename')
    appendFileSync(join(home, 'session_index.jsonl'), renamed)
    expect(bytesRead(() => { name = codexThreadName('t-first', home) })).toBe(renamed.length)
    expect(name).toBe('After /rename')
    // A name being written, with no newline yet, is taken now and read again once whole.
    appendFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: 't-new', thread_name: 'Half' }))
    expect(codexThreadName('t-new', home)).toBe('Half')
    appendFileSync(join(home, 'session_index.jsonl'), '\n' + line('t-new', 'Whole'))
    expect(codexThreadName('t-new', home)).toBe('Whole')
    // Rewritten rather than appended to, it is read again from its end.
    writeFileSync(join(home, 'session_index.jsonl'), line('t-last', 'Rewritten'))
    expect(codexThreadName('t-last', home)).toBe('Rewritten')
    expect(codexThreadName('t-new', home)).toBeNull()
  })

  it('keeps each Codex home it reads, so agents in two homes do not read both again at every sweep', () => {
    const other = mkdtempSync(join(tmpdir(), 'codex-home-'))
    try {
      index([JSON.stringify({ id: 't1', thread_name: 'In the first home' })])
      writeFileSync(join(other, 'session_index.jsonl'), JSON.stringify({ id: 't2', thread_name: 'In the second home' }) + '\n')
      expect(codexThreadName('t1', home)).toBe('In the first home')
      expect(codexThreadName('t2', other)).toBe('In the second home')
      expect(bytesRead(() => {
        for (let sweep = 0; sweep < 3; sweep++) {
          expect(codexThreadName('t1', home)).toBe('In the first home')
          expect(codexThreadName('t2', other)).toBe('In the second home')
        }
      })).toBe(0)
    } finally { rmSync(other, { recursive: true, force: true }) }
  })

  it('is no name when the index cannot be read', () => {
    mkdirSync(join(home, 'session_index.jsonl')) // stat succeeds, reading a directory fails
    expect(codexThreadName('t1', home)).toBeNull()
  })

  it('falls back to ~/.codex when neither the agent nor the environment names a Codex home', async () => {
    const savedUserHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    delete process.env.CODEX_HOME
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      mkdirSync(join(home, '.codex'))
      writeFileSync(join(home, '.codex', 'session_index.jsonl'), JSON.stringify({ id: 't1', thread_name: 'Default home' }) + '\n')
      // Configuration is captured at process startup; give this fresh HOME a fresh config module too.
      vi.resetModules()
      const fresh = await import('./sessionTitle.js')
      expect(fresh.codexThreadName('t1')).toBe('Default home')
    } finally {
      process.env.HOME = savedUserHome
      if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile
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

describe('omp titles', () => {
  it('strips the π name, the status or spinner mark and the topic icon', () => {
    for (const raw of ['π ⠴ \u{F08F3} Login: Fix redirect', 'π ⠙ \u{F08F3} Login: Fix redirect', 'π > \u{F08F3} Login: Fix redirect', 'π * \u{F08F3} Login: Fix redirect', '\u{F08F3} Login: Fix redirect', 'Login: Fix redirect']) {
      expect(cleanOmpTitle(raw)).toBe('Login: Fix redirect')
    }
    expect(cleanOmpTitle('π ⠴ ')).toBeNull()
    expect(cleanOmpTitle('')).toBeNull()
  })

  it('reads the title line at the head of an omp session file, falling back to it without a terminal title', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-title-'))
    const file = join(dir, 's.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'title', v: 1, title: '\u{F08F3} Login: Fix the redirect loop', source: 'auto', pad: '   ' }) + '\n'
      + JSON.stringify({ type: 'session', id: 'x' }) + '\n')
    expect(ompSessionTitle(file)).toBe('Login: Fix the redirect loop')
    expect(ompSessionTitle(join(dir, 'missing.jsonl'))).toBeNull()
    expect(engineSessionTitle({ engine: 'omp', transcriptPath: file }, undefined)).toBe('Login: Fix the redirect loop')
    expect(engineSessionTitle({ engine: 'omp', transcriptPath: file }, 'π ⠋ Renamed topic')).toBe('Renamed topic')
    rmSync(dir, { recursive: true, force: true })
  })
})
