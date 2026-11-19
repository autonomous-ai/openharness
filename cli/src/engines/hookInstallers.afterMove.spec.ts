/**
 * After the move (docs/plans/2026-11-18-linux-xdg-paths-design.md, "After the move"): the engines' files an install from
 * `~/.harness` wrote name its Node, its notify.mjs and its data folder. The core's next start, from the XDG roots, installs
 * every engine's hooks again, and the installers know Harness's own by their shape, never by a path: each is replaced
 * with the new paths, Codex's review records with it, and a person's own hook stays.
 *
 * Each phase is a process of its own as far as paths go: the modules loaded again (config/env.ts resolves the roots
 * once), on Linux, in a throwaway home where the old tree, then the new one, holds a packaged cli.js with notify.mjs
 * beside it and a managed Node that `runtime/current-node` names.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { legacyHarnessHome, legacyHarnessPath, xdgRoots } from '../config/harnessHome.js'
import { hooks as claudeContract } from './claude/hookContract.js'
import { hooks as codexContract } from './codex/hookContract.js'
import type { HookBlock, Settings } from './kit/notifyHooks.js'

const PORT = 19473
const PLUGINS = ['opencode', 'kilo', 'pi', 'amp'] as const
/** Every variable that would name a folder in place of the root rule (config/env.ts): the defaults instead. */
const OVERRIDES = ['ADAPTER_DATA_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_DIR', 'HARNESS_AUTH_DIR', 'HARNESS_CONNECTIONS_DIR',
  'HARNESS_HOOK_ROUTES_DIR', 'HARNESS_LOGS_DIR', 'HARNESS_PTY_DIR', 'HARNESS_DEVICES_DIR', 'HARNESS_AGENT_MESSAGES_DIR',
  'HARNESS_FLASHER_CACHE', 'DSH_DIR', 'ADAPTER_COMPUTER_ID_FILE', 'HARNESS_BIN_DIR', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'KILO_PLUGIN_DIR', 'OPENCODE_PLUGIN_DIR', 'AMP_PLUGIN_DIR', 'PI_CODING_AGENT_DIR', 'PI_HOME', 'HOOK_INSTALL_ENGINES', 'DISABLE_HOOK_INSTALL']

/** What one phase's modules say: the paths its installers write, and the installers themselves. */
interface Phase {
  env: typeof import('../config/env.js')['env']
  node: string
  script: string
  command: typeof import('./kit/notifyHooks.js')['command']
  isOurs: typeof import('./kit/notifyHooks.js')['isOurs']
  messagesCommand: typeof import('./kit/messagesHook.js')['messagesCommand']
  isMessagesBlock: typeof import('./kit/messagesHook.js')['isMessagesBlock']
  reviewRecords: typeof import('./kit/hookReview.js')['reviewRecords']
  claude: typeof import('./hooks.js')['engineHooks']['claude']
  plugins: Record<(typeof PLUGINS)[number], string>
  credential: string
  socket: string | null
}

let root = '', home = '', oldRoot = ''
let after: Phase
/** The record of the person's trust in their own Codex hook: its key, by its place, and its hash. */
let ownTrust: [string, string]
const saved: Record<string, string | undefined> = {}
const savedArgv = process.argv[1]
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

const write = (file: string, text: string, mode?: number): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mode !== undefined) chmodSync(file, mode)
}
const read = (file: string): string => readFileSync(file, 'utf8')
const json = (file: string): Settings => JSON.parse(read(file)) as Settings
const claudeFile = (): string => join(home, '.claude', 'settings.json')
const codexHome = (): string => join(home, '.codex')

/** A packaged install in [dataRoot] and [stateRoot]: cli.js with notify.mjs beside it, and the managed Node current-node names. */
function layOut(dataRoot: string, stateRoot: string): void {
  write(join(dataRoot, 'cli', 'cli.js'), '')
  write(join(dataRoot, 'cli', 'notify.mjs'), '')
  mkdirSync(join(dataRoot, 'cli', 'data'), { recursive: true })
  const node = join(stateRoot, 'runtime', 'node-v24.11.0-linux-x64', 'bin', 'node')
  write(node, '#!/bin/sh\n', 0o755)
  write(join(stateRoot, 'runtime', 'current-node'), `${node}\n`)
}

/** The modules loaded again, as a process started from [dataRoot]'s cli.js loads them, and every engine's hooks installed. */
async function start(dataRoot: string): Promise<Phase> {
  process.argv[1] = join(dataRoot, 'cli', 'cli.js')
  vi.resetModules()
  try {
    const { env } = await import('../config/env.js')
    const notify = await import('./kit/notifyHooks.js')
    const messages = await import('./kit/messagesHook.js')
    const { reviewRecords } = await import('./kit/hookReview.js')
    const { engineHooks } = await import('./hooks.js')
    const { installEngineHooks } = await import('../core/engines/hooks.js')
    const { managedNodePath } = await import('../lib/nodeRuntime.js')
    const { hookTokenPath } = await import('../lib/hookAuth.js')
    const { unixSocketPath } = await import('../lib/localSocket.js')
    const { OPENCODE_LEGACY_PLUGIN } = await import('./opencode/contract.js')
    const { KILO_PLUGIN } = await import('./kilo/contract.js')
    const { PI_EXTENSION } = await import('./pi/contract.js')
    const { AMP_PLUGIN } = await import('./amp/contract.js')
    const installed = installEngineHooks(PORT, { only: new Set(['claude', 'codex', ...PLUGINS]), environment: {} })
    try { await installed.settled } finally { installed.close() }
    return {
      env, node: managedNodePath(), script: notify.HOOK_SCRIPT, command: notify.command, isOurs: notify.isOurs,
      messagesCommand: messages.messagesCommand, isMessagesBlock: messages.isMessagesBlock, reviewRecords, claude: engineHooks.claude,
      plugins: {
        opencode: join(dirname(dirname(OPENCODE_LEGACY_PLUGIN.file)), 'plugins', 'launcher-register', 'tui.js'),
        kilo: KILO_PLUGIN.file, pi: PI_EXTENSION.file, amp: AMP_PLUGIN.file,
      },
      credential: hookTokenPath(env.ADAPTER_DATA_DIR), socket: unixSocketPath(env.ADAPTER_DATA_DIR, env.PORT),
    }
  } finally { process.argv[1] = savedArgv }
}

/** A person's own hook, beside Harness's on the same event. */
const OWN = { hooks: [{ type: 'command', command: 'my-own-hook --port 18473', timeout: 7 }] }
function addOwn(file: string): void {
  const settings = json(file)
  settings.hooks!.Stop = [...settings.hooks!.Stop, OWN]
  write(file, JSON.stringify(settings, null, 2) + '\n')
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-after-move-')))
  home = join(root, 'home')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  const env: Record<string, string | undefined> = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_PATH: join(root, 'bin', 'opencode'),
    ...Object.fromEntries(OVERRIDES.map((name) => [name, undefined])),
  }
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  // The OpenCode the installer asks for its version: a 2, which reads its plugin from plugins/launcher-register/tui.js.
  write(join(root, 'bin', 'opencode'), '#!/bin/sh\necho "opencode v2.0.18"\n', 0o755)

  // Before the move: everything in ~/.harness, installed from there.
  oldRoot = legacyHarnessHome(home, 'linux')
  layOut(oldRoot, oldRoot)
  const before = await start(oldRoot)
  expect(before.env.ADAPTER_DATA_DIR).toBe(join(oldRoot, 'cli', 'data'))
  for (const file of [claudeFile(), join(codexHome(), 'hooks.json'), join(codexHome(), 'rules', 'harness.rules'),
    ...Object.values(before.plugins)]) expect(read(file)).toContain(oldRoot)
  addOwn(claudeFile())
  addOwn(join(codexHome(), 'hooks.json'))
  // The person trusts it in Codex, which records it by its place (kit/hookReview.ts).
  const { reviewHash } = await import('./kit/hookReview.js')
  const reviewed = codexContract.settings.reviewed!
  const place = json(join(codexHome(), 'hooks.json')).hooks!.Stop.length - 1
  ownTrust = [`${join(realpathSync(codexHome()), 'hooks.json')}:${reviewed.events.Stop}:${place}:0`, reviewHash(reviewed, 'Stop', undefined, OWN.hooks[0]!)]
  const config = join(codexHome(), reviewed.file)
  write(config, `${read(config)}\n[hooks.state.${JSON.stringify(ownTrust[0])}]\ntrusted_hash = ${JSON.stringify(ownTrust[1])}\n`)

  // The move: the XDG roots hold the tree, and the data root its marker, so the rule picks them. The next start installs from there.
  const xdg = xdgRoots(home, {})
  layOut(xdg.data, xdg.state)
  write(join(xdg.data, '.harness-root'), '1\n')
  after = await start(xdg.data)
  expect(after.env.ADAPTER_DATA_DIR).toBe(join(xdg.data, 'cli', 'data'))
}, 60_000)

afterAll(() => {
  Object.defineProperty(process, 'platform', platform)
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) rmSync(root, { recursive: true, force: true })
})

const ours = (settings: Settings, event: string): HookBlock[] => (settings.hooks?.[event] ?? []).filter((block) => after.isOurs(block, 'linux'))

describe('the hook installers after the move', () => {
  it("Claude Code's settings name the new node, notify.mjs and data folder, one managed block an event", () => {
    const settings = json(claudeFile())
    const command = after.command(PORT, 'claude')
    for (const { event } of claudeContract.settings.events) {
      expect(ours(settings, event).map((block) => block.hooks.map((hook) => hook.command))).toEqual([[command]])
    }
    expect(command.startsWith(`'${after.node}' '${after.script}' --port ${PORT} --data-dir '${after.env.ADAPTER_DATA_DIR}' `)).toBe(true)
    expect(after.script).toBe(join(xdgRoots(home, {}).data, 'cli', 'notify.mjs'))
    expect(after.node.startsWith(join(xdgRoots(home, {}).state, 'runtime'))).toBe(true)
    expect(read(claudeFile())).not.toContain(oldRoot)
  })

  it("Codex's hooks.json is rewritten and its trusted_hash is the new command's, so nothing needs review", () => {
    const file = join(codexHome(), 'hooks.json')
    const settings = json(file)
    const command = after.command(PORT, 'codex', codexHome())
    for (const { event } of codexContract.settings.events) {
      expect(ours(settings, event).map((block) => block.hooks.map((hook) => hook.command))).toEqual([[command]])
    }
    expect(read(file)).not.toContain(oldRoot)
    // Every Harness hook in the file, Agent Messages' too, has its record holding the hash of the hook as it is now. Ours
    // kept their places, so the person's Stop hook keeps its own, and its record with it: no record names a hook that is gone.
    const config = parseToml(read(join(codexHome(), 'config.toml'))) as { hooks: { state: Record<string, { trusted_hash: string }> } }
    const recorded = Object.fromEntries(Object.entries(config.hooks.state).map(([key, { trusted_hash }]) => [key, trusted_hash]))
    const needed = after.reviewRecords(codexContract.settings.reviewed!, join(realpathSync(codexHome()), 'hooks.json'), settings, 'linux')
    expect(needed.size).toBe(codexContract.settings.events.length + 1)
    expect(recorded).toEqual({ ...Object.fromEntries(needed), [ownTrust[0]]: ownTrust[1] })
  })

  it("Codex's harness.rules names the new cli.js", () => {
    const rules = read(join(codexHome(), 'rules', 'harness.rules'))
    expect(rules).toContain(`prefix_rule(pattern=[${JSON.stringify(after.node)}, ${JSON.stringify(join(after.env.ADAPTER_CLI_DIR, 'cli.js'))}, `)
    expect(after.env.ADAPTER_CLI_DIR).toBe(join(xdgRoots(home, {}).data, 'cli'))
    expect(rules).not.toContain(oldRoot)
  })

  it('the Agent Messages hook names the new folder', () => {
    const folder = after.env.HARNESS_AGENT_MESSAGES_DIR
    expect(folder).toBe(join(xdgRoots(home, {}).data, 'agent-messages'))
    for (const file of [claudeFile(), join(codexHome(), 'hooks.json')]) {
      const blocks = (json(file).hooks?.PostToolUse ?? []).filter(after.isMessagesBlock)
      expect(blocks.map((block) => block.hooks.map((hook) => hook.command))).toEqual([[after.messagesCommand(folder)]])
    }
    expect(read(join(folder, 'hook.mjs'))).toContain("Agent Messages' hook")
  })

  it('the OpenCode, Kilo, Pi and Amp plugins name the new credential and socket', () => {
    expect(after.credential.startsWith(after.env.ADAPTER_DATA_DIR)).toBe(true)
    for (const engine of PLUGINS) {
      const source = read(after.plugins[engine])
      expect(source).toContain(JSON.stringify(after.credential))
      expect(source).toContain(JSON.stringify(after.socket))
      expect(source).not.toContain(oldRoot)
    }
  })

  it("a command of the first positional form is still known as Harness's", async () => {
    const own = join(root, 'positional', '.claude')
    const positional = `node '${join(legacyHarnessPath('cli', home, 'linux'), 'notify.mjs')}' 18473 claude`
    write(join(own, 'settings.json'), JSON.stringify({
      hooks: Object.fromEntries(claudeContract.settings.events.map(({ event, matcher }) =>
        [event, [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: positional, timeout: 5 }] }]])),
    }, null, 2) + '\n')
    expect(await after.claude.installIn(PORT, own)).toBe(true)
    const settings = json(join(own, 'settings.json'))
    for (const { event } of claudeContract.settings.events) {
      expect(settings.hooks![event].map((block) => block.hooks.map((hook) => hook.command))).toEqual([[after.command(PORT, 'claude')]])
    }
    expect(read(join(own, 'settings.json'))).not.toContain(positional)
  })

  it("a person's own hook beside ours is kept, at its place", () => {
    for (const file of [claudeFile(), join(codexHome(), 'hooks.json')]) {
      const stop = json(file).hooks!.Stop
      expect(stop.filter((block) => !after.isOurs(block, 'linux'))).toEqual([OWN])
      expect(stop).toHaveLength(2)
      expect(stop[1]).toEqual(OWN)
    }
  })
})
