import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { engineLastWords, lastWordsOf, SAID_MAX } from './lastWords.js'

const HOME = '/Users/pat'
/** The line a pane's wrapper prints as its engine leaves (lib/engineLaunch.ts `engineFallbackPrelude`). */
const left = (status = 2, command = 'codex') => `harness: ${command} exited (${status}). This pane is a shell now — run ${command} again, or stop the pane.`
const pane = (...lines: string[]) => lines.join('\n')
const PROMPT = 'pat@studio app % '

describe('what an engine said as it left its pane', () => {
  // Codex 0.164's answer to a flag it does not know (clap): the error comes first, then its help.
  it('is the error it printed, not the help after it', () => {
    expect(lastWordsOf(pane("error: unexpected argument '--add-dir' found", '', "  tip: to pass '--add-dir' as a value, use '-- --add-dir'", '',
      'Usage: codex [OPTIONS] [PROMPT]', '       codex [OPTIONS] <COMMAND> [ARGS]', '', "For more information, try '--help'.", '', left(2), PROMPT), HOME))
      .toEqual({ status: 2, said: "error: unexpected argument '--add-dir' found" })
  })

  it('is its last two lines when none reads as an error', () => {
    expect(lastWordsOf(pane('Token usage: total=0 input=0 output=0', 'To continue this session, run codex resume 019a-5', '', left(0), PROMPT), HOME))
      .toEqual({ status: 0, said: 'Token usage: total=0 input=0 output=0 · To continue this session, run codex resume 019a-5' })
  })

  it('is only its status when it printed nothing', () => {
    expect(lastWordsOf(pane('', '', left(1), PROMPT), HOME)).toEqual({ status: 1, said: null })
  })

  // Without its wrapper's line the pane's words cannot be told from the shell's or the person's.
  it('is nothing on a pane its engine did not leave', () => {
    expect(lastWordsOf(pane('error: something', PROMPT), HOME)).toBeNull()
    expect(lastWordsOf('', HOME)).toBeNull()
  })

  it('reads the line a Windows pane prints', () => {
    expect(lastWordsOf(pane('Error: Cannot find module \'x\'', '', 'harness: codex exited (1). This pane is a shell now - run codex again, or stop the pane.', 'PS C:\\> '), HOME))
      .toEqual({ status: 1, said: 'Error: Cannot find module \'x\'' })
  })

  // A person may run the engine again in that shell: what the start's own engine said is above the first such line.
  it('is what the engine said the first time it left', () => {
    expect(lastWordsOf(pane('error: first', left(2), PROMPT + 'codex', 'error: second', left(3), PROMPT), HOME))
      .toEqual({ status: 2, said: 'error: first' })
  })

  it('never carries a home folder, an email address or a secret', () => {
    const { said } = lastWordsOf(pane(`Error loading ${HOME}/.codex/config.toml for pat@example.com: token=abcdef123456 in /home/sam/x and C:\\Users\\Sam\\y`
      + ` with ${'k'.repeat(40)}`, left(1)), HOME)!
    expect(said).toBe('Error loading ~/.codex/config.toml for <email>: token=<redacted> in ~/x and ~\\y with <redacted>')
    // A home of `/` is every path, and is not told as `~`.
    expect(lastWordsOf(pane('error: no /etc/codex', left(1)), '/')).toEqual({ status: 1, said: 'error: no /etc/codex' })
  })

  it('is one line of at most 300 characters, with no control characters', () => {
    const { said } = lastWordsOf(pane(`error:\t${'😀'.repeat(400)}\u0007`, left(1)), HOME)!
    expect(Array.from(said!)).toHaveLength(SAID_MAX)
    expect(said).toMatch(/^error: 😀+…$/u)
  })
})

describe('reading it', () => {
  const screen = (text: string) => vi.fn(async () => ({ ok: true as const, text, hold: null }))
  const said = pane('error: bad flag', left(2), PROMPT)

  // Vesper on the rehearsal (2026-11-11): Codex ran 10 seconds and left, and its conversation was kept apart from the shell that
  // kept its pane (lib/retainExitedSession.ts), which names it.
  it('reads the shell that kept the pane of an agent that stopped', async () => {
    const core = fakeCore({ superTabs: { screen: screen(said) } as never, agents: { all: vi.fn(() => [{ agentId: 'other', engine: 'terminal' },
      { agentId: 'shell', engine: 'terminal', previousAgentId: 'native' }] as never) } })
    expect(await engineLastWords(core, 'native', HOME)).toEqual({ status: 2, said: 'error: bad flag' })
    expect(core.superTabs!.screen).toHaveBeenCalledWith('shell', 60)
  })

  // An engine that left before it was ever seen leaves its own row a shell (core/agents/newPane.ts).
  it('reads the pane of an agent whose row is a shell now', async () => {
    const core = fakeCore({ superTabs: { screen: screen(said) } as never, agents: { byAgent: vi.fn(() => ({ agentId: 'native', engine: 'terminal' }) as never) } })
    expect(await engineLastWords(core, 'native', HOME)).toEqual({ status: 2, said: 'error: bad flag' })
    expect(core.superTabs!.screen).toHaveBeenCalledWith('native', 60)
  })

  it('reads nothing of an agent still running, a pane that went with it, a screen it could not read, or with the Swarm off', async () => {
    const running = fakeCore({ superTabs: { screen: screen(said) } as never, agents: { byAgent: vi.fn(() => ({ agentId: 'native', engine: 'codex' }) as never),
      all: vi.fn(() => [{ agentId: 'shell', engine: 'codex', previousAgentId: 'native' }] as never) } })
    expect(await engineLastWords(running, 'native', HOME)).toBeNull()
    expect(running.superTabs!.screen).not.toHaveBeenCalled()
    const shell = { agents: { all: vi.fn(() => [{ agentId: 'shell', engine: 'terminal', previousAgentId: 'native' }] as never) } }
    // A pane it could not read is said in the log; its start says only that its agent stopped.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await engineLastWords(fakeCore({ ...shell, superTabs: { screen: vi.fn(async () => ({ ok: false as const, error: 'gone' })) } as never }), 'native', HOME)).toBeNull()
    expect(await engineLastWords(fakeCore({ ...shell, superTabs: { screen: vi.fn(async () => { throw new Error('lost') }) } as never }), 'native', HOME)).toBeNull()
    expect(warn.mock.calls.map(([line]) => line)).toEqual(['[super-tabs] could not read what native\'s engine said as it left · gone',
      '[super-tabs] could not read what native\'s engine said as it left · lost'])
    warn.mockRestore()
    expect(await engineLastWords(fakeCore(shell), 'native', HOME)).toBeNull()
  })
})
