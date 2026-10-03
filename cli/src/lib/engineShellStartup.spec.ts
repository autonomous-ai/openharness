import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { buildEngineCommandArgv, buildEngineLaunchArgv, commandAvailableInInteractiveShell, commandSupportsFlagInInteractiveShell } from './engineLaunch.js'

const zsh = ['/bin/zsh', '/usr/bin/zsh'].find(existsSync)
const engines = ['claude', 'opencode', 'codex'] as const
const prompt = 'Keep spaces, "quotes", $(false), `false`, & ! ^\nand newlines'
const roots: string[] = []
let server: IsolatedTmux | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-shell-startup-')))
  roots.push(dir)
  // The updater's one-key prompt occurs in .zshrc, BEFORE the -c launch script.
  // The negative control below proves it really blocks a terminal, without
  // loading or updating the developer's own Oh My Zsh installation.
  writeFileSync(join(dir, '.zshrc'), `
if [[ "$DISABLE_AUTO_UPDATE" != true ]]; then
  printf '[oh-my-zsh] Would you like to update? [Y/n] '
  read -r -k 1 answer
  exit 79
fi
export HARNESS_RC_LOADED=yes
`)
  writeFileSync(join(dir, '.zprofile'), 'export HARNESS_LOGIN_LOADED=yes\n')
  const binary = join(dir, "engine with 'quotes")
  const result = join(dir, 'result.json')
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--help')) { console.log('--no-daemon --auto'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  rc: process.env.HARNESS_RC_LOADED, login: process.env.HARNESS_LOGIN_LOADED,
  tty: [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY],
}));
console.log('ENGINE_READY');
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on('data', data => console.log('INPUT:' + data.toString()));
}
`, { mode: 0o755 })
  vi.stubEnv('ZDOTDIR', dir)
  vi.stubEnv('DISABLE_AUTO_UPDATE', 'false')
  return {
    dir, binary,
    result: () => JSON.parse(readFileSync(result, 'utf8')),
    command(engine: typeof engines[number], resume = false) {
      const options = { cwd: dir, firstPrompt: prompt, ...(resume ? { resumeSessionId: 'saved-session' } : {}) }
      const argv = buildEngineLaunchArgv(engine, options, zsh, undefined, 'grid', null)
      // Substitute only the executable; exercise the full production wrapper
      // and its real positional cwd, resume flags and handoff prompt.
      argv[argv.indexOf('harness-engine') + 2] = binary
      return { argv, expected: [...(engine === 'codex' ? ['--no-daemon'] : []), ...buildEngineCommandArgv(engine, options).slice(1)] }
    },
  }
}

describe.skipIf(!zsh)('agent startup in a real zsh login shell', () => {
  for (const engine of engines) for (const resume of [false, true]) {
    it(`${engine} ${resume ? 'resume' : 'fresh launch'} skips updates before rc and preserves workspace/arguments`, () => {
      const f = fixture()
      const { argv, expected } = f.command(engine, resume)
      const output = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
      expect(output).not.toContain('Would you like to update?')
      expect(f.result()).toMatchObject({ args: expected, cwd: f.dir, rc: 'yes', login: 'yes' })
    })
  }

  it('availability and capability probes also skip startup maintenance', async () => {
    const f = fixture()
    await expect(commandAvailableInInteractiveShell(f.binary, zsh)).resolves.toBe(true)
    await expect(commandSupportsFlagInInteractiveShell(f.binary, '--auto', zsh)).resolves.toBe('supported')
    await expect(commandSupportsFlagInInteractiveShell(f.binary, '--missing', zsh)).resolves.toBe('unsupported')
    expect(process.env.DISABLE_AUTO_UPDATE).toBe('false')
  })
})

describe.skipIf(!zsh || process.env.RUN_REAL_TMUX_DISCOVERY !== '1' || !resolveBinaryOnPath('tmux'))('startup prompts in an isolated real tmux terminal', () => {
  it.each(engines)('%s starts and accepts input even when the normal shell would wait for an update', async engine => {
    const f = fixture()
    server = await isolatedTmux()
    const pane = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'startup', zsh!, '-lic', 'echo SHOULD_NOT_RUN')
    const screen = () => server!.run('capture-pane', '-p', '-t', pane)
    const waitFor = async (text: string) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        if ((await screen()).includes(text)) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(`Missing ${text}: ${await screen()}`)
    }
    await waitFor('[oh-my-zsh] Would you like to update? [Y/n]')
    expect(await screen()).not.toContain('SHOULD_NOT_RUN')
    const { argv, expected } = f.command(engine)
    await server.run('respawn-pane', '-k', '-t', pane, ...argv)
    await waitFor('ENGINE_READY')
    expect(f.result()).toMatchObject({ args: expected, cwd: f.dir, rc: 'yes', login: 'yes', tty: [true, true, true] })
    await server.run('send-keys', '-t', pane, '-l', 'y')
    await waitFor('INPUT:y')
    expect(await screen()).not.toContain('Would you like to update?')
  }, 15_000)
})
