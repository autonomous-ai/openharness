import { describe, expect, it } from 'vitest'
import { CLOSE_USAGE, EXIT, PS_USAGE, SHOW_USAGE, WAIT_USAGE, WHOAMI_USAGE } from './commands.js'
import { NEW_USAGE } from '../lib/newCommand.js'
import { agentsHelp, helpFor } from './help.js'

const synopsis = (usage: string) => usage.split('\n')[0].replace(/^Usage: /, '')

describe('harness help agents', () => {
  it('fits in 40 lines and names each verb as its usage does', () => {
    const text = agentsHelp()
    expect(text.split('\n').length).toBeLessThanOrEqual(40)
    for (const usage of [WHOAMI_USAGE, PS_USAGE, NEW_USAGE, WAIT_USAGE, SHOW_USAGE, CLOSE_USAGE]) expect(text).toContain(synopsis(usage))
    expect(text).toContain('harness send <name>[,<name>] "text"')
  })
  it('lists every exit code', () => {
    for (const code of Object.values(EXIT)) expect(agentsHelp()).toMatch(new RegExp(`\\b${code} `))
  })
  it('uses placeholders, never a real name', () => {
    expect(agentsHelp()).not.toMatch(/--(machine|name) (?![<\[])/)
  })
})

describe('harness --help', () => {
  const full = 'harness vX — connect this computer to your machine\n…'
  it('points an agent to its help on the first line, and leaves the rest as it was', () => {
    expect(helpFor({}, full)).toBe(`An agent? Run: harness help agents\n${full}`)
  })
  it('puts the agents\' help first when an agent asks, and does not point it to what it just read', () => {
    for (const env of [{ CODEX_THREAD_ID: 't' }, { AI_AGENT: 'cursor' }, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }]) {
      expect(helpFor(env, full)).toBe(`${agentsHelp()}\n\n${full}`)
    }
  })
  it('does not claim every command ends with Next: whoami and a refusal do not', () => {
    expect(agentsHelp()).not.toContain('Every command ends with Next')
    expect(agentsHelp()).toContain('Most commands end with Next:')
  })
})
