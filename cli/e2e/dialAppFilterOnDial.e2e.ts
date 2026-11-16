/**
 * The dial's app filter on a real dial, as a person walks it (docs/specs/2026-11-14-dial-app-filter.md): an isolated
 * daemon on the dial's serial port, fake Claude Codes in real terminal apps' tabs (each tab names its app, and the app
 * can be brought to the front), and the Harness Device app's debug build telling the rig's devices which app is in
 * front through this checkout's `harness hardware watch`. The person follows the lines it prints, then ends the run.
 * The Harness window is the rig's own (a LocalClient on its daemon), driven by files the person touches; Harness
 * Desktop itself is never pointed at the rig's daemon, since it would start and reach the everyday one instead. The rig
 * stops by itself for a dial that does not say `appFilter`, and never offers it firmware.
 *
 * Opt-in, because it takes a dial and a person: `ON_DIAL_PORT=/dev/cu.usbmodem… ON_DIAL_OUT=<folder>
 * npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilterOnDial.e2e.ts`. ON_DIAL_MINUTES (default 45) bounds the
 * walk. The rig's daemon has its own home and data folder: the everyday daemon, its dial and ~/.harness are untouched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tellDevices } from '../src/devices/listenerClient.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const PORT = process.env.ON_DIAL_PORT
const OUT = process.env.ON_DIAL_OUT
const MINUTES = Number(process.env.ON_DIAL_MINUTES ?? 45)

// How `harness hardware watch` is started, as e2e/hardwareWatch.e2e.ts starts it: the run's bundle when there is one.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']
const DEVICE_APP = resolve(CLI_ROOT, '../device-app/src-tauri/target/debug/harness-device')
const CAUSES = ['front', 'pick', 'empty', 'notice']
const VIEWS = ['tabs', 'apps']

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

/** Every `app filter:` line says only what the filter may say: a switch, the picker or the view, and never an app. */
function expectFilterLines(log: string): void {
  for (const line of log.split('\n').filter((line) => line.includes('app filter:'))) {
    expect(line).toMatch(/\[device\] app filter: (switched · (front|pick|empty|notice)|picker|view (tabs|apps) · (front|pick|window|empty)|bring · (ok|failed))$/)
  }
}

/** The dial's greeting (`cable: dial … caps swarms,recap,appFilter`) names appFilter among its caps. */
function saysAppFilter(greeting: string): boolean {
  return / caps (\S+)/.exec(greeting)?.[1].split(',').includes('appFilter') ?? false
}

/** A Harness agent made through the window, the fake Claude Code in the rig's projects folder, once it is bound. */
async function createAgent(d: IsolatedDaemon, window: LocalClient, name: string): Promise<string> {
  const cwd = join(d.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  if (created.error) throw new Error(`${name}: ${JSON.stringify(created.error)}`)
  const agentId: string = created.agent.id
  await until(`${name} to bind its conversation`, async () => {
    const { agents } = await window.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)
    const agent = agents.find((row) => row.id === agentId)
    return agent?.sessionId && agent.status === 'active'
  }, 60_000, 500)
  return agentId
}

/** The files the person touches in ON_DIAL_OUT to drive the rig's window, in the order the rig acts on them. */
const STEPS = ['window', 'focus', 'tab', 'harness', 'close'] as const

/** The rig's own Harness window on its daemon: two tabs, `t1` with h1 and h2 and `t2` with h3, said as the desktop
 *  says them; and "Harness in front" told to the devices as the watch tells it. */
function rigWindow(d: IsolatedDaemon): { act: Record<(typeof STEPS)[number], () => Promise<string>>; close: () => void } {
  let window: LocalClient | undefined
  let agents: Record<'h1' | 'h2' | 'h3', string> | undefined
  const open = (): { window: LocalClient; agents: Record<'h1' | 'h2' | 'h3', string> } => {
    if (!window || !agents) throw new Error('no window: touch window first')
    return { window, agents }
  }
  const show = (active: 't1' | 't2', focus: 'h1' | 'h2' | 'h3'): void => {
    const { window, agents } = open()
    const tabs = { t1: [agents.h1, agents.h2], t2: [agents.h3] }
    window.send('app_swarms', { active, swarms: [
      { id: 't1', name: 'Tab 1', agentIds: tabs.t1, panes: 2 },
      { id: 't2', name: 'Tab 2', agentIds: tabs.t2, panes: 1 },
    ], tiles: [] })
    window.send('app_panes', { agentIds: tabs[active], foreground: true })
    window.send('app_focus', { agentId: agents[focus] })
  }
  return {
    act: {
      window: async () => {
        if (window) throw new Error('a window is open already')
        window = await LocalClient.connect(d)
        agents = { h1: await createAgent(d, window, 'h1'), h2: await createAgent(d, window, 'h2'), h3: await createAgent(d, window, 'h3') }
        show('t1', 'h1')
        return 'window: open, tab t1 with h1 and h2, tab t2 with h3, on t1, focus h1'
      },
      focus: async () => { show('t1', 'h2'); return 'focus: h2' },
      tab: async () => { show('t2', 'h3'); return 'tab: t2, focus h3' },
      // As the watch tells it, without a second watch: Harness Device's watch keeps its `tabs` stream.
      harness: async () => {
        if (!await tellDevices(d.dataDir, { type: 'front', app: 'harness' })) throw new Error('the devices did not take Harness in front')
        return 'harness: in front'
      },
      close: async () => {
        open().window.close()
        window = undefined
        agents = undefined
        return 'close: the window is closed'
      },
    },
    close: () => window?.close(),
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

  it('the rig\'s log check takes the view\'s lines and refuses one that names an app', () => {
    expectFilterLines('[device] app filter: view apps · front\n[device] app filter: view tabs · pick\n' +
      '[device] app filter: view tabs · empty\n[device] app filter: switched · front\n[device] app filter: bring · ok')
    expect(() => expectFilterLines('[device] app filter: view apps · front ghostty')).toThrow()
  })

  it('the rig knows a greeting that says appFilter', () => {
    expect(saysAppFilter('cable: dial aa:bb on fw 0.0.95 proto 2 caps swarms,recap,appFilter')).toBe(true)
    expect(saysAppFilter('cable: dial aa:bb on fw 0.0.90 proto 2 caps swarms,recap')).toBe(false)
    expect(saysAppFilter('cable: dial aa:bb on fw 0.0.90 proto 2')).toBe(false)
  })
})

describe.skipIf(!PORT)('the dial\'s app filter on a real dial', () => {
  it('a person walks the filter on the dial; the log says only what the filter may say', async () => {
    if (!OUT) throw new Error('ON_DIAL_PORT is set but ON_DIAL_OUT is not: the rig needs a folder for its files')
    // CABLE_FW_DISABLE stays true (the suite's default): this daemon offers the dial no firmware. The real open, not the
    // suite's fake: a pick on the dial brings its app forward, and the person at the desk walking this opt-in rig is
    // there to see it come (the PM, 2026-11-16).
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', HARNESSD_TEST_DIAL_PORT: PORT!, HARNESS_OPEN_BIN: '/usr/bin/open' } })
    const rig = rigWindow(d)
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
        `The rig's window:             touch ${STEPS.map((step) => quote(join(OUT, step))).join(' | ')}\n` +
        `When done:                    touch ${quote(done)}`)
      // Not thrown here: without a dial the run still ends on `done`, and the greeting is asserted below.
      greeted = await until('the dial to greet', () => d.log().match(/cable: dial \S+ (?:back )?on fw [^\n]*/)?.[0], 60_000, 500)
        .catch(() => undefined)
      console.log(greeted ?? 'The dial has not greeted.')
      if (greeted && !saysAppFilter(greeted)) {
        console.log('This dial does not say appFilter. Stop here: ask before any flash.')
        throw new Error('the dial does not say appFilter')
      }
      // A step that fails ends the walk: `until` would only retry it, and its file is gone.
      let failed: unknown
      await until(done, async () => {
        for (const step of STEPS) {
          const file = join(OUT, step)
          if (!existsSync(file)) continue
          rmSync(file)
          try { console.log(await rig.act[step]()) } catch (error) { failed = error; return true }
        }
        return existsSync(done)
      }, MINUTES * 60_000, 1_000)
      if (failed) throw failed
    } finally {
      rig.close()
      // The daemon's own output, nothing of the rig's.
      log = d.log()
      writeFileSync(join(OUT, 'daemon.log'), log, { mode: 0o600 })
      const lines = log.split('\n')
      const count = (text: string) => lines.filter((line) => line.includes(text)).length
      console.log(`${CAUSES.map((cause) => `switched · ${cause}: ${count(`[device] app filter: switched · ${cause}`)}`).join(', ')}, ` +
        `picker: ${count('[device] app filter: picker')}, ` +
        `${VIEWS.map((view) => `view ${view}: ${count(`[device] app filter: view ${view} ·`)}`).join(', ')}`)
      await d.close()
    }

    expect(greeted, 'the dial never greeted').toBeDefined()
    const lines = log.split('\n')
    expectFilterLines(log)
    expect(log).toContain('[devices] listener open')
    for (const line of lines.filter((line) => line.includes('[devices] listener'))) {
      expect(line).toMatch(/\[devices\] listener (open|in the last minute: \d+ unknown, \d+ oversized, \d+ over rate, \d+ refused, \d+ failed)$/)
    }
    expect(log).not.toContain('dial front')
    expect(log).not.toContain('dial_front')
  }, (MINUTES + 10) * 60_000)
})
