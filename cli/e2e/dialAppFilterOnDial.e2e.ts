/**
 * The dial's app filter on a real dial, as a person walks it (docs/specs/2026-11-14-dial-app-filter.md): an isolated
 * daemon on the dial's serial port, fake Claude Codes in real terminal apps' tabs (each tab names its app, and the app
 * can be brought to the front), and the Harness Device app's debug build telling the rig's devices which app is in
 * front through this checkout's `harness hardware watch`. The person follows the lines it prints, then ends the run.
 *
 * Opt-in, because it takes a dial and a person: `ON_DIAL_PORT=/dev/cu.usbmodem… ON_DIAL_OUT=<folder>
 * npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilterOnDial.e2e.ts`. ON_DIAL_MINUTES (default 45) bounds the
 * walk. The rig's daemon has its own home and data folder: the everyday daemon, its dial and ~/.harness are untouched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const PORT = process.env.ON_DIAL_PORT
const OUT = process.env.ON_DIAL_OUT
const MINUTES = Number(process.env.ON_DIAL_MINUTES ?? 45)

// How `harness hardware watch` is started, as e2e/hardwareWatch.e2e.ts starts it: the run's bundle when there is one.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']
const DEVICE_APP = resolve(CLI_ROOT, '../device-app/src-tauri/target/debug/harness-device')
const CAUSES = ['front', 'pick', 'empty', 'notice']

/**
 * The only variables the rig's scripts set: the isolated daemon's own values (e2e/harness/daemon.ts `create`), which
 * are paths in its throwaway root, its port and test id, and the switches that keep a process off the network. They
 * point the engine, its hooks, the watch and the Device app at the rig's daemon. Everything else a script's process
 * inherits from the terminal that runs it: an environment holds secrets (Orca's pairing code, API tokens), and none
 * of it is written to a file.
 */
const RIG_VARIABLES = ['HOME', 'ZDOTDIR', 'TMPDIR', 'PORT', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'ADAPTER_COMPUTER_ID',
  'ADAPTER_COMPUTER_ID_FILE', 'HARNESS_AUTH_DIR', 'HARNESS_HOOK_ROUTES_DIR', 'DSH_DIR', 'CLAUDE_PATH', 'CODEX_PATH',
  'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'TMUX_TMPDIR', 'BACKEND_WS_URL', 'WEB_URL', 'ADAPTER_UPDATE_DISABLE',
  'ANALYTICS_ENABLED', 'NODE_ENV']

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** What the three scripts say, from the daemon's environment: only RIG_VARIABLES' values, its fake engines first on the
 *  inherited PATH, and the paths the rig names. */
function rigScripts(env: NodeJS.ProcessEnv, projectsDir: string, out: string): Record<'tab.sh' | 'harness' | 'device.sh', string> {
  const named = [
    ...RIG_VARIABLES.filter((name) => env[name] !== undefined).map((name) => `export ${name}=${quote(env[name]!)}`),
    `export PATH=${quote(dirname(env.CLAUDE_PATH!))}:"$PATH"`,
    // Not the person's: a tmux or Harness pane would make the agent Harness's, and a moved Claude Code home is the
    // person's (the daemon under test inherits none of these, src/testing/daemonEnvironment.ts, for the same reason).
    // The tab's own TERM_PROGRAM and __CFBundleIdentifier stay: they name its app.
    'unset TMUX TMUX_PANE HARNESS_PANE CLAUDE_CONFIG_DIR',
  ].join('\n')
  // loginItem true: the app never asks macOS for a login item (docs/plans/2026-11-13-device-menubar-plan.md).
  const state = JSON.stringify({ version: 1, cliSeen: false, askedSignIn: false, askedClaude: false, loginItem: true })
  return {
    'tab.sh': [
      named,
      `cwd=${quote(projectsDir)}/"\${1:?a folder name}"`,
      'mkdir -p "$cwd" && cd "$cwd" && exec "$CLAUDE_PATH"',
      '',
    ].join('\n'),
    // Under these variables (the rig's home and data folder) the watch finds the rig's devices.sock, never the
    // everyday daemon's.
    harness: [
      '#!/bin/sh',
      named,
      `cd ${quote(CLI_ROOT)} && exec ${[process.execPath, ...CLI_ENTRY].map(quote).join(' ')} "$@"`,
      '',
    ].join('\n'),
    'device.sh': [
      named,
      'dir="$HOME/Library/Application Support/ai.autonomous.harness.device"',
      `mkdir -p "$dir" && printf '%s' ${quote(state)} > "$dir/state.json"`,
      `HARNESS_DEVICE_CLI=${quote(join(out, 'harness'))} exec ${quote(DEVICE_APP)}`,
      '',
    ].join('\n'),
  }
}

/** A script sets no variable but RIG_VARIABLES and PATH. */
function expectNamedOnly(script: string): void {
  for (const line of script.split('\n').filter((line) => /^\s*export\b/.test(line))) {
    expect([...RIG_VARIABLES, 'PATH']).toContain(line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
  }
}

describe('the on-dial rig\'s scripts', () => {
  it('carry none of the environment but the rig\'s own variables', () => {
    const env: NodeJS.ProcessEnv = { ORCA_PAIRING_CODE: 'secret', ORCA_AGENT_SESSION_SPAWN_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', PATH: '/secret/bin' }
    for (const name of RIG_VARIABLES) env[name] = `/rig/${name}`
    for (const script of Object.values(rigScripts(env, '/rig/projects', '/rig/out'))) {
      expect(script).not.toContain('secret')
      expectNamedOnly(script)
    }
  })
})

describe.skipIf(!PORT)('the dial\'s app filter on a real dial', () => {
  it('a person walks the filter on the dial; the log says only what the filter may say', async () => {
    if (!OUT) throw new Error('ON_DIAL_PORT is set but ON_DIAL_OUT is not: the rig needs a folder for its files')
    // CABLE_FW_DISABLE stays true (the suite's default): this daemon offers the dial no firmware.
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', HARNESSD_TEST_DIAL_PORT: PORT! } })
    let greeted: string | undefined
    let log = ''
    try {
      await d.start()
      for (const [name, script] of Object.entries(rigScripts(d.env, d.projectsDir, OUT))) {
        writeFileSync(join(OUT, name), script, { mode: name === 'harness' ? 0o700 : 0o600 })
        expectNamedOnly(readFileSync(join(OUT, name), 'utf8'))
      }
      const done = join(OUT, 'done')
      console.log(`In a terminal tab, an agent:  sh ${quote(join(OUT, 'tab.sh'))} a1\n` +
        `The Harness Device app:       sh ${quote(join(OUT, 'device.sh'))}\n` +
        `When done:                    touch ${quote(done)}`)
      // Not thrown here: without a dial the run still ends on `done`, and the greeting is asserted below.
      greeted = await until('the dial to greet', () => d.log().match(/cable: dial \S+ (?:back )?on fw [^\n]*/)?.[0], 60_000, 500)
        .catch(() => undefined)
      console.log(greeted ?? 'The dial has not greeted.')
      await until(done, () => existsSync(done), MINUTES * 60_000, 1_000)
    } finally {
      // The daemon's own output, nothing of the rig's.
      log = d.log()
      writeFileSync(join(OUT, 'daemon.log'), log, { mode: 0o600 })
      const lines = log.split('\n')
      const count = (text: string) => lines.filter((line) => line.includes(text)).length
      console.log(`${CAUSES.map((cause) => `switched · ${cause}: ${count(`[device] app filter: switched · ${cause}`)}`).join(', ')}, ` +
        `picker: ${count('[device] app filter: picker')}`)
      await d.close()
    }

    expect(greeted, 'the dial never greeted').toBeDefined()
    const lines = log.split('\n')
    for (const line of lines.filter((line) => line.includes('app filter:'))) {
      expect(line).toMatch(/\[device\] app filter: (switched · (front|pick|empty|notice)|picker)$/)
    }
    expect(log).toContain('[devices] listener open')
    for (const line of lines.filter((line) => line.includes('[devices] listener'))) {
      expect(line).toMatch(/\[devices\] listener (open|in the last minute: \d+ unknown, \d+ oversized, \d+ over rate, \d+ refused, \d+ failed)$/)
    }
    expect(log).not.toContain('dial front')
    expect(log).not.toContain('dial_front')
  }, (MINUTES + 10) * 60_000)
})
