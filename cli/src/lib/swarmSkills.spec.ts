import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSwarmSkill, parseSwarmSkill } from './swarmSkills.js'
import { agentLaunchArgs } from './agentAttribution.js'
import { buildLaunchOverrides } from './launchOverrides.js'
import { gridLaunchInProcess } from '../testing/gridLaunchInProcess.js'

const roots: string[] = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'swarm-skills-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('built-in Swarm skills', () => {
  it.each(['claude', 'codex'] as const)('gives %s only its role skill in each session, preserving the shared project', engine => {
    const workspace = fixture(), data = fixture()
    writeFileSync(join(workspace, 'AGENTS.md'), 'Project rules\n')
    for (const role of ['lead', 'dev'] as const) {
      const skill = { role, key: `${engine}-${role}` }
      const prepared = prepareSwarmSkill(workspace, skill)
      expect(prepared.file.startsWith(join(realpathSync(workspace), '.harness', 'runtime'))).toBe(true)
      const text = readFileSync(prepared.file, 'utf8')
      expect(text).toContain(`name: swarm-${role}`)
      if (role === 'lead') expect(text).toContain('goal, changes, constraints, owned code and acceptance checks')
      else {
        expect(text).toContain('Needs:')
        expect(text).toContain("Do not touch other groups' code.")
      }
      expect(text).not.toContain(`name: swarm-${role === 'lead' ? 'dev' : 'lead'}`)
      expect(readdirSync(dirname(dirname(prepared.file)))).toEqual([`swarm-${role}`])
      const args = agentLaunchArgs(engine, null, { cwd: workspace, read: () => null, swarmInstructions: prepared.instructions }, data)
      expect(args.join(' ')).toContain(prepared.file)
      expect(args.join(' ')).not.toContain('harness new')
    }
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe('Project rules\n')
    expect(readdirSync(workspace).sort()).toEqual(['.harness', 'AGENTS.md'])
    expect(readdirSync(data)).toEqual([])
  })

  it('keeps standalone session skills out of Git, including git add -A', () => {
    const workspace = fixture()
    execFileSync('git', ['init', '-q', workspace])
    prepareSwarmSkill(workspace, { role: 'dev', key: 'standalone' })
    execFileSync('git', ['add', '-A'], { cwd: workspace })
    const staged = execFileSync('git', ['ls-files'], { cwd: workspace, encoding: 'utf8' })
    expect(staged).not.toContain('SKILL.md')
    expect(staged.trim()).toBe('.harness/.gitignore')
  })

  it('preserves custom ignore rules and adds the Store runtime rules only once', () => {
    const workspace = fixture(), saved = { role: 'lead' as const, key: 'one' }
    mkdirSync(join(workspace, '.harness'))
    const file = join(workspace, '.harness', '.gitignore')
    writeFileSync(file, '# Mine\nprivate-data')
    prepareSwarmSkill(workspace, saved)
    expect(readFileSync(file, 'utf8')).toBe('# Mine\nprivate-data\nruntime/\nlegacy-AGENTS.md\n')
    prepareSwarmSkill(workspace, saved)
    expect(readFileSync(file, 'utf8')).toBe('# Mine\nprivate-data\nruntime/\nlegacy-AGENTS.md\n')
  })

  it('refuses a redirected runtime ignore file without modifying its target', () => {
    const workspace = fixture(), target = join(fixture(), 'rules')
    mkdirSync(join(workspace, '.harness'))
    writeFileSync(target, 'Keep these rules')
    symlinkSync(target, join(workspace, '.harness', '.gitignore'))
    expect(() => prepareSwarmSkill(workspace, { role: 'dev', key: 'one' })).toThrow(/symlink|plain/i)
    expect(readFileSync(target, 'utf8')).toBe('Keep these rules')
  })

  it('keeps the session skill bytes on retry and isolates a different session', () => {
    const workspace = fixture(), saved = { role: 'lead' as const, key: 'first' }
    const first = prepareSwarmSkill(workspace, saved)
    writeFileSync(first.file, 'saved session instructions')
    expect(prepareSwarmSkill(workspace, saved)).toEqual(first)
    expect(readFileSync(first.file, 'utf8')).toBe('saved session instructions')
    const next = prepareSwarmSkill(workspace, { role: 'lead', key: 'second' })
    expect(next.file).not.toBe(first.file)
    expect(readFileSync(next.file, 'utf8')).toContain('name: swarm-lead')
  })

  it.each(['.harness', 'runtime', 'skill', 'file'])('refuses a redirected managed %s without writing through it', part => {
    const workspace = fixture(), outside = fixture(), saved = { role: 'dev' as const, key: 'one' }
    const first = prepareSwarmSkill(workspace, saved)
    const path = part === '.harness' ? join(workspace, '.harness') : part === 'runtime' ? join(workspace, '.harness', 'runtime') : part === 'skill' ? dirname(first.file) : first.file
    rmSync(path, { recursive: true, force: true })
    symlinkSync(outside, path)
    expect(() => prepareSwarmSkill(workspace, saved)).toThrow(/plain|symlink/i)
    expect(readdirSync(outside)).toEqual([])
  })

  it('validates persisted role metadata and refuses an empty key', () => {
    for (const value of [null, undefined, {}, { role: 'reviewer', key: 'x' }, { role: 'dev', key: '' }, { role: 'lead', key: 7 }]) expect(parseSwarmSkill(value)).toBeUndefined()
    expect(parseSwarmSkill({ role: 'dev', key: 'x' })).toEqual({ role: 'dev', key: 'x' })
    expect(() => prepareSwarmSkill(fixture(), { role: 'lead', key: '' })).toThrow()
  })

  it.each(['claude', 'codex'] as const)('restores %s skill on relaunch without overwriting the saved content', async engine => {
    const cwd = fixture(), swarmSkill = { role: 'dev' as const, key: 'original' }
    const first = prepareSwarmSkill(cwd, swarmSkill)
    const result = await buildLaunchOverrides({ capabilities: async () => ({ sessionEnv: true }), installCodexHooks: () => true, machine: () => ({ hermesSystemManaged: false }), gridLaunch: gridLaunchInProcess(),
      writeGridConfigDir: async () => '/unused', readCodexConfig: () => null, readAttribution: () => null }, engine, { cwd, swarmSkill }, 'new-registry-id')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.overrides?.extraArgs.join(' ')).toContain(first.file)
    expect(readdirSync(join(cwd, '.harness', 'runtime'))).toHaveLength(1)
  })

  it('refuses relaunch with a missing workspace or a redirected runtime', async () => {
    const cwd = fixture(), swarmSkill = { role: 'dev' as const, key: 'original' }
    symlinkSync(fixture(), join(cwd, '.harness'))
    const deps = { capabilities: async () => ({ sessionEnv: true }), installCodexHooks: () => true, machine: () => ({ hermesSystemManaged: false }), gridLaunch: gridLaunchInProcess(), writeGridConfigDir: async () => '/unused' }
    expect(await buildLaunchOverrides(deps, 'claude', { swarmSkill }, 'a')).toMatchObject({ ok: false, error: 'SWARM_SKILL_FAILED' })
    expect(await buildLaunchOverrides(deps, 'claude', { cwd, swarmSkill }, 'a')).toMatchObject({ ok: false, error: 'SWARM_SKILL_FAILED' })
  })
})
