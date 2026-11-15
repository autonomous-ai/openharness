import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reportedProfileHome } from '../discoveries.js'

// The profile home a hook reports, against Codex's declared profile (`profile` in codex/discoveryContract.ts) applied
// by the kit, through the composition the registry calls. The daemon reads no process's environment: the hook names
// its own CODEX_HOME, and this is the rule it is taken by.
describe('reportedProfileHome', () => {
  const DEFAULT = '/home/u/.codex'

  it('takes a home that is not the default', () => {
    expect(reportedProfileHome('codex', '/home/u/.codex-work', DEFAULT)).toBe('/home/u/.codex-work')
  })

  it('reports the default profile as null, whichever way it is spelled', () => {
    expect(reportedProfileHome('codex', DEFAULT, DEFAULT)).toBeNull()
    const real = mkdtempSync(join(tmpdir(), 'codex-home-'))
    try {
      // A path that resolves to the default (a symlink, `..` — here realpath vs. the tmp alias on
      // macOS) is still the default.
      expect(reportedProfileHome('codex', join(real, '.', ''), real)).toBeNull()
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('is Codex-only and refuses a value that could not be a home', () => {
    expect(reportedProfileHome('claude', '/home/u/.codex-work', DEFAULT)).toBeNull()
    for (const home of ['relative/dir', '/bad\nline', `/${'x'.repeat(1024)}`, undefined]) {
      expect(reportedProfileHome('codex', home, DEFAULT), String(home).slice(0, 20)).toBeNull()
    }
  })
})
