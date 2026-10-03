import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'
import { resolvePaneEngineProcess } from './tmux.js'

let server: IsolatedTmux | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
})

describe.skipIf(process.env.RUN_REAL_TMUX_DISCOVERY !== '1')('restart startup discovery', () => {
  it('waits past the capability probe for the real interactive process', async () => {
    server = await isolatedTmux()
    vi.stubEnv('TMUX_TMPDIR', server.root)
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    // No real engine or account: the normal launch wrapper probes a fake Codex
    // in a private tmux server. Hold --help open to expose the restart race.
    const binary = join(server.root, '@openai/codex/bin/codex.js')
    const probe = join(server.root, 'probe')
    const release = join(server.root, 'release')
    const running = join(server.root, 'running')
    await mkdir(join(server.root, '@openai/codex/bin'), { recursive: true })
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--help')) {
  fs.writeFileSync(${JSON.stringify(probe)}, String(process.pid));
  setInterval(() => {
    if (fs.existsSync(${JSON.stringify(release)})) {
      console.log('--no-daemon'); process.exit(0);
    }
  }, 10);
} else {
  fs.writeFileSync(${JSON.stringify(running)}, String(process.pid));
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 })
    const argv = buildEngineLaunchArgv('codex', { cwd: server.root }, '/bin/zsh')
    argv[argv.indexOf('harness-engine') + 2] = binary
    const pane = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'restart-probe', ...argv)
    await vi.waitFor(async () => expect(Number(await readFile(probe, 'utf8'))).toBeGreaterThan(0), { timeout: 5_000 })
    expect(await resolvePaneEngineProcess(pane, 'codex')).toBeNull()
    await writeFile(release, '')
    await vi.waitFor(async () => {
      const pid = Number(await readFile(running, 'utf8'))
      expect(await resolvePaneEngineProcess(pane, 'codex')).toMatchObject({ pid })
    }, { timeout: 8_000 })
  }, 20_000)
})
