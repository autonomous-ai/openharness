import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InstalledDsh } from './installed.js'
import { parseDshManifest, readDshManifest } from './manifest.js'
import { materializeWorkspace, resolveDshCommand, skillDirsIn } from './materialize.js'

const STARTER = realpathSync(fileURLToPath(new URL('../../../store/starter', import.meta.url)))

function starter(engine: 'claude' | 'codex' = 'claude'): InstalledDsh {
  const manifest = readDshManifest(STARTER)
  if (!manifest.ok) throw new Error(manifest.error)
  return {
    id: manifest.manifest.id,
    dir: STARTER,
    realDir: STARTER,
    source: STARTER,
    ref: null,
    commit: null,
    linked: true,
    installedAt: 0,
    manifest: { ...manifest.manifest, engine },
  }
}

describe('materializeWorkspace', () => {
  let workspace: string
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'dsh-ws-')) })
  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it('prepares the workspace independently of the engine without publishing instructions or native skills', async () => {
    const result = await materializeWorkspace(starter(), workspace, {}, 'codex')
    expect(result.warnings).toEqual([])
    expect(readFileSync(join(workspace, 'NOTES.md'), 'utf8')).toContain('# Notes')
    expect(readFileSync(join(workspace, '.harness-initialized'), 'utf8')).toBe('initialized by autonomous/starter\n')
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(workspace, '.claude'))).toBe(false)
    expect(existsSync(join(workspace, '.agents'))).toBe(false)
    expect(existsSync(join(workspace, '.harness'))).toBe(true)
  })

  it('refuses a terminal before copying the template or running init', async () => {
    await expect(materializeWorkspace(starter(), workspace, {}, 'terminal')).rejects.toThrow('does not support terminal')
    expect(readdirSync(workspace)).toEqual([])
  })

  it('runs the init only once: a marked workspace is not re-initialized', async () => {
    await materializeWorkspace(starter(), workspace)
    rmSync(join(workspace, '.harness-initialized'))
    await materializeWorkspace(starter(), workspace)
    expect(existsSync(join(workspace, '.harness-initialized'))).toBe(false)
  })

  it('is idempotent and preserves all project instructions and native skills', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), '# Repo rules\n')
    writeFileSync(join(workspace, 'CLAUDE.md'), '# Claude rules\n')
    mkdirSync(join(workspace, '.claude/skills/hello'), { recursive: true })
    await materializeWorkspace(starter(), workspace)
    const again = await materializeWorkspace(starter(), workspace)
    expect(again.created).toEqual([])
    expect(again.kept).toEqual(['NOTES.md'])
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe('# Repo rules\n')
    expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')).toBe('# Claude rules\n')
    expect(lstatSync(join(workspace, '.claude/skills/hello')).isDirectory()).toBe(true)
  })
})

describe('skillDirsIn', () => {
  it('lists SKILL.md-bearing subdirectories, or the directory itself when it is one skill', () => {
    expect(skillDirsIn(join(STARTER, 'skills'))).toEqual([join(STARTER, 'skills', 'hello')])
    expect(skillDirsIn(join(STARTER, 'skills', 'hello'))).toEqual([join(STARTER, 'skills', 'hello')])
    expect(skillDirsIn(join(STARTER, 'template'))).toEqual([])
    expect(skillDirsIn('/nonexistent')).toEqual([])
  })
})

describe('resolveDshCommand', () => {
  it('turns a path inside the harness into a quoted absolute path and leaves shell lines alone', () => {
    expect(resolveDshCommand({ realDir: STARTER }, 'toolchain/init-workspace.sh')).toBe(`'${join(STARTER, 'toolchain', 'init-workspace.sh')}'`)
    expect(resolveDshCommand({ realDir: STARTER }, 'toolchain/missing.sh')).toBe('toolchain/missing.sh')
    expect(resolveDshCommand({ realDir: STARTER }, 'npm run viewer -- --port $HARNESS_VIEWER_PORT')).toBe('npm run viewer -- --port $HARNESS_VIEWER_PORT')
  })

  it('quotes an install path with a quote in it so the shell runs the script it names', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dsh-it's-")))
    try {
      writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho "ran $1"\n', { mode: 0o755 })
      const command = resolveDshCommand({ realDir: dir }, 'run.sh')
      expect(command).toBe(`'${join(dir, 'run.sh').replace(/'/g, `'\\''`)}'`)
      const { execFileSync } = await import('node:child_process')
      expect(execFileSync('/bin/sh', ['-c', `${command} ok`], { encoding: 'utf8' })).toBe('ran ok\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('materializeWorkspace, on harnesses other than the starter', () => {
  let root: string
  let harness: string
  let workspace: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mat-')))
    harness = join(root, 'harness')
    workspace = join(root, 'workspace')
    mkdirSync(harness)
    mkdirSync(workspace)
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  const install = (manifest: Record<string, unknown>, files: Record<string, string> = {}): InstalledDsh => {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(harness, name, '..'), { recursive: true })
      writeFileSync(join(harness, name), body, { mode: name.endsWith('.sh') ? 0o755 : 0o644 })
    }
    const read = parseDshManifest(JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing', ...manifest }))
    if (!read.ok) throw new Error(read.error)
    return { id: 'acme/thing', dir: harness, realDir: harness, source: harness, ref: null, commit: null, linked: true, installedAt: 0, manifest: read.manifest }
  }

  it('lays nothing out for a viewer package', async () => {
    const dsh = install({ kind: 'viewer', viewer: { command: 'v.sh', url: 'http://127.0.0.1:${port}/' } })
    const result = await materializeWorkspace(dsh, workspace)
    expect(result).toEqual({ created: [], kept: [], warnings: ['acme/thing is a viewer package; it has no workspace to lay out'], initLines: [] })
    expect(readdirSync(workspace)).toEqual([])
  })

  it('a harness with no workspace, instructions or skills gets only .harness/', async () => {
    const result = await materializeWorkspace(install({ engine: 'codex' }), workspace)
    expect(result).toEqual({ created: [], kept: [], warnings: [], initLines: [] })
    expect(readdirSync(workspace)).toEqual(['.harness'])
  })

  it('with no marker declared, copies the template (never over a file) and runs the init at every create', async () => {
    const dsh = install({ engine: 'codex', workspace: { template: 'template', init: 'init.sh' } }, {
      'template/deck.md': '# from the template\n',
      'init.sh': '#!/bin/sh\necho "init in $(basename "$PWD") for $HARNESS_DSH" >> init.log\necho ran\n',
    })
    writeFileSync(join(workspace, 'deck.md'), '# mine\n')
    const first = await materializeWorkspace(dsh, workspace)
    expect(first.created).toContain(`template → ${workspace}`)
    expect(first.initLines).toEqual(['ran'])
    expect(readFileSync(join(workspace, 'deck.md'), 'utf8')).toBe('# mine\n')
    await materializeWorkspace(dsh, workspace)
    expect(readFileSync(join(workspace, 'init.log'), 'utf8')).toBe('init in workspace for acme/thing\ninit in workspace for acme/thing\n')
  })

  it('reports a missing template; runtime binding validates instructions and skills separately', async () => {
    const dsh = install({ engine: 'claude', workspace: { template: 'gone', marker: 'deck.md' }, agent: { instructions: 'MISSING.md', skills: ['empty'] } }, { 'empty/README.md': '' })
    const result = await materializeWorkspace(dsh, workspace)
    expect(result.warnings).toEqual([
      `template ${join(harness, 'gone')} is missing`,
    ])
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(workspace, 'CLAUDE.md'))).toBe(false)
  })

  it('an init that fails, or is killed, is a warning with how it ended, never a thrown error', async () => {
    const failing = install({ engine: 'codex', workspace: { marker: 'done', init: 'echo half-way; exit 3' } })
    const failed = await materializeWorkspace(failing, workspace)
    expect(failed.initLines).toEqual(['half-way'])
    expect(failed.warnings).toEqual(['init exited 3'])
    const killed = install({ engine: 'codex', workspace: { marker: 'done', init: 'kill -KILL $$' } })
    expect((await materializeWorkspace(killed, workspace)).warnings).toEqual(['init exited SIGKILL'])
  })

  it('an init that is still running after five minutes is stopped and said to have timed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const slow = install({ engine: 'codex', workspace: { marker: 'done', init: 'sleep 30' } })
    const pending = materializeWorkspace(slow, workspace)
    vi.advanceTimersByTime(5 * 60_000)
    const result = await pending
    expect(result.warnings).toEqual(['init exited by timeout'])
  })

  it('skips skill entries that cannot be statted', () => {
    const dsh = install({ engine: 'codex', agent: { skills: ['skills'] } }, { 'skills/draw/SKILL.md': '# Draw' })
    symlinkSync(join(root, 'nowhere'), join(harness, 'skills', 'dangling'))
    expect(skillDirsIn(join(dsh.realDir, 'skills'))).toEqual([join(harness, 'skills/draw')])
  })

  it('refuses an agent manifest with no engine before writing workspace files', async () => {
    const dsh = install({ engine: 'claude', agent: { instructions: 'AGENTS.md', skills: ['skills'] } }, { 'AGENTS.md': '# Thing\n', 'skills/draw/SKILL.md': '' })
    const { engine: _engine, ...manifest } = dsh.manifest
    await expect(materializeWorkspace({ ...dsh, manifest }, workspace)).rejects.toThrow('does not support')
    expect(readdirSync(workspace)).toEqual([])
  })
})
