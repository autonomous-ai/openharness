import { describe, expect, it, vi } from 'vitest'
vi.mock('../dsh/installed.js', () => ({ listInstalledDsh: () => [
  { id: 'a/agent', source: null, manifest: { name: 'Agent', description: 'd', engine: 'claude', viewer: { command: 'x' } } },
  { id: 'a/plain', source: null, manifest: { name: 'Plain', engine: 'claude' } },
  { id: 'a/viewer', source: null, manifest: { name: 'V', kind: 'viewer' } },
  { id: 'a/hidden', source: 'builtin-hidden', manifest: { name: 'H', engine: 'claude' } },
  { id: 'a/none', source: null, manifest: { name: 'N' } },
  { id: 'a/odd', source: null, manifest: { name: 'O', engine: 'oddengine' } },
] }))
vi.mock('../dsh/builtins.js', () => ({ isHiddenBuiltin: (r: { source?: string | null }) => r.source === 'builtin-hidden' }))
vi.mock('../lib/engineLaunch.js', () => ({ supportsFirstPrompt: (e: string) => e === 'claude' }))
const { installedHarnessCatalog, orchestratorEngineSupported } = await import('./catalog.js')

describe('orchestrator catalog', () => {
  it('lists only launchable agent harnesses', () => {
    expect(installedHarnessCatalog()).toEqual([
      { id: 'a/agent', name: 'Agent', description: 'd', engine: 'claude', viewer: true },
      { id: 'a/plain', name: 'Plain', description: '', engine: 'claude', viewer: false },
    ])
  })
  it('accepts only known engines that take a first prompt', () => {
    expect(orchestratorEngineSupported('claude')).toBe(true)
    expect(orchestratorEngineSupported('oddengine')).toBe(false)
    expect(orchestratorEngineSupported('codex')).toBe(false)
  })
})
