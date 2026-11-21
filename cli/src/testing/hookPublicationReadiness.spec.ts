import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { IsolatedDaemon } = await import('../../e2e/harness/daemon.js' as string) as {
  IsolatedDaemon: { prototype: { hooksInstalled(engines: readonly ('claude' | 'codex')[]): Promise<void> } }
}
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hook-ready-')); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
const publish = (engine: 'claude' | 'codex', port = 48123) => {
  const home = join(root, engine)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, engine === 'claude' ? 'settings.json' : 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node /fixture/notify.mjs --port ${port}` }] }] },
  }))
}
function fixture(output = '') {
  // Exercise the real readiness method against private files without starting a daemon or a terminal.
  const daemon = Object.create(IsolatedDaemon.prototype)
  Object.assign(daemon, { root, output, startedAt: 0,
    env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') }, hookLog: () => '' })
  Object.defineProperty(daemon, 'port', { value: 48123 })
  return daemon as { hooksInstalled(engines: readonly ('claude' | 'codex')[]): Promise<void> }
}
it('sees setup published by the extracted worker without legacy install log lines', async () => {
  publish('claude'); publish('codex')
  const installed = fixture().hooksInstalled(['claude', 'codex'])
  const outcome = installed.then(() => 'ready', () => 'timed out')
  await vi.advanceTimersByTimeAsync(60_100)
  expect(await outcome).toBe('ready')
})
it('keeps waiting through stale success logs, a missing engine and a different port', async () => {
  const d = fixture('[hooks] Claude Code session, turn, wait and subagent hooks already installed\n'
    + '[hooks] Codex session and turn hooks already installed → /fixture/hooks.json\n')
  publish('claude')
  let ready = false
  const installed = d.hooksInstalled(['claude', 'codex']).then(() => { ready = true })
  await vi.advanceTimersByTimeAsync(100)
  expect(ready).toBe(false)
  publish('codex', 481234)
  await vi.advanceTimersByTimeAsync(100)
  expect(ready).toBe(false)
  publish('codex')
  await vi.advanceTimersByTimeAsync(100)
  await installed
  expect(ready).toBe(true)
})
