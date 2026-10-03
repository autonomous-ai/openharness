import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { buildEngineLaunchArgv, commandAvailableInInteractiveShell, shellSingleQuote } from './engineLaunch.js'
import type { EngineInstallRecipe } from './engineInstall.js'

// Use real npm against a local package, with networking and lifecycle scripts disabled.
// Fake npm missed the fresh-account EACCES failure in a shared Homebrew prefix.
const npm = resolveBinaryOnPath('npm')!
const roots: string[] = []
const locked: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755)
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-user-engine-'))
  roots.push(root)
  const home = join(root, "home with 'quotes")
  mkdirSync(home)
  vi.stubEnv('HOME', home)
  const shared = join(root, 'shared-prefix')
  mkdirSync(shared, { mode: 0o555 })
  locked.push(shared)
  const pkg = join(root, 'package')
  mkdirSync(pkg)
  const name = 'harness-user-engine-fixture'
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', bin: { [name]: 'engine.js' } }))
  writeFileSync(join(pkg, 'engine.js'), '#!/usr/bin/env node\nconsole.log("ENGINE_READY:" + JSON.stringify(process.argv.slice(2)))\n')
  const runtime = (name: string) => {
    const bin = join(root, name, 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
    symlinkSync(npm, join(bin, 'npm'))
    return join(bin, 'node')
  }
  const recipe: EngineInstallRecipe = {
    command: `npm install -g --offline --ignore-scripts --no-audit --no-fund ${shellSingleQuote(pkg)}`,
    source: 'local fixture',
    executable: { names: [name], npmGlobal: true },
  }
  const env = {
    HOME: home, PATH: '/usr/bin:/bin',
    // Both npm spellings must be overridden for the install without rewriting this user's config.
    npm_config_prefix: shared, NPM_CONFIG_PREFIX: shared,
  }
  writeFileSync(join(home, '.npmrc'), `prefix=${shared}\n`)
  const run = (node: string, install = recipe, shell = '/bin/sh') => {
    const argv = buildEngineLaunchArgv('codex', { installIfMissing: install }, shell, node, 'grid', null)
    const script = argv[argv.indexOf('harness-engine') - 1]
    return spawnSync(shell, ['-c', script, 'harness-engine', name, 'argument with spaces'], {
      env, encoding: 'utf8', timeout: 20_000,
    })
  }
  return { home, shared, name, recipe, env, runtime, run }
}

describe('engine installation for a fresh OS user', () => {
  for (const shell of ['/bin/sh', '/bin/zsh'].filter(existsSync)) {
    it(`installs with ${shell} into the user home when the npm global prefix is not writable`, () => {
      const f = fixture()
      const result = f.run(f.runtime('node-one'), f.recipe, shell)
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('ENGINE_READY:["argument with spaces"]')
      expect(existsSync(join(f.home, '.local/bin', f.name))).toBe(true)
      expect(readdirSync(f.shared)).toEqual([])
      expect(readFileSync(join(f.home, '.npmrc'), 'utf8')).toBe(`prefix=${f.shared}\n`)
    })
  }

  it('reuses the user install after a managed Node upgrade, even with no node or npm on PATH', async () => {
    const f = fixture()
    const first = f.run(f.runtime('node-one'))
    expect(first.status, first.stdout + first.stderr).toBe(0)
    rmSync(join(f.home, '..', 'node-one'), { recursive: true })
    const upgradedNode = f.runtime('node-two')
    const second = f.run(upgradedNode, { ...f.recipe, command: 'exit 93' })
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain('ENGINE_READY:')
    expect(second.stdout).not.toContain('engine is missing')

    // The availability probe uses the same per-user candidates as the launch, without installing.
    const probe = join(f.home, '..', 'bash')
    writeFileSync(probe, '#!/bin/sh\nshift\nexec /bin/sh -c "$@"\n', { mode: 0o700 })
    vi.stubEnv('PATH', f.env.PATH)
    await expect(commandAvailableInInteractiveShell(f.name, probe, f.recipe)).resolves.toBe(true)
  })

  it('keeps using an existing global engine instead of installing another copy', () => {
    const f = fixture()
    // This prefix is writable during setup only; the missing-engine test above owns EACCES.
    chmodSync(f.shared, 0o755)
    const node = f.runtime('node-one')
    execFileSync(npm, ['install', '-g', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(f.home, '..', 'package')], {
      env: { ...f.env, PATH: `${join(node, '..')}:${f.env.PATH}` }, stdio: 'pipe',
    })
    chmodSync(f.shared, 0o555)
    const result = f.run(node, { ...f.recipe, command: 'exit 93' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('ENGINE_READY:')
    expect(existsSync(join(f.home, '.local/bin', f.name))).toBe(false)
  })
})
