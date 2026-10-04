import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { buildEngineCommandArgv, buildEngineLaunchArgv, type LaunchCommandOptions } from './engineLaunch.js'

const real = process.env.RUN_REAL_TMUX_DISCOVERY === '1' ? describe : describe.skip
const updated = '🎉 Update ran successfully! Please restart Codex.'
const timeout = 'Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery timed out (code -32603)'
const prompt = 'Fix this image: "quotes", $(false), `false`, ; & !\nand a second line'
type Attempt = { args: string[]; tty: boolean[]; cwd: string; codexHome: string }

real('Codex update restart in an isolated real tmux pane', () => {
  let server: IsolatedTmux | undefined
  const dirs: string[] = []
  afterEach(async () => {
    await server?.close()
    server = undefined
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function launch({
    shell = '/bin/sh', outputs = [updated], status = 0, options = {}, older = false,
  }: {
    shell?: string; outputs?: string[]; status?: number; options?: LaunchCommandOptions; older?: boolean
  } = {}) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "codex update 'fixture-")))
    dirs.push(dir)
    const state = join(dir, 'attempts.json')
    const image = join(dir, "image with 'quotes.png")
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG9kAAAAASUVORK5CYII=', 'base64')
    await writeFile(state, '[]')
    await writeFile(image, imageBytes)
    const binary = join(dir, 'codex')
    // This models the observed updater boundary without installing software or
    // contacting an account: a real update prompt, real TTYs, and Codex's final
    // success line. Successful starts remain interactive in the same pane.
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const state = ${JSON.stringify(state)};
const attempts = JSON.parse(fs.readFileSync(state, 'utf8'));
if (process.argv.includes('--help')) {
  console.log(${older} && attempts.length === 0 ? '--model' : '--no-daemon');
  process.exit(0);
}
attempts.push({ args: process.argv.slice(2), tty: [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY], cwd: process.cwd(), codexHome: process.env.CODEX_HOME });
fs.writeFileSync(state, JSON.stringify(attempts));
const output = ${JSON.stringify(outputs)}[attempts.length - 1];
process.stdin.setRawMode(true);
if (output === ${JSON.stringify(timeout)}) { console.error(output); process.exit(1); }
if (output !== undefined) {
  console.log('UPDATE_PROMPT');
  process.stdin.once('data', () => {
    process.stdin.setRawMode(false);
    console.log(output);
    process.exit(${status});
  });
} else {
  console.log('CODEX_READY');
  process.stdin.on('data', data => console.log('INPUT:' + data.toString()));
}
`, { mode: 0o755 })
    server = await isolatedTmux({ ...process.env, ZDOTDIR: dir, CODEX_HOME: dir })
    const launchOptions = { cwd: dir, permissionMode: 'auto', firstPrompt: prompt, extraArgs: ['--image', image, '--model', 'chosen-model'], ...options }
    const command = buildEngineLaunchArgv('codex', launchOptions, shell, undefined, 'grid', resolveBinaryOnPath('tmux'))
    command[command.indexOf('harness-engine') + 2] = binary
    if (shell.endsWith('/bash')) command.splice(1, 0, '--norc')
    const pane = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-x', '40', '-y', '12', '-s', 'update', ...command)
    const screen = () => server!.run('capture-pane', '-p', '-J', '-t', pane)
    const attempts = async () => JSON.parse(await readFile(state, 'utf8')) as Attempt[]
    const exited = () => server!.run('show-option', '-p', '-v', '-t', pane, '@harness_engine_exit').catch(() => '')
    const waitFor = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (await check()) return
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      throw new Error(`condition not met: ${await screen()}`)
    }
    const accept = () => server!.run('send-keys', '-t', pane, 'Enter')
    await waitFor(async () => (await screen()).includes('UPDATE_PROMPT'))
    return { pane, screen, attempts, exited, waitFor, accept, dir, image, imageBytes, launchOptions }
  }

  it.each(['/bin/sh', '/bin/bash', '/bin/zsh'].filter(existsSync))('continues the original task and image in %s without handing off to a shell', async shell => {
    const f = await launch({ shell, older: true })
    expect(await f.exited()).toBe('')
    await f.accept()
    await f.waitFor(async () => (await f.screen()).includes('CODEX_READY'))
    const attempts = await f.attempts()
    expect(attempts).toHaveLength(2)
    const original = buildEngineCommandArgv('codex', f.launchOptions).slice(1)
    // The replacement is probed again: an update may introduce --no-daemon.
    expect(attempts[0].args).toEqual(original)
    expect(attempts[1].args).toEqual(['--no-daemon', ...original])
    for (const attempt of attempts) {
      expect(attempt.tty).toEqual([true, true, true])
      expect(attempt.cwd).toBe(f.dir)
      expect(attempt.codexHome).toBe(f.dir)
    }
    expect(await readFile(f.image)).toEqual(f.imageBytes)
    expect(await f.exited()).toBe('')
    expect(await f.screen()).not.toContain('This pane is a shell now')
    await server!.run('send-keys', '-t', f.pane, '-l', 'follow-up')
    await f.waitFor(async () => (await f.screen()).includes('INPUT:follow-up'))
  }, 15_000)

  it.each(['resumeSessionId', 'forkSessionId'] as const)('preserves an explicit %s through the startup update', async key => {
    const f = await launch({ options: { [key]: 'specific-conversation' } })
    await f.accept()
    await f.waitFor(async () => (await f.screen()).includes('CODEX_READY'))
    const attempts = await f.attempts()
    expect(attempts).toHaveLength(2)
    expect(attempts[1].args).toEqual(attempts[0].args)
    expect(attempts[1].args.slice(0, 3)).toEqual(['--no-daemon', key === 'resumeSessionId' ? 'resume' : 'fork', 'specific-conversation'])
    expect(await f.exited()).toBe('')
  })

  it.each([
    { output: 'Goodbye!', status: 0 },
    { output: 'Update failed', status: 1 },
    { output: updated, status: 130 },
    { output: updated, status: 1 },
  ])('leaves normal exits, failures and cancellation alone: $status $output', async ({ output, status }) => {
    const f = await launch({ outputs: [output], status })
    await f.accept()
    await f.waitFor(async () => await f.exited() === String(status))
    expect(await f.attempts()).toHaveLength(1)
    expect(await f.screen()).toContain('This pane is a shell now')
  })

  it('bounds update restarts even when the replacement requests another restart', async () => {
    const f = await launch({ outputs: [updated, updated] })
    await f.accept()
    await f.waitFor(async () => (await f.attempts()).length === 2)
    await f.accept()
    await f.waitFor(async () => await f.exited() === '0')
    expect(await f.attempts()).toHaveLength(2)
  })

  it('still recovers a bootstrap timeout after the update', async () => {
    const f = await launch({ outputs: [updated, timeout] })
    await f.accept()
    await f.waitFor(async () => (await f.screen()).includes('CODEX_READY'))
    const attempts = await f.attempts()
    expect(attempts).toHaveLength(3)
    expect(attempts[2].args).toEqual(attempts[0].args)
    expect(await f.exited()).toBe('')
  }, 15_000)
})
