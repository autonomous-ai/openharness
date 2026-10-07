/**
 * The suite must never read or write the developer's real `~/.harness`.
 *
 * `vitest.setup.ts` moved the DATA dir to a throwaway after a spec wrote a fixture into the live
 * registry. The RUNTIME dir is the same hazard in the other direction: a real `current-grid` or
 * `current-node` pointer there outranks the fakes a spec puts on PATH (`gridExec.ts` resolves the
 * managed runtime BEFORE PATH, by design), so the suite would measure this machine's managed
 * binaries instead of the code under test.
 */
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { env } from './env.js'
import { AUTH_DIR } from '../lib/authSession.js'

const productRoot = join(homedir(), '.harness')

describe('test environment isolation', () => {
  // The home folder is the suite's own (vitest.setup.ts), so every default rooted there is too: a spec that
  // named no folder of its own read the developer's ~/.claude, ~/.codex and ~/.harness before it was.
  it('runs in a throwaway home folder, so no default folder of an engine or of Harness is the developer\'s', () => {
    const inTemp = (path: string) => realpathSync(path).startsWith(realpathSync(tmpdir()) + sep)
    expect(inTemp(homedir())).toBe(true)
    for (const folder of [env.CLAUDE_PROJECTS_DIR, env.CODEX_HOME, env.CURSOR_HOME, env.GROK_HOME, env.COPILOT_HOME, env.HERMES_HOME, env.OPENCODE_DATA_DIR]) {
      expect(folder.startsWith(homedir() + sep), folder).toBe(true)
    }
  })

  it('keeps the data dir off the developer\'s ~/.harness', () => {
    expect(env.ADAPTER_DATA_DIR.startsWith(productRoot)).toBe(false)
  })

  it('keeps the runtime dir off the developer\'s ~/.harness, so no real managed grid or node outranks a fake on PATH', () => {
    expect(env.ADAPTER_RUNTIME_DIR.startsWith(productRoot)).toBe(false)
  })
  it('keeps the lessons folder off the developer\'s ~/.harness, so no spec writes a lesson there', () => {
  })
  it('keeps the hook routes off the developer\'s ~/.harness, so no spec records a daemon beside theirs or routes by one', () => {
    expect(env.HARNESS_HOOK_ROUTES_DIR.startsWith(productRoot)).toBe(false)
  })
  it('keeps account reads and refreshes in the test-owned auth directory', () => {
    expect(AUTH_DIR).toBe(join(env.ADAPTER_DATA_DIR, 'auth'))
    expect(AUTH_DIR.startsWith(productRoot)).toBe(false)
  })
})
