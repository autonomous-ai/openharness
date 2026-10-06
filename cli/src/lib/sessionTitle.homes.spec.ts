import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexThreadName, resetCodexThreadNames } from './sessionTitle.js'

const shell = vi.hoisted(() => ({ environment: {} as NodeJS.ProcessEnv }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => shell.environment }))
const roots: string[] = []
afterEach(() => {
  shell.environment = {}
  vi.unstubAllEnvs()
  resetCodexThreadNames()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('names a Codex thread from the login shell home before the daemon home, unless the agent has its own profile', () => {
  // Found by QA on a quiet machine: moved-home agents kept the title from the daemon's other login.
  const root = mkdtempSync(join(tmpdir(), 'session-title-homes-')); roots.push(root)
  const home = (name: string) => {
    const path = join(root, name)
    mkdirSync(path)
    writeFileSync(join(path, 'session_index.jsonl'), JSON.stringify({ id: 'conversation', thread_name: name }) + '\n')
    return path
  }
  vi.stubEnv('CODEX_HOME', home('daemon-login'))
  shell.environment = { CODEX_HOME: home('shell-login') }
  const profile = home('agent-profile')
  expect(codexThreadName('conversation')).toBe('shell-login')
  expect(codexThreadName('conversation', profile)).toBe('agent-profile')
})
