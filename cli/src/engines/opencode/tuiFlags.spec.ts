/**
 * Every flag this daemon hands the `opencode` TUI, checked against the INSTALLED binary's own help.
 *
 * OpenCode updated itself from 1.18 to 2.0 underneath a running daemon, and v2's TUI exits 1 on a
 * flag it does not list (`Unrecognized flag: -m in command opencode`) — the pane became a shell, and
 * every spec still passed because they all pinned v1. This one reads the real `--help`, so the next
 * flag a release drops fails here instead of in someone's pane. Skipped where opencode is not
 * installed.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildEngineCommandArgv, namedAgentArgs, supportsNamedAgent } from '../../lib/engineLaunch.js'
import { buildLaunchOverrides, type LaunchOverridesDeps, type LaunchSource } from '../../lib/launchOverrides.js'
import { binaryOnPath } from '../../lib/binaryOnPath.js'
import { opencodeMajorVersion } from './version.js'

const installed = binaryOnPath('opencode')

describe.skipIf(!installed)('the installed opencode TUI accepts every flag we pass it', () => {
  const helpResult = installed ? spawnSync('opencode', ['--help'], { encoding: 'utf8', timeout: 15_000 }) : null
  if (helpResult?.error) throw helpResult.error
  if (helpResult && helpResult.status !== 0) throw new Error(`opencode --help exited ${helpResult.status}: ${helpResult.stderr}`)
  // v1 writes help to stderr; v2 uses stdout. Verify the actual flags from either stream.
  const help = helpResult ? `${helpResult.stdout}\n${helpResult.stderr}` : ''
  const major = installed ? opencodeMajorVersion() : null
  const deps: LaunchOverridesDeps = {
    machine: () => ({ hermesSystemManaged: false, opencodeMajor: major }),
    writeGridConfigDir: async (key) => `/state/grid-engine-config/${key}`,
    tmuxSupportsSessionEnv: async () => true,
    installCodexHooks: () => {},
    readCodexConfig: () => null,
  }
  const GRID = {
    networkId: 'grid-x', networkName: 'autonomous.ai', baseUrl: 'https://grid.example/grid-x/relay/v1', apiKey: 'k', model: 'Qwen',
  }
  /** `--flag` or `-f` listed as a token of the help text (`--session, -s string`, `-m, --model`). */
  const listed = (flag: string) => new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}([\\s,=]|$)`, 'm').test(help)

  it.each<[string, LaunchSource]>([
    ['own login', {}],
    ['own login, back on a remembered model', { subscriptionModel: 'opencode/big-pickle' }],
    ['a grid', { gridLaunch: GRID }],
    ['a named agent', { agent: 'harness-compute' }],
  ])('%s', async (_, source) => {
    const built = await buildLaunchOverrides(deps, 'opencode', source, 'a')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const argv = buildEngineCommandArgv('opencode', {
      bypassPermission: true,
      resumeSessionId: 'ses_1',
      firstPrompt: 'hello',
      extraArgs: built.overrides.extraArgs,
    })
    const flags = argv.slice(1).filter((token) => token.startsWith('-'))
    expect(flags.length).toBeGreaterThan(0)
    for (const flag of flags) expect(listed(flag), `${flag} is not in \`opencode --help\` (v${major})`).toBe(true)
  })

  it('agrees with the named-agent contract', () => {
    // Where the contract says yes, the flag it hands over must exist; where it says no, nothing is passed.
    if (!supportsNamedAgent('opencode', major)) return
    for (const flag of namedAgentArgs('opencode', 'x', major).filter((token) => token.startsWith('-'))) {
      expect(listed(flag), `${flag} is not in \`opencode --help\``).toBe(true)
    }
  })
})
