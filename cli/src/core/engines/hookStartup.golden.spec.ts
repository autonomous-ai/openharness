/** Former startup coordination, recorded from main before readiness stops waiting
 * for hook preparation. Native file contents have their own installer goldens.
 * This record pins the core's vendor/port/home dispatch and independent refusals.
 * All files and installers are fixtures; no host binary or engine home is used. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { installEngineHooks } from './hooks.js'

const world = vi.hoisted(() => {
  const state = { calls: [] as unknown[][], homes: { claude: [] as string[], codex: [] as string[] }, failed: '' }
  const install = (engine: string, port: number, home?: string) => {
    state.calls.push([engine, port, home ?? '<default-home>'])
    return Promise.resolve(engine !== state.failed)
  }
  return { state, install }
})
vi.mock('../../engines/hooks.js', () => ({ engineHooks: {
  claude: { install: (port: number) => world.install('claude', port), installIn: (port: number, home: string) => world.install('claude', port, home) },
  codex: { install: (port: number) => world.install('codex', port), installIn: (port: number, home: string) => world.install('codex', port, home) },
} }))
vi.mock('../../engines/nativeHooks.js', () => ({
  installCursorHooks: (port: number) => world.install('cursor', port),
  installOpencodePlugin: (port: number) => world.install('opencode', port),
  installKiloPlugin: (port: number) => world.install('kilo', port),
  installPiExtension: (port: number) => world.install('pi', port),
  installAmpPlugin: (port: number) => world.install('amp', port),
  installHermesHooks: (port: number) => world.install('hermes', port),
  installDevinHooks: (port: number) => world.install('devin', port),
  installCommandCodeHooks: (port: number) => world.install('commandcode', port),
  installGrokHooks: (port: number) => world.install('grok', port),
  installAgyHooks: (port: number) => world.install('agy', port),
  installCopilotHooks: (port: number) => world.install('copilot', port),
}))
vi.mock('../../lib/engineHomes.js', () => ({
  recoverEngineHomes: () => world.state.homes,
  confirmHomes: (environment: NodeJS.ProcessEnv) => ({ claude: environment.CLAUDE_CONFIG_DIR ?? null, codex: environment.CODEX_HOME ?? null }),
}))

const artifact = fileURLToPath(new URL('./__fixtures__/hook-startup.golden.json', import.meta.url))
afterEach(() => vi.restoreAllMocks())

it('preserves the original vendor, adopted-home and refusal coordination', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const record: Record<string, unknown> = {}
  try {
    for (const platform of ['linux', 'darwin']) {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
      const cases: Record<string, unknown> = {}
      for (const name of ['all vendors', 'selected vendors', 'adopted homes', 'one unavailable vendor']) {
        world.state.calls = []
        world.state.homes = name === 'adopted homes' ? { claude: ['/fixture/saved-claude'], codex: ['/fixture/saved-codex'] } : { claude: [], codex: [] }
        world.state.failed = name === 'one unavailable vendor' ? 'cursor' : ''
        const warnings: string[] = [], messages: string[] = []
        vi.spyOn(console, 'warn').mockImplementation(value => { warnings.push(String(value)) })
        vi.spyOn(console, 'log').mockImplementation(value => { messages.push(String(value)) })
        const installed = await installEngineHooks(4242, {
          environment: name === 'adopted homes' ? { CLAUDE_CONFIG_DIR: '/fixture/own-claude' } : {},
          loginShell: Promise.resolve(name === 'adopted homes' ? { CODEX_HOME: '/fixture/shell-codex' } : {}),
          ...(name === 'selected vendors' ? { only: new Set(['codex', 'opencode', 'hermes']) } : {}),
        })
        // A synchronous controller may expose completion separately once startup
        // no longer waits on it. The recorded observations stay unchanged.
        await (installed as { settled?: Promise<void> }).settled
        await Promise.resolve()
        installed.close()
        cases[name] = { calls: world.state.calls, warnings: warnings.sort(), messages: messages.sort() }
        vi.restoreAllMocks()
      }
      record[platform] = cases
    }
  } finally { Object.defineProperty(process, 'platform', originalPlatform) }
  if (process.env.RECORD_HOOK_STARTUP_GOLDEN === '1') writeFileSync(artifact, JSON.stringify(record, null, 2) + '\n')
  expect(record).toEqual(JSON.parse(readFileSync(artifact, 'utf8')))
})
