import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessPath } from '../config/harnessHome.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { shellSingleQuote } from './engineLaunch.js'
import { shellAgentArgv, buildEngineInstallationArgv } from '../engines/kit/installationScript.js'
import { commandAvailableInInteractiveShell } from '../engines/kit/interactiveProbe.js'
import type { EngineInstallRecipe } from './engineInstall.js'
import { writeExecutable } from '../testing/executableFixture.js'

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
  vi.stubEnv('USERPROFILE', home)
  const shared = join(root, 'shared-prefix')
  mkdirSync(shared, { mode: 0o555 })
  locked.push(shared)
  const pkg = join(root, 'package')
  mkdirSync(pkg)
  const name = 'harness-user-engine-fixture'
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', bin: { [name]: 'engine.js' } }))
  writeExecutable(join(pkg, 'engine.js'), '#!/usr/bin/env node\nconsole.log("ENGINE_READY:" + JSON.stringify(process.argv.slice(2)))\n')
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
    const script = shellAgentArgv(name, ['argument with spaces'], install, node)[2]
    return spawnSync(shell, ['-c', script, 'harness-engine', name, 'argument with spaces'], {
      env, encoding: 'utf8', timeout: 20_000,
    })
  }
  // The same run without blocking the event loop, for a test that has a process of its own to keep going.
  // `watch` sees the output so far as it comes, with the script's process, the leader of its own group.
  const runAsync = (node: string, install = recipe, shell = '/bin/sh', watch?: (output: string, pid: number) => void) => new Promise<{ status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }>((resolve) => {
    const script = buildEngineInstallationArgv('codex', install, { ...env, SHELL: shell }, node)[2]
    const child = spawn(shell, ['-c', script, 'harness-native-install', name], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk; watch?.(stdout + stderr, child.pid!) })
    child.stderr.on('data', (chunk) => { stderr += chunk; watch?.(stdout + stderr, child.pid!) })
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 30_000)
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }) })
  })
  return { home, shared, name, recipe, env, runtime, run, runAsync }
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
    writeExecutable(probe, '#!/bin/sh\nshift\nexec /bin/sh -c "$@"\n')
    vi.stubEnv('PATH', f.env.PATH)
    await expect(commandAvailableInInteractiveShell(f.name, probe, f.recipe)).resolves.toBe(true)
  })

  // OpenCode's installer downloads from GitHub Releases, which some networks cannot reach. A `curl |
  // bash` whose curl fails still exits 0, so both a silent and a failing first line must fall back.
  for (const [label, command] of [['exits 0 but installs nothing', 'true | sh'], ['fails', 'exit 7']]) {
    it(`installs the npm fallback when the first installer ${label}`, () => {
      const f = fixture()
      const result = f.run(f.runtime('node-one'), { ...f.recipe, command, fallback: f.recipe.command })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('trying the npm package instead')
      expect(result.stdout).toContain('ENGINE_READY:["argument with spaces"]')
      expect(existsSync(join(f.home, '.local/bin', f.name))).toBe(true)
    })
  }

  it('reports the fallback failure as the install failure', () => {
    const f = fixture()
    const result = f.run(f.runtime('node-one'), { ...f.recipe, command: 'true', fallback: 'exit 9' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('the install failed, so the agent was not started.')
    expect(result.stdout).toContain('trying the npm package instead')
    expect(result.stdout).not.toContain('ENGINE_READY:')
  })

  it('does not fall back after an install the person ended with Ctrl-C', () => {
    const f = fixture()
    const result = f.run(f.runtime('node-one'), { ...f.recipe, command: 'exit 130', fallback: f.recipe.command })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('trying the npm package instead')
    expect(result.stdout).not.toContain('trying the npm package instead')
    expect(result.stdout).toContain('the install failed, so the agent was not started.')
    expect(existsSync(join(f.home, '.local/bin', f.name))).toBe(false)
  })

  it('does not run the fallback when the first installer worked', () => {
    const f = fixture()
    const result = f.run(f.runtime('node-one'), { ...f.recipe, fallback: 'exit 9' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).not.toContain('trying the npm package instead')
    expect(result.stdout).toContain('ENGINE_READY:')
  })

  // Desktop Harness downloads the agents beside a fresh computer's setup and names the process in
  // ~/.harness/run/downloading-<engine>; native setup waits for it instead of installing twice.
  it('waits for the download Desktop Harness has under way instead of installing a second time', async () => {
    const f = fixture()
    const node = f.runtime('node-one')
    const run = join(f.home, '.harness/run')
    mkdirSync(run, { recursive: true })
    // Release the download only when native setup has observed its identity and reports waiting.
    const install = `read -r ready; npm_config_prefix=${shellSingleQuote(join(f.home, '.local'))} NPM_CONFIG_PREFIX=${shellSingleQuote(join(f.home, '.local'))} ${f.recipe.command}; exit $?`
    const download = spawn('/bin/sh', ['-c', install, 'harness-download'], {
      env: { ...f.env, PATH: `${join(node, '..')}:${f.env.PATH}` }, stdio: ['pipe', 'ignore', 'ignore'], detached: true,
    })
    const closed = new Promise<void>(resolve => download.once('close', () => resolve()))
    try {
      writeFileSync(join(run, 'downloading-codex'), String(download.pid))
      let released = false
      const result = await f.runAsync(node, { ...f.recipe, command: 'exit 93' }, '/bin/sh', output => {
        if (released || !output.includes('Codex is downloading in the background')) return
        released = true; download.stdin.end('ready\n')
      })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(released).toBe(true)
      expect(existsSync(join(f.home, '.local/bin', f.name))).toBe(true)
    } finally {
      try { process.kill(-download.pid!, 'SIGKILL') } catch {}
      await closed
    }
  }, 20_000)

  it('ends native setup rather than installing again after interruption during a download', async () => {
    const f = fixture()
    const node = f.runtime('node-one')
    const run = join(f.home, '.harness/run')
    mkdirSync(run, { recursive: true })
    const download = spawn('/bin/sh', ['-c', 'read -r finish; :', 'harness-download'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true })
    const closed = new Promise<void>(resolve => download.once('close', () => resolve()))
    try {
      writeFileSync(join(run, 'downloading-codex'), String(download.pid))
      const installed = join(f.home, 'installed-again')
      let interrupted = false
      const result = await f.runAsync(node, { ...f.recipe, command: `touch ${shellSingleQuote(installed)}` }, '/bin/sh', (output, pid) => {
        if (interrupted || !output.includes('Codex is downloading in the background')) return
        interrupted = true
        process.kill(-pid, 'SIGINT')
      })
      expect(interrupted).toBe(true)
      expect(result).toMatchObject({ status: null, signal: 'SIGINT' })
      expect(existsSync(installed)).toBe(false)
    } finally {
      try { process.kill(-download.pid!, 'SIGKILL') } catch {}
      await closed
    }
  })

  it('ignores a download marker whose process is gone or is something else', () => {
    const f = fixture()
    const run = join(f.home, '.harness/run')
    mkdirSync(run, { recursive: true })
    // A pid that is alive but not a download (this test runner), then one that is not alive at all.
    writeFileSync(join(run, 'downloading-codex'), String(process.pid))
    const busy = f.run(f.runtime('node-one'))
    expect(busy.status, busy.stdout + busy.stderr).toBe(0)
    expect(busy.stdout).toContain('ENGINE_READY:')
    const g = fixture()
    mkdirSync(join(g.home, '.harness/run'), { recursive: true })
    writeFileSync(join(g.home, '.harness/run/downloading-codex'), '999999')
    const gone = g.run(g.runtime('node-one'))
    expect(gone.status, gone.stdout + gone.stderr).toBe(0)
    expect(gone.stdout).toContain('ENGINE_READY:')
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
