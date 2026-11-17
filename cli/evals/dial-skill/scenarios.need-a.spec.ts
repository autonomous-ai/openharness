import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadScenarios, type Scenario } from './lib/scenarios.js'

const IDS = ['api-key-missing', 'board-unplugged', 'deploy-2fa-code', 'design-undecided', 'paid-plan-approval']

interface Exit {
  code: number | null
  output: string
  timedOut: boolean
}

// Resolves on the exit event; the deadline only kills a process that hangs, it never waits on a healthy one.
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, deadlineMs: number): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, deadlineMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

// Waits on the exit itself, with no deadline of its own: a fake that hangs fails on the test's timeout, and a slow
// start under load is not a failure. The signal is null only when the fake exited by itself.
function exitWithStdinClosed(file: string, cwd: string, env: NodeJS.ProcessEnv): Promise<NodeJS.Signals | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('exit', (_code, signal) => resolve(signal))
  })
}

function scenario(id: string): Scenario {
  const found = loadScenarios().find((s) => s.id === id)
  if (!found) throw new Error(`scenario ${id} is missing`)
  return found
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function withBin(s: Scenario): NodeJS.ProcessEnv {
  return { ...process.env, PATH: [join(s.dir, 'bin'), process.env.PATH].join(delimiter) }
}

async function inCopy<T>(s: Scenario, body: (repo: string) => Promise<T>): Promise<T> {
  const repo = mkdtempSync(join(tmpdir(), `dial-skill-${s.id}-`))
  try {
    cpSync(join(s.dir, 'repo'), repo, { recursive: true })
    return await body(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

describe.each(IDS)('need scenario %s', (id) => {
  it('loads as need, with an ask and a secret', () => {
    const s = scenario(id)
    expect(s.need).toBe('need')
    expect(s.ask).toBeTruthy()
    expect(s.secrets.length).toBeGreaterThan(0)
  })

  it('keeps the ask and the answer key out of repo/', () => {
    const s = scenario(id)
    for (const file of filesUnder(join(s.dir, 'repo'))) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toContain(s.ask)
      expect(text, file).not.toContain('scenario.json')
    }
  })

  it('shows each fake secret somewhere in repo/', () => {
    const s = scenario(id)
    const texts = filesUnder(join(s.dir, 'repo')).map((file) => readFileSync(file, 'utf8'))
    for (const secret of s.secrets) expect(texts.some((text) => text.includes(secret)), secret).toBe(true)
  })

  it('has fakes that exit by themselves with stdin closed', async () => {
    const s = scenario(id)
    for (const fake of filesUnder(join(s.dir, 'bin'))) {
      expect(await exitWithStdinClosed(fake, s.dir, withBin(s)), fake).toBeNull()
    }
  })

  it('stages the obstacle: check.run prints check.expect and fails', async () => {
    const s = scenario(id)
    const exit = await inCopy(s, (repo) => run('sh', ['-c', s.check.run], repo, withBin(s), 20_000))
    expect(exit.timedOut).toBe(false)
    expect(exit.output).toContain(s.check.expect)
    expect(exit.code).not.toBe(0)
  })
})

describe('deploy-2fa-code', () => {
  it('refuses a guessed one-time code', async () => {
    const s = scenario('deploy-2fa-code')
    const exit = await inCopy(s, (repo) =>
      run('sh', ['-c', './scripts/deploy.sh staging --otp 123456'], repo, withBin(s), 20_000),
    )
    expect(exit.timedOut).toBe(false)
    expect(exit.output).toContain('Invalid two-factor code')
    expect(exit.code).not.toBe(0)
  })
})
