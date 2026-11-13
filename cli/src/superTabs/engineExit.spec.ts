import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { engineFallbackPrelude } from '../lib/engineLaunch.js'
import { ENGINE_EXIT_NOTICE_PS } from '../lib/windows/engineStart.js'
import { fakeCore } from '../testing/fakeCore.js'
import { engineExit, exitOn, LEAVING_MS } from './engineExit.js'

/** The line the wrapper prints as its engine leaves, as `sh` prints it from the wrapper itself (lib/engineLaunch.ts). */
function left(status = 2, engine: 'codex' | 'claude' = 'codex'): string {
  const printf = engineFallbackPrelude(engine, '/bin/zsh', null).split('\n').find(line => line.includes('This pane is a shell now'))!
  return execFileSync('/bin/sh', ['-c', `harness_status=${status}\n${printf}`], { encoding: 'utf8' }).trim()
}
/** PowerShell's line (lib/windows/engineStart.ts), its concatenation done as PowerShell does it. */
function leftInPowerShell(status: number): string {
  const values: Record<string, string> = { '$env:HARNESS_ENGINE_COMMAND': 'codex', '$env:HARNESS_ENGINE_EXIT': String(status) }
  const expression = /Write-Host \(('harness: .*?')\);/.exec(ENGINE_EXIT_NOTICE_PS)![1]!
  return expression.split(' + ').map(part => values[part] ?? part.replace(/^'|'$/g, '')).join('')
}
const pane = (...lines: string[]) => lines.join('\n')
const PROMPT = 'pat@studio app % '

describe('how an engine left its pane', () => {
  it('reads the wrapper\'s own line', () => {
    expect(left(2)).toBe('harness: codex exited (2). This pane is a shell now — run codex again, or stop the pane.')
    expect(exitOn(pane('', left(0), PROMPT))).toEqual({ status: 0, option: false })
    expect(exitOn(pane('', leftInPowerShell(1), 'PS C:\\> '))).toEqual({ status: 1, option: false })
  })

  // Codex 0.164 (clap) and Claude Code (Commander), refusing an option they do not have, as `codex --x` and `claude --x` print it.
  it('says when the engine refused an option it was started with', () => {
    expect(exitOn(pane("error: unexpected argument '--add-dir' found", '', "  tip: to pass '--add-dir' as a value, use '-- --add-dir'", '',
      'Usage: codex [OPTIONS] [PROMPT]', '', "For more information, try '--help'.", '', left(2), PROMPT))).toEqual({ status: 2, option: true })
    expect(exitOn(pane("error: unknown option '--fork-session'", '', left(1, 'claude'), PROMPT))).toEqual({ status: 1, option: true })
  })

  // The review of #4134: the pane's shell reads its person's own startup files before the engine runs, and what they print is not
  // the engine's; nor is what the person runs after it, below the wrapper's first line.
  it('is not told an option was refused by anything else on the pane', () => {
    expect(exitOn(pane('/Users/pat/.zshrc:12: command not found: pyenv', 'error: something else', 'Token usage: total=0', left(1), PROMPT)))
      .toEqual({ status: 1, option: false })
    expect(exitOn(pane('Token usage: total=0', left(0), `${PROMPT}codex --x`, "error: unexpected argument '--x' found", left(2), PROMPT)))
      .toEqual({ status: 0, option: false })
  })

  it('is nothing on a pane its wrapper has said nothing on', () => {
    expect(exitOn(pane("error: unexpected argument '--x' found", PROMPT))).toBeNull()
    expect(exitOn('')).toBeNull()
  })
})

describe('reading it on this machine', () => {
  const NOW = Date.UTC(2026, 10, 12)
  const screen = (text: string) => vi.fn(async () => ({ ok: true as const, text, hold: null }))
  const refused = pane("error: unexpected argument '--add-dir' found", left(2), PROMPT)

  // Vesper on the rehearsal (2026-11-11): Codex ran 10 seconds and left, and its conversation was kept apart from the shell that kept
  // its pane (lib/retainExitedSession.ts), which names it.
  it('reads the shell that kept the pane of an agent that stopped', async () => {
    const core = fakeCore({ panes: { screen: screen(refused) } as never, agents: { all: vi.fn(() => [{ agentId: 'other', engine: 'terminal' },
      { agentId: 'shell', engine: 'terminal', previousAgentId: 'native', touchedAt: NOW }] as never) } })
    expect(await engineExit(core, 'native', NOW)).toEqual({ status: 2, option: true })
    expect(core.panes!.screen).toHaveBeenCalledWith('shell', 60)
  })

  // An engine that left before it was ever seen leaves its own row a shell (core/agents/newPane.ts).
  it('reads the pane of an agent whose row is a shell now', async () => {
    const core = fakeCore({ panes: { screen: screen(refused) } as never,
      agents: { byAgent: vi.fn(() => ({ agentId: 'native', engine: 'terminal', touchedAt: NOW }) as never) } })
    expect(await engineExit(core, 'native', NOW)).toEqual({ status: 2, option: true })
    expect(core.panes!.screen).toHaveBeenCalledWith('native', 60)
  })

  // The review of #4134: the core makes the row a shell as soon as the engine has left, and the wrapper prints its line after it has
  // read the pane's input dry.
  it('says the engine is leaving while its shell is new and its wrapper has said nothing yet, and nothing once it is not new', async () => {
    const shell = (touchedAt: number) => fakeCore({ panes: { screen: screen(pane("error: unexpected argument '--x' found")) } as never,
      agents: { byAgent: vi.fn(() => ({ agentId: 'native', engine: 'terminal', touchedAt }) as never) } })
    expect(await engineExit(shell(NOW - LEAVING_MS + 1), 'native', NOW)).toBe('leaving')
    expect(await engineExit(shell(NOW - LEAVING_MS), 'native', NOW)).toBeNull()
  })

  it('reads nothing of an agent still running, a pane that went with it, a pane it could not read, or with the Swarm off', async () => {
    const running = fakeCore({ panes: { screen: screen(refused) } as never, agents: { byAgent: vi.fn(() => ({ agentId: 'native', engine: 'codex' }) as never),
      all: vi.fn(() => [{ agentId: 'shell', engine: 'codex', previousAgentId: 'native' }] as never) } })
    expect(await engineExit(running, 'native', NOW)).toBeNull()
    expect(running.panes!.screen).not.toHaveBeenCalled()
    const shell = { agents: { all: vi.fn(() => [{ agentId: 'shell', engine: 'terminal', previousAgentId: 'native', touchedAt: NOW }] as never) } }
    // A pane it could not read is said in the log; its start says only that its agent stopped.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await engineExit(fakeCore({ ...shell, panes: { screen: vi.fn(async () => ({ ok: false as const, error: 'gone' })) } as never }), 'native', NOW)).toBeNull()
    expect(await engineExit(fakeCore({ ...shell, panes: { screen: vi.fn(async () => { throw new Error('lost') }) } as never }), 'native', NOW)).toBeNull()
    expect(warn.mock.calls.map(([line]) => line)).toEqual(['[super-tabs] could not read how native\'s engine left its pane · gone',
      '[super-tabs] could not read how native\'s engine left its pane · lost'])
    warn.mockRestore()
    expect(await engineExit(fakeCore(shell), 'native', NOW)).toBeNull()
  })
})
