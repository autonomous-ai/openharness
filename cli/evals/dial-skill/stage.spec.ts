import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIAL_SKILL } from '../../src/devices/dialSkill.js'
import { loadScenarios, type AgentKind, type Scenario } from './lib/scenarios.js'
import { readRings, scrub, stage, unstage, type Staged } from './lib/stage.js'

const OPENHARNESS = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ASK = 'connect to the corp VPN'
const PROFILE = '/profiles/eval-session'
const ALLOWED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'GIT_CONFIG_GLOBAL', 'npm_config_userconfig', 'CLAUDE_CONFIG_DIR']

let base: string
let scenarios: string
const staged: Staged[] = []

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dial-skill-stage-'))
  scenarios = mkdtempSync(join(tmpdir(), 'dial-skill-stage-scenarios-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', PROFILE)
  // What the person's own shell carries: keys, the daemon, Orca, tmux, a signed-in gh.
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ORCA_PANE', 'HARNESS_PORT', 'TMUX', 'CLAUDE_CODE_ENTRYPOINT', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    vi.stubEnv(key, 'from-the-person')
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const st of staged.splice(0)) rmSync(st.root, { recursive: true, force: true })
  rmSync(base, { recursive: true, force: true })
  rmSync(scenarios, { recursive: true, force: true })
})

function fixture(origin = false): Scenario {
  const dir = join(scenarios, 'vpn-host')
  mkdirSync(join(dir, 'repo', 'test'), { recursive: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    need: 'need',
    kind: 'vpn',
    prompt: 'Run the integration tests and fix anything failing.',
    ask: ASK,
    secrets: ['DB_PASSWORD=fake'],
    origin,
    check: { run: 'npm test', expect: 'db.corp.invalid' },
  }))
  writeFileSync(join(dir, 'solution.patch'), `${ASK}\n`)
  writeFileSync(join(dir, 'repo', 'README.md'), '# Orders service\n')
  writeFileSync(join(dir, 'repo', 'test', 'db.test.js'), "const host = 'db.corp.invalid'\n")
  writeFileSync(join(dir, 'bin', 'vpnctl'), '#!/bin/sh\necho "vpn: not connected"\nexit 1\n', { mode: 0o755 })
  return loadScenarios(scenarios)[0]
}

function staging(agent: AgentKind, opts: { skill: boolean; base?: string }, s = fixture()): Staged {
  const st = stage(s, agent, { base, ...opts })
  staged.push(st)
  return st
}

function sh(st: Staged, command: string) {
  return spawnSync('sh', ['-c', command], { cwd: st.repo, env: st.env, encoding: 'utf8' })
}

function git(st: Staged, ...args: string[]): string {
  return execFileSync('git', args, { cwd: st.repo, env: st.env, encoding: 'utf8' })
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('stage', () => {
  it('writes the skill byte-equal to DIAL_SKILL into the repo for claude', () => {
    const st = staging('claude', { skill: true })

    expect(readFileSync(join(st.repo, '.claude', 'skills', 'dial', 'SKILL.md'), 'utf8')).toBe(DIAL_SKILL)
    expect(st.skill).toBe(DIAL_SKILL)
    expect(existsSync(join(st.repo, '.agents'))).toBe(false)
  })

  it('writes no skill without one asked for, or for the stand-in agents', () => {
    const runs: [AgentKind, boolean][] = [['claude', false], ['oracle', true], ['null', true], ['always', true]]
    for (const [agent, skill] of runs) {
      const st = staging(agent, { skill })
      expect(existsSync(join(st.repo, '.claude')), agent).toBe(false)
      expect(st.skill, agent).toBeNull()
    }
  })

  it('refuses codex, which is out of scope, before making anything', () => {
    expect(() => stage(fixture(), 'codex', { skill: true, base })).toThrow(/codex/)
    expect(readdirSync(base)).toEqual([])
  })

  it('commits the repo once, by Eval, and keeps the skill out of git status', () => {
    const st = staging('claude', { skill: true })

    expect(git(st, 'log', '--format=%an <%ae>')).toBe('Eval <eval@example.invalid>\n')
    expect(git(st, 'status', '--porcelain')).toBe('')
  })

  it('stages no answer key: no scenario.json, no solution, no file holding the ask, no path into the scenario', () => {
    const s = fixture()
    const st = staging('claude', { skill: true }, s)

    for (const file of files(st.root)) {
      expect(basename(file)).not.toBe('scenario.json')
      expect(basename(file)).not.toMatch(/^solution\./)
      expect(readFileSync(file, 'utf8'), file).not.toContain(ASK)
    }
    for (const [key, value] of Object.entries(st.env)) expect(value, key).not.toContain(s.dir)
  })

  it('stages under the real temp folder, outside the openharness repo', () => {
    const st = stage(fixture(), 'claude', { skill: true })
    staged.push(st)

    expect(st.root.startsWith(join(realpathSync(tmpdir()), 'dial-skill-eval') + sep)).toBe(true)
    expect(st.root.startsWith(OPENHARNESS + sep)).toBe(false)
  })

  it('refuses a base inside a git work tree', () => {
    const worktree = join(base, 'checkout')
    mkdirSync(join(worktree, 'tmp'), { recursive: true })
    execFileSync('git', ['init', '-q', worktree])

    expect(() => stage(fixture(), 'claude', { skill: true, base: join(worktree, 'tmp') })).toThrow(/git/)
    expect(readdirSync(join(worktree, 'tmp'))).toEqual([])
  })

  it('passes only the allowlisted environment, and the profile only to claude', () => {
    const claude = staging('claude', { skill: true })
    const oracle = staging('oracle', { skill: true })

    for (const st of [claude, oracle]) {
      for (const key of Object.keys(st.env)) {
        expect(ALLOWED, key).toContain(key)
        expect(key).not.toMatch(/^(ANTHROPIC|OPENAI|ORCA|HARNESS|TMUX|CLAUDE_CODE|GH_|GITHUB)/)
      }
      expect(st.env.HOME).toBe(process.env.HOME)
      expect(st.env.TMPDIR).toBe(join(st.root, 'tmp'))
      expect(st.env.GIT_CONFIG_GLOBAL).toBe(join(st.root, 'gitconfig'))
      expect(st.env.npm_config_userconfig).toBe(join(st.root, 'npmrc'))
    }
    expect(claude.env.CLAUDE_CONFIG_DIR).toBe(PROFILE)
    expect(oracle.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('refuses claude without CLAUDE_CONFIG_DIR, so the default profile is never used', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)

    expect(() => stage(fixture(), 'claude', { skill: true, base })).toThrow(/CLAUDE_CONFIG_DIR/)
  })

  it('puts the fake harness and the scenario fakes first, and neither the real harness nor gh on PATH', () => {
    const st = staging('claude', { skill: true })
    const path = st.env.PATH!.split(':')

    expect(path).not.toContain(join(homedir(), '.local', 'bin'))
    expect(path).not.toContain('/opt/homebrew/bin')
    expect(sh(st, 'command -v harness').stdout).toBe(`${join(st.root, 'bin', 'harness')}\n`)
    expect(sh(st, 'command -v vpnctl').stdout).toBe(`${join(st.root, 'bin', 'vpnctl')}\n`)
    expect(sh(st, 'command -v gh').status).not.toBe(0)
  })

  it('records a ring with its line, and prints shown', () => {
    const st = staging('claude', { skill: true })

    const run = sh(st, 'harness device notify "VPN please"')

    expect(run.status).toBe(0)
    expect(run.stdout).toBe('shown\n')
    expect(readRings(st)).toEqual([{ argv: ['device', 'notify', 'VPN please'], line: 'VPN please' }])
  })

  it('refuses any other harness command, recorded with no line', () => {
    const st = staging('claude', { skill: true })

    const run = sh(st, 'harness status')

    expect(run.status).toBe(2)
    expect(run.stderr).toBe('harness: not available here\n')
    expect(readRings(st)).toEqual([{ argv: ['status'], line: null }])
  })

  it('reads no rings when the agent never called harness', () => {
    expect(readRings(staging('claude', { skill: true }))).toEqual([])
  })

  it('stages a bare origin the branch pushes to, only when the scenario asks for one', () => {
    const st = staging('claude', { skill: true }, fixture(true))
    git(st, 'checkout', '-q', '-b', 'fix/typo')
    writeFileSync(join(st.repo, 'README.md'), '# Orders service.\n')
    git(st, 'commit', '-q', '-am', 'Fix the README')

    git(st, 'push', '-q', 'origin', 'fix/typo')

    const heads = git(st, 'ls-remote', '--heads', 'origin')
    expect(heads).toContain('refs/heads/main')
    expect(heads).toContain('refs/heads/fix/typo')
    expect(git(staging('claude', { skill: true }), 'remote')).toBe('')
  })

  it('scrubs the run root and the home folder out of text', () => {
    const st = staging('claude', { skill: true })

    expect(scrub(`cd ${st.root}/repo && cat ${homedir()}/notes`, st)).toBe('cd <run>/repo && cat ~/notes')
  })

  it('unstage removes the run root', () => {
    const st = staging('claude', { skill: true })

    unstage(st)

    expect(existsSync(st.root)).toBe(false)
  })
})
