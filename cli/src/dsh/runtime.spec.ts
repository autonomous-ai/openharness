import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROCESS_ENGINES } from '../engines/types.js'
import { buildEngineCommandArgv, buildEngineLaunchArgv } from '../lib/engineLaunch.js'
import { buildLaunchOverrides } from '../lib/launchOverrides.js'
import type { InstalledDsh } from './installed.js'
import { HARNESS_ADAPTERS, HARNESS_BOOTSTRAP, harnessAdapter } from './adapters.js'
import { compatibleHarnessEngines } from './compatibility.js'
import { harnessRuntimeDir, migrateHarnessInstructions, prepareHarnessLaunch } from './runtime.js'

let root: string
let ws: string
let pkg: InstalledDsh
const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'portable harness-')))
  ws = join(root, 'project with spaces')
  mkdirSync(ws)
  const dir = join(root, 'package')
  write(join(dir, 'AGENTS.md'), '# Make a drawing\nRead the draw skill before working.\n')
  write(join(dir, 'skills/draw/SKILL.md'), '# Draw\nRun the toolchain and write .harness/verdict.json.\n')
  pkg = { id: 'acme/draw', dir, realDir: dir, source: dir, ref: null, commit: null, linked: true, installedAt: 1,
    manifest: { spec: 1, id: 'acme/draw', name: 'Drawing', engine: 'claude',
      agent: { instructions: 'AGENTS.md', skills: ['skills'], args: ['--add-dir', '${workspace}/input'],
        env: { TOOLCHAIN: '${dsh}/tools', OLD_SKILLS: '${workspace}/.claude/skills', OTHER_SKILLS: '${workspace}/.agents/skills', HARNESS_DSH: 'spoofed' } } } }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('portable harness adapters', () => {
  it('has a contract for every process engine, with no package allowlist', () => {
    expect(Object.keys(HARNESS_ADAPTERS)).toEqual(PROCESS_ENGINES)
    for (const engine of PROCESS_ENGINES) {
      expect(compatibleHarnessEngines({ engine })[0]).toBe(engine)
      expect(new Set(compatibleHarnessEngines({ engine }))).toEqual(new Set(PROCESS_ENGINES))
    }
    expect(compatibleHarnessEngines({})).toEqual([])
    expect(compatibleHarnessEngines({ kind: 'viewer', engine: 'claude' })).toEqual([])
    expect(compatibleHarnessEngines({ engine: 'terminal' })).toEqual([])
    expect(() => harnessAdapter('terminal')).toThrow('Terminal cannot run')
  })

  for (const engine of PROCESS_ENGINES) it(`${engine}: binds the same harness and preserves the engine at launch`, () => {
    const launch = prepareHarnessLaunch(pkg, ws, engine, engine)
    const bootstrap = engine === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
    expect(readFileSync(join(ws, bootstrap), 'utf8')).toContain(HARNESS_BOOTSTRAP)
    expect(readFileSync(launch.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain('# Make a drawing')
    expect(readFileSync(launch.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain(join(launch.env.HARNESS_SKILLS_DIR!, 'draw/SKILL.md'))
    expect(readlinkSync(join(launch.env.HARNESS_SKILLS_DIR!, 'draw'))).toBe(join(pkg.realDir, 'skills/draw'))
    expect(launch.env).toMatchObject({ HARNESS_DSH: pkg.id, HARNESS_DSH_DIR: pkg.realDir, HARNESS_WORKSPACE: ws,
      TOOLCHAIN: join(pkg.realDir, 'tools'), OLD_SKILLS: launch.env.HARNESS_SKILLS_DIR, OTHER_SKILLS: launch.env.HARNESS_SKILLS_DIR })
    expect(launch.args.includes('--add-dir')).toBe(engine === 'claude')
    expect(buildEngineCommandArgv(engine, { extraArgs: launch.args }).slice(-launch.args.length || Infinity)).toEqual(launch.args)
    expect(existsSync(join(ws, '.claude/skills'))).toBe(false)
    expect(existsSync(join(ws, '.agents/skills'))).toBe(false)
  })

  for (const [engine, file] of [['codex', 'AGENTS.override.md'], ['pi', 'CLAUDE.md'], ['hermes', '.hermes.md'], ['hermes', '.cursorrules'], ['opencode', 'CLAUDE.md'], ['agy', 'GEMINI.md']] as const) {
    it(`${engine}: respects existing ${file} and preserves its bytes`, () => {
      write(join(ws, file), '# My project rules')
      const first = prepareHarnessLaunch(pkg, ws, engine, 'session')
      const once = readFileSync(join(ws, file), 'utf8')
      expect(once.startsWith('# My project rules\n')).toBe(true)
      expect(once).toContain(HARNESS_BOOTSTRAP)
      expect(prepareHarnessLaunch(pkg, ws, engine, 'session')).toEqual(first)
      expect(readFileSync(join(ws, file), 'utf8')).toBe(once)
    })
  }
})

describe('session isolation and lifecycle', () => {
  it('makes legacy skill commands executable without redirecting upstream source paths', () => {
    write(join(pkg.realDir, 'AGENTS.md'), 'You are Codex in this workspace.\n' +
      '```sh\ncat .agents/skills/draw/SKILL.md\n```\n' +
      'Read `.claude/skills/draw/SKILL.md`. Keep `$STUDIO_UPSTREAM/.claude/skills/reference/` and `runtime/.agents/skills/source/` and `.agents/skills-other`.\n')
    const launch = prepareHarnessLaunch(pkg, ws, 'codex', 'legacy-paths')
    const content = readFileSync(launch.env.HARNESS_CONTEXT_FILE!, 'utf8')
    expect(content).toContain('You are an agent in this workspace.')
    expect(content).toContain('`"$HARNESS_SKILLS_DIR"/draw/SKILL.md`')
    expect(content).toContain('$STUDIO_UPSTREAM/.claude/skills/reference/')
    expect(content).toContain('runtime/.agents/skills/source/')
    expect(content).toContain('.agents/skills-other')
    const command = content.match(/```sh\n([^`]+)```/)![1]!
    expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: process.env.PATH, ...launch.env } })).toContain('# Draw')
  })

  it('does not inherit the previous account private grid on a harness relaunch', async () => {
    const result = await buildLaunchOverrides({ machine: () => ({ hermesSystemManaged: false }),
      writeGridConfigDir: async () => '/unused', tmuxSupportsSessionEnv: async () => true,
      installCodexHooks: () => {}, dshLaunch: () => prepareHarnessLaunch(pkg, ws, 'claude', 'new-account'),
    }, 'claude', { dsh: pkg.id, cwd: ws }, 'agent')
    if (!result.ok) throw new Error(result.detail)
    const [, , script] = buildEngineLaunchArgv('claude', { clearEnv: result.overrides.clearEnv }, '/bin/sh', undefined, undefined, null)
    const seen = execFileSync('/bin/sh', ['-c', script!, 'harness-engine', '/bin/sh', '-c',
      'test -z "${HARNESS_PRIVATE_GRID+x}" || exit 9; printf "%s" "$HARNESS_CONTEXT_FILE"'], {
      encoding: 'utf8', env: { ...process.env, HARNESS_PRIVATE_GRID: 'another-account', ...result.overrides.env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(seen).toBe(result.overrides.env.HARNESS_CONTEXT_FILE)
  })

  it('keeps two harnesses in one project separate, leaving no harness content in project rules', () => {
    write(join(ws, 'AGENTS.md'), '# My project rules\n')
    const a = prepareHarnessLaunch(pkg, ws, 'codex', 'a')
    const second: InstalledDsh = { ...pkg, id: 'acme/music', manifest: { ...pkg.manifest, id: 'acme/music', name: 'Music' } }
    write(join(pkg.realDir, 'AGENTS.md'), '# Make music\n')
    const b = prepareHarnessLaunch(second, ws, 'codex', 'b')
    expect(a.env.HARNESS_CONTEXT_FILE).not.toBe(b.env.HARNESS_CONTEXT_FILE)
    expect(readFileSync(a.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain('# Make a drawing')
    expect(readFileSync(b.env.HARNESS_CONTEXT_FILE!, 'utf8')).not.toContain('# Make a drawing')
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(`# My project rules\n\n${HARNESS_BOOTSTRAP}`)
  })

  it('resumes and forks the original engine/content/env/args despite package changes, refreshing account facts', async () => {
    const first = prepareHarnessLaunch(pkg, ws, 'claude', 'original', { privateGrid: 'old-grid' })
    pkg.manifest.engine = 'codex'
    pkg.manifest.agent!.args = ['--new-flag']
    pkg.manifest.agent!.env = { TOOLCHAIN: 'changed' }
    write(join(pkg.realDir, 'AGENTS.md'), '# Updated instructions\n')
    const deps = { machine: () => ({ hermesSystemManaged: false }), writeGridConfigDir: async () => '/cfg',
      tmuxSupportsSessionEnv: async () => true, installCodexHooks: () => {},
      dshLaunch: (_id: string, workspace: string, engine: typeof PROCESS_ENGINES[number] | 'terminal', key: string) =>
        prepareHarnessLaunch(pkg, workspace, engine, key, { privateGrid: 'new-grid' }) }
    const result = await buildLaunchOverrides(deps, 'claude', { dsh: pkg.id, cwd: ws, dshRuntime: 'original' }, 'registry-agent-id')
    expect(result.ok && result.overrides.env.HARNESS_CONTEXT_FILE).toBe(first.env.HARNESS_CONTEXT_FILE)
    expect(result.ok && result.overrides.env.HARNESS_PRIVATE_GRID).toBe('new-grid')
    expect(result.ok && result.overrides.extraArgs).toEqual(first.args)
    const fork = prepareHarnessLaunch(pkg, ws, 'claude', 'fork', {}, 'original')
    expect(fork.env.HARNESS_CONTEXT_FILE).not.toBe(first.env.HARNESS_CONTEXT_FILE)
    expect(readFileSync(fork.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain('# Make a drawing')
    expect(fork.env.TOOLCHAIN).toBe(first.env.TOOLCHAIN)
    expect(fork.env.HARNESS_PRIVATE_GRID).toBeUndefined()
    const fresh = prepareHarnessLaunch(pkg, ws, 'codex', 'fresh')
    expect(readFileSync(fresh.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain('# Updated instructions')
    expect(fresh.args).toEqual(['--new-flag'])
  })

  it('keeps older rows stable using their agent id and supports package renames', async () => {
    const deps = { machine: () => ({ hermesSystemManaged: false }), writeGridConfigDir: async () => '/cfg',
      tmuxSupportsSessionEnv: async () => true, installCodexHooks: () => {},
      dshLaunch: (_id: string, workspace: string, engine: typeof PROCESS_ENGINES[number] | 'terminal', key: string) => prepareHarnessLaunch(pkg, workspace, engine, key) }
    const first = await buildLaunchOverrides(deps, 'codex', { dsh: pkg.id, cwd: ws }, 'old-agent')
    pkg.manifest.formerly = [pkg.id]
    pkg.id = 'acme/drawing'
    const next = await buildLaunchOverrides(deps, 'codex', { dsh: pkg.id, cwd: ws }, 'old-agent')
    expect(next).toEqual(first)
  })

  it('reports preparation failures, missing dependencies, or no resolver before a relaunch', async () => {
    const deps = { machine: () => ({ hermesSystemManaged: false }), writeGridConfigDir: async () => '/cfg',
      tmuxSupportsSessionEnv: async () => true, installCodexHooks: () => {} }
    expect(await buildLaunchOverrides(deps, 'codex', { dsh: pkg.id, cwd: ws }, 'key')).toMatchObject({ ok: false, error: 'DSH_NOT_INSTALLED' })
    expect(await buildLaunchOverrides({ ...deps, dshLaunch: () => { throw new Error('broken context') } }, 'codex', { dsh: pkg.id, cwd: ws }, 'key'))
      .toMatchObject({ ok: false, error: 'DSH_RUNTIME_FAILED', detail: 'Error: broken context' })
  })
})

describe('runtime validation and file ownership', () => {
  it('retries the same fork without replacing an occupied destination with another snapshot', () => {
    prepareHarnessLaunch(pkg, ws, 'codex', 'source')
    const fork = prepareHarnessLaunch(pkg, ws, 'codex', 'fork', {}, 'source')
    expect(prepareHarnessLaunch(pkg, ws, 'codex', 'fork', {}, 'source')).toEqual(fork)
    const before = readFileSync(fork.env.HARNESS_CONTEXT_FILE!, 'utf8')
    write(join(pkg.realDir, 'AGENTS.md'), '# Different instructions\n')
    prepareHarnessLaunch(pkg, ws, 'codex', 'other-source')
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'fork', {}, 'other-source')).toThrow('fork destination already has a different harness runtime')
    expect(readFileSync(fork.env.HARNESS_CONTEXT_FILE!, 'utf8')).toBe(before)
    const file = join(harnessRuntimeDir(ws, 'fork'), 'runtime.json')
    const saved = readFileSync(file, 'utf8')
    write(file, '{corrupt')
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'fork', {}, 'source')).toThrow()
    write(file, saved)
    rmSync(file)
    symlinkSync(join(root, 'missing'), file)
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'fork', {}, 'source')).toThrow('snapshot is a symlink')
  })

  it('keeps runtime snapshots out of Git while preserving existing ignore rules', () => {
    write(join(ws, '.harness/.gitignore'), '# User rules\nmy-data');
    prepareHarnessLaunch(pkg, ws, 'codex', 'key');
    expect(readFileSync(join(ws, '.harness/.gitignore'), 'utf8')).toBe('# User rules\nmy-data\nruntime/\nlegacy-AGENTS.md\n');
    prepareHarnessLaunch(pkg, ws, 'codex', 'key');
    expect(readFileSync(join(ws, '.harness/.gitignore'), 'utf8').match(/runtime\//g)).toHaveLength(1);
  })

  it('supports a minimal harness and deduplicates repeated skill roots', () => {
    pkg.manifest.agent = undefined
    const launch = prepareHarnessLaunch(pkg, ws, 'codex', '../../outside')
    expect(launch.env.HARNESS_CONTEXT_FILE).toContain(join(ws, '.harness/runtime'))
    expect(readFileSync(launch.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain('## Harness skills')
    pkg.manifest.agent = { skills: ['skills', 'skills/draw'] }
    const next = prepareHarnessLaunch(pkg, ws, 'codex', 'dedup')
    expect(readFileSync(next.env.HARNESS_CONTEXT_FILE!, 'utf8').match(/- draw:/g)).toHaveLength(1)
    expect(() => harnessRuntimeDir(ws, '')).toThrow('session key')
  })

  it('imports existing AGENTS rules for Claude once and normalizes legacy engine introductions', () => {
    write(join(ws, 'AGENTS.md'), '# Repository rules\n')
    write(join(pkg.realDir, 'AGENTS.md'), 'You are Claude Code in a drawing workspace.\n')
    const launch = prepareHarnessLaunch(pkg, ws, 'claude', 'first')
    expect(readFileSync(launch.env.HARNESS_CONTEXT_FILE!, 'utf8')).toContain('You are an agent in a drawing workspace.')
    expect(readFileSync(join(ws, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md\n')
    write(join(ws, 'CLAUDE.md'), '# Claude project rules\n@AGENTS.md\n')
    prepareHarnessLaunch(pkg, ws, 'claude', 'second')
    expect(readFileSync(join(ws, 'CLAUDE.md'), 'utf8').match(/@AGENTS.md/g)).toHaveLength(1)
  })

  it('rejects terminal/viewer, missing instructions/skills, and duplicate skill names', () => {
    expect(() => prepareHarnessLaunch(pkg, ws, 'terminal', 'key')).toThrow('Terminal cannot run')
    pkg.manifest.kind = 'viewer'
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('viewer')
    delete pkg.manifest.kind
    pkg.manifest.agent!.instructions = 'missing.md'
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('ENOENT')
    delete pkg.manifest.agent!.instructions
    pkg.manifest.agent!.skills = ['missing']
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('No SKILL.md')
    write(join(pkg.realDir, 'other/draw/SKILL.md'), '# Other draw')
    pkg.manifest.agent!.skills = ['skills', 'other']
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('Duplicate harness skill')
    expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false)
  })

  it('refuses a different saved engine or package, corrupt snapshots and missing fork sources', () => {
    prepareHarnessLaunch(pkg, ws, 'codex', 'key')
    expect(() => prepareHarnessLaunch(pkg, ws, 'claude', 'key')).toThrow('runtime belongs')
    expect(() => prepareHarnessLaunch({ ...pkg, id: 'acme/other' }, ws, 'codex', 'key')).toThrow('runtime belongs')
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'fork', {}, 'missing')).toThrow('original harness runtime is missing')
    const file = join(harnessRuntimeDir(ws, 'key'), 'runtime.json')
    write(file, '{broken')
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow()
    write(file, '{"version":2}')
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow()
    rmSync(file)
    symlinkSync(join(root, 'outside'), file)
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('snapshot is a symlink')
  })

  for (const target of ['.harness', '.harness/runtime', 'bundle', 'skills']) it(`refuses symlinked ${target} directories`, () => {
    const path = target === 'bundle' ? harnessRuntimeDir(ws, 'key') : target === 'skills' ? join(harnessRuntimeDir(ws, 'key'), 'skills') : join(ws, target)
    mkdirSync(join(path, '..'), { recursive: true })
    symlinkSync(join(root, 'does-not-exist'), path)
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('not a plain directory')
  })

  it('refuses directory collisions, user links, edited bootstraps and modified context links', () => {
    write(join(ws, '.harness'), 'user file')
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('not a plain directory')
    rmSync(join(ws, '.harness'))
    write(join(root, 'my-rules'), '# My rules')
    symlinkSync(join(root, 'my-rules'), join(ws, 'AGENTS.md'))
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('Refusing to replace a symlink')
    expect(readFileSync(join(root, 'my-rules'), 'utf8')).toBe('# My rules')
    rmSync(join(ws, 'AGENTS.md'))
    write(join(ws, 'AGENTS.md'), '<!-- harness:runtime v1 -->\nedited')
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('bootstrap')
    rmSync(join(ws, 'AGENTS.md'))
    const launch = prepareHarnessLaunch(pkg, ws, 'codex', 'key')
    rmSync(launch.env.HARNESS_CONTEXT_FILE!)
    symlinkSync(join(root, 'my-rules'), launch.env.HARNESS_CONTEXT_FILE!)
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('Refusing to replace a symlink')
  })

  it('refuses missing skills and occupied skill paths without touching them', () => {
    const launch = prepareHarnessLaunch(pkg, ws, 'codex', 'key')
    const skill = join(launch.env.HARNESS_SKILLS_DIR!, 'draw')
    rmSync(skill)
    mkdirSync(skill)
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('already occupied')
    rmSync(skill, { recursive: true })
    symlinkSync(join(root, 'user-skill'), skill)
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('already occupied')
    rmSync(join(pkg.realDir, 'skills/draw/SKILL.md'))
    expect(() => prepareHarnessLaunch(pkg, ws, 'codex', 'key')).toThrow('Harness skill is missing')
  })
})

describe('non-destructive legacy migration', () => {
  const legacy = () => `# User rules\n\n<!-- harness:dsh ${pkg.id} -->\n${readFileSync(join(pkg.realDir, 'AGENTS.md'), 'utf8').trim()}\n\n# User additions\n`

  it('archives exact bytes, removes only known instructions and owned native skill links, and is idempotent', () => {
    const before = legacy()
    write(join(ws, 'AGENTS.md'), before)
    for (const native of ['.claude/skills', '.agents/skills']) {
      mkdirSync(join(ws, native), { recursive: true })
      symlinkSync(join(pkg.realDir, 'skills/draw'), join(ws, native, 'draw'))
      symlinkSync(join(root, 'user-owned'), join(ws, native, 'mine'))
    }
    migrateHarnessInstructions(ws, pkg)
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe('# User rules\n\n\n# User additions\n')
    expect(readFileSync(join(ws, '.harness/legacy-AGENTS.md'), 'utf8')).toBe(before)
    expect(existsSync(join(ws, '.claude/skills/draw'))).toBe(false)
    expect(readlinkSync(join(ws, '.claude/skills/mine'))).toBe(join(root, 'user-owned'))
    write(join(ws, 'AGENTS.md'), before)
    migrateHarnessInstructions(ws, pkg)
    migrateHarnessInstructions(ws, pkg)
    expect(readFileSync(join(ws, '.harness/legacy-AGENTS.md'), 'utf8')).toBe(before)
  })

  it('handles renamed and other installed harnesses and preserves non-owned skill paths', () => {
    write(join(ws, 'AGENTS.md'), legacy())
    const old = pkg.id
    pkg.id = 'acme/renamed'
    pkg.manifest.formerly = [old]
    mkdirSync(join(ws, '.claude/skills/draw'), { recursive: true })
    mkdirSync(join(ws, '.agents/skills'), { recursive: true })
    symlinkSync(join(root, 'my-draw'), join(ws, '.agents/skills/draw'))
    migrateHarnessInstructions(ws, pkg)
    expect(readlinkSync(join(ws, '.agents/skills/draw'))).toBe(join(root, 'my-draw'))
    write(join(ws, 'AGENTS.md'), legacy())
    migrateHarnessInstructions(ws, { ...pkg, id: 'acme/another', manifest: { ...pkg.manifest, formerly: undefined } }, id => id === pkg.id ? pkg : null)
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).not.toContain('harness:dsh')
  })

  it('preserves native directories reached through symlinks, even when their skill links match', () => {
    write(join(ws, 'AGENTS.md'), legacy())
    mkdirSync(join(root, 'external/skills'), { recursive: true })
    symlinkSync(join(pkg.realDir, 'skills/draw'), join(root, 'external/skills/draw'))
    symlinkSync(join(root, 'external'), join(ws, '.claude'))
    mkdirSync(join(ws, '.agents'))
    symlinkSync(join(root, 'external/skills'), join(ws, '.agents/skills'))
    migrateHarnessInstructions(ws, pkg)
    expect(readlinkSync(join(root, 'external/skills/draw'))).toBe(join(pkg.realDir, 'skills/draw'))
  })

  it('leaves edited or unknown legacy sections intact and returns an actionable failure', () => {
    write(join(ws, 'AGENTS.md'), legacy().replace('# Make a drawing', '# My edits'))
    expect(() => migrateHarnessInstructions(ws, pkg)).toThrow('were edited')
    write(join(ws, 'AGENTS.md'), '<!-- harness:dsh gone/away -->\n# Lost instructions\n')
    expect(() => migrateHarnessInstructions(ws, pkg, () => null)).toThrow('restore the package')
    expect(() => migrateHarnessInstructions(ws, pkg, () => ({ ...pkg, manifest: { ...pkg.manifest, agent: undefined } }))).toThrow('restore the package')
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toContain('# Lost instructions')
  })

  it('migrates instruction-only harnesses without replacing an existing backup symlink', () => {
    delete pkg.manifest.agent!.skills
    write(join(ws, 'AGENTS.md'), legacy())
    mkdirSync(join(ws, '.harness'))
    symlinkSync(join(root, 'my-backup'), join(ws, '.harness/legacy-AGENTS.md'))
    migrateHarnessInstructions(ws, pkg)
    expect(readlinkSync(join(ws, '.harness/legacy-AGENTS.md'))).toBe(join(root, 'my-backup'))
  })
})
