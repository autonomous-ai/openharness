import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadScenarios, type Scenario } from './lib/scenarios.js'
import { stage, unstage } from './lib/stage.js'

const IDS = ['gh-signed-out', 'rate-limit-unknown', 'sso-expired', 'vpn-internal-host', 'xcode-license-sudo']

function find(id: string): Scenario {
  const s = loadScenarios().find((x) => x.id === id)
  if (!s) throw new Error(`scenario ${id} not found`)
  return s
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function fakes(s: Scenario): string[] {
  const bin = join(s.dir, 'bin')
  return existsSync(bin) ? readdirSync(bin).map((name) => join(bin, name)) : []
}

// No ~/.local/bin or /opt/homebrew/bin: the real signed-in gh and the real harness must stay out of reach.
function env(s: Scenario, home: string): NodeJS.ProcessEnv {
  const path = [join(s.dir, 'bin'), dirname(process.execPath), '/usr/bin:/bin:/usr/sbin:/sbin'].join(':')
  return { PATH: path, HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8' }
}

function exitWithStdinClosed(file: string, e: NodeJS.ProcessEnv): Promise<NodeJS.Signals | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], { stdio: ['ignore', 'ignore', 'ignore'], env: e, timeout: 2_000 })
    child.on('error', reject)
    child.on('exit', (_code, signal) => resolve(signal))
  })
}

describe.each(IDS)('need scenario %s', (id) => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'dial-skill-need-b-'))
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('loads as need with an ask and secrets', () => {
    const s = find(id)
    expect(s.need).toBe('need')
    expect(s.ask).toBeTruthy()
    expect(s.secrets.length).toBeGreaterThan(0)
  })

  it('keeps the ask and the label file out of repo/', () => {
    const s = find(id)
    for (const file of filesUnder(join(s.dir, 'repo'))) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toContain(s.ask)
      expect(text, file).not.toContain('scenario.json')
    }
  })

  it('holds each secret, a FAKE marker, in some repo/ file', () => {
    const s = find(id)
    const texts = filesUnder(join(s.dir, 'repo')).map((file) => readFileSync(file, 'utf8'))
    for (const secret of s.secrets) {
      expect(secret).toContain('FAKE')
      expect(texts.some((text) => text.includes(secret)), secret).toBe(true)
    }
  })

  // The network stays on during runs, so a named host must never resolve (RFC 2606).
  it('names only .invalid hosts in repo/ and bin/', () => {
    const s = find(id)
    for (const file of [...filesUnder(join(s.dir, 'repo')), ...fakes(s)]) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of [/https?:\/\/([^/\s:"'`]+)/g, /@([a-z0-9.-]+\.[a-z]+)/g]) {
        for (const [, host] of text.matchAll(pattern)) expect(host, file).toMatch(/\.invalid$/)
      }
    }
  })

  it('has fakes that resolve first on PATH and exit within 2 s with stdin closed', async () => {
    const s = find(id)
    const e = env(s, work)
    for (const file of fakes(s)) {
      const name = file.slice(join(s.dir, 'bin').length + 1)
      const which = spawnSync('sh', ['-c', `command -v ${name}`], { env: e, encoding: 'utf8' })
      expect(which.stdout.trim()).toBe(file)
      expect(await exitWithStdinClosed(file, e), file).toBeNull()
    }
  })

  it('fails its check in a copy of repo/ with the expected output', () => {
    const s = find(id)
    const repo = join(work, 'repo')
    cpSync(join(s.dir, 'repo'), repo, { recursive: true })
    const run = spawnSync('sh', ['-c', s.check.run], {
      cwd: repo,
      env: env(s, work),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(run.signal).toBeNull()
    expect(run.status).not.toBe(0)
    expect(run.stdout + run.stderr).toContain(s.check.expect)
  })
})

describe('gh-signed-out', () => {
  // The prompt asks for a pull request for "the fix on this branch": the fix is there, committed and not yet pushed.
  it('stages on fix/typo, one commit ahead of the main on origin, with its check still stopping at sign-in', () => {
    const s = find('gh-signed-out')
    const st = stage(s, 'oracle', { skill: false })
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: st.repo, env: st.env, encoding: 'utf8' })
      expect(git('branch', '--show-current')).toBe('fix/typo\n')
      expect(git('rev-list', '--count', 'origin/main..HEAD')).toBe('1\n')
      const run = spawnSync('sh', ['-c', s.check.run], {
        cwd: st.repo,
        env: st.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 20_000,
      })
      expect(run.status).not.toBe(0)
      expect(run.stdout + run.stderr).toContain(s.check.expect)
    } finally {
      unstage(st)
    }
  })
})

describe('xcode-license-sudo', () => {
  // The real xcrun would find the real, licensed xcodebuild and route round the obstacle.
  it('stops `xcrun xcodebuild` on the same license error', () => {
    const s = find('xcode-license-sudo')
    const st = stage(s, 'oracle', { skill: false })
    try {
      const run = spawnSync('sh', ['-c', 'xcrun xcodebuild -version'], {
        cwd: st.repo,
        env: st.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 20_000,
      })
      expect(run.status).not.toBe(0)
      expect(run.stdout + run.stderr).toContain(s.check.expect)
    } finally {
      unstage(st)
    }
  })
})
