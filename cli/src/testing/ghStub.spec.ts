import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GH_FORBIDDEN_MESSAGE, GH_FORBIDDEN_STUB } from './ghStub.js'

describe('the gh an end-to-end daemon finds', () => {
  it('refuses with a clear message and a non-zero exit, and the e2e harness writes it into the daemon\'s bin folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'))
    try {
      const file = join(dir, 'gh')
      writeFileSync(file, GH_FORBIDDEN_STUB, { mode: 0o755 })
      const run = spawnSync(file, ['search', 'issues'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
      expect(run.status).not.toBe(0)
      expect(run.stderr.trim()).toBe(GH_FORBIDDEN_MESSAGE)
      const harness = readFileSync(join(__dirname, '../../e2e/harness/daemon.ts'), 'utf8')
      expect(harness).toContain("writeFile(join(dirs.bin, 'gh'), GH_FORBIDDEN_STUB")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
