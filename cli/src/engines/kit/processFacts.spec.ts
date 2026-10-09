import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEngine } from '../types.js'
import { profileHomeFromEnv } from '../discoveries.js'

// The former lib/codexHomeProbe.spec.ts, its cases unchanged, against Codex's declared profile (`profile` in
// codex/discoveryContract.ts) applied by the kit, through the composition discovery calls.
const codexHomeFromEnv = (engine: AgentEngine, processEnv: Record<string, string>, defaultHome?: string) => profileHomeFromEnv(engine, processEnv, defaultHome)

describe('codexHomeFromEnv', () => {
  const DEFAULT = '/home/u/.codex'

  it('reads a non-default profile off the process environment', () => {
    expect(codexHomeFromEnv('codex', { CODEX_HOME: '/home/u/.codex-work' }, DEFAULT)).toBe('/home/u/.codex-work')
  })

  it('reports the default profile as null, whichever way it is spelled', () => {
    expect(codexHomeFromEnv('codex', {}, DEFAULT)).toBeNull()
    expect(codexHomeFromEnv('codex', { CODEX_HOME: DEFAULT }, DEFAULT)).toBeNull()
    const real = mkdtempSync(join(tmpdir(), 'codex-home-'))
    try {
      // A path that resolves to the default (a symlink, `..` — here realpath vs. the tmp alias on
      // macOS) is still the default.
      expect(codexHomeFromEnv('codex', { CODEX_HOME: join(real, '.', '') }, real)).toBeNull()
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('is Codex-only and refuses a value that could not be a home', () => {
    expect(codexHomeFromEnv('claude', { CODEX_HOME: '/home/u/.codex-work' }, DEFAULT)).toBeNull()
    expect(codexHomeFromEnv('codex', { CODEX_HOME: 'relative/dir' }, DEFAULT)).toBeNull()
    expect(codexHomeFromEnv('codex', { CODEX_HOME: '/bad\nline' }, DEFAULT)).toBeNull()
  })
})
