import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'

const exec = promisify(execFile)
const real = process.env.RUN_REAL_TMUX_CODEX_STARTUP === '1' ? describe : describe.skip
const timeout = 'Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)'

real('Codex startup recovery in an isolated real tmux server', () => {
  const socket = `harness-startup-test-${randomUUID()}`
  const tmuxBin = resolveBinaryOnPath('tmux')!
  const dirs: string[] = []
  const tmux = async (...args: string[]) => (await exec(tmuxBin, ['-L', socket, '-f', '/dev/null', ...args], { timeout: 3000 })).stdout.trim()
  afterEach(async () => {
    await tmux('kill-server').catch(() => {})
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function eventually(check: () => Promise<boolean>, ms = 12_000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error(`condition not met; pane output: ${await tmux('capture-pane', '-p', '-J', '-t', '%0').catch(() => '')}`)
  }

  async function launch(failures: number, prompt?: string, exitStatus = 1, differentSecondError = false) {
    const dir = await mkdtemp(join(tmpdir(), 'harness-codex-startup-real-'))
    dirs.push(dir)
    const state = join(dir, 'attempts.json')
    await writeFile(state, '[]')
    // A faithful terminal boundary: the engine receives three real TTYs and
    // prints Codex's observed fatal error directly to stderr. No real account.
    await writeFile(join(dir, 'codex'), `#!${process.execPath}\n`
      + `const fs = require('node:fs');\n`
      + `if (process.argv.includes('--help')) { console.log('--no-daemon'); process.exit(0); }\n`
      + `const file = ${JSON.stringify(state)}; const attempts = JSON.parse(fs.readFileSync(file, 'utf8'));\n`
      + `attempts.push({ args: process.argv.slice(2), tty: [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY], cwd: process.cwd() });\n`
      + `fs.writeFileSync(file, JSON.stringify(attempts));\n`
      + `if (attempts.length <= ${failures}) { console.error(${differentSecondError ? `attempts.length === 1 ? ${JSON.stringify(timeout)} : 'Error: invalid configuration'` : JSON.stringify(timeout)}); process.exitCode = ${exitStatus}; }\n`
      + `else { console.log('STARTUP_RECOVERED'); process.stdin.resume(); }\n`, { mode: 0o755 })
    const command = buildEngineLaunchArgv('codex', { cwd: dir, firstPrompt: prompt, permissionMode: 'auto' }, '/bin/sh', undefined, 'grid', tmuxBin)
    // An interactive rc file may replace PATH. Never let a fixture resolve to
    // the developer's installed Codex, even when their shell does that.
    command[command.indexOf('codex')] = join(dir, 'codex')
    const pane = await tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-x', '40', '-y', '12', '-s', 'test', '-e', `PATH=${dir}:${process.env.PATH}`, ...command)
    const attempts = async () => JSON.parse(await readFile(state, 'utf8')) as Array<{ args: string[]; tty: boolean[]; cwd: string }>
    const screen = () => tmux('capture-pane', '-p', '-J', '-t', pane)
    const exit = () => tmux('show-option', '-p', '-v', '-t', pane, '@harness_engine_exit').catch(() => '')
    return { pane, attempts, screen, exit, dir }
  }

  it.each([undefined, 'Fix spaces, "quotes", $(printf literal), `false`, ; & ! ^\nand a second line'])('recovers the same launch with first prompt %s', async prompt => {
    const f = await launch(1, prompt)
    await eventually(async () => (await f.screen()).includes('STARTUP_RECOVERED'))
    const attempts = await f.attempts()
    expect(attempts).toHaveLength(2)
    for (const attempt of attempts) {
      expect(attempt.args).toEqual(['--no-daemon', '--approve-for-me', ...(prompt ? [prompt] : [])])
      expect(attempt.tty).toEqual([true, true, true])
      expect(attempt.cwd).toBe(await realpath(f.dir))
    }
    expect(await f.exit()).toBe('')
  }, 20_000)

  it('stops after three failed attempts and returns the final status to the shell', async () => {
    const f = await launch(100)
    await eventually(async () => await f.exit() === '1')
    expect(await f.attempts()).toHaveLength(3)
    expect(await f.screen()).toContain('This pane is a shell now')
  }, 20_000)

  it('does not retry other errors after a transient first failure', async () => {
    const f = await launch(100, undefined, 1, true)
    await eventually(async () => await f.exit() === '1')
    expect(await f.attempts()).toHaveLength(2)
  }, 20_000)

  it('does not retry a cancelled engine, even if timeout text remains visible', async () => {
    const f = await launch(100, undefined, 130)
    await eventually(async () => await f.exit() === '130')
    expect(await f.attempts()).toHaveLength(1)
  })

  it('honors Ctrl-C during retry backoff', async () => {
    const f = await launch(100)
    await eventually(async () => (await f.screen()).includes('Retrying startup (2/3)'))
    await tmux('send-keys', '-t', f.pane, 'C-c')
    await eventually(async () => await f.exit() === '130')
    expect(await f.attempts()).toHaveLength(1)
    expect(await f.screen()).toContain('This pane is a shell now')
  }, 15_000)
})
