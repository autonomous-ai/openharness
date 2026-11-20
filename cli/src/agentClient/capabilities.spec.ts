import { describe, expect, it, vi } from 'vitest'
import { CAPABILITIES_USAGE, capabilitiesCommand } from './capabilities.js'
import { EXIT, type ClientDeps } from './commands.js'

function harness() {
  const out: string[] = [], err: string[] = []
  // Nothing is ever opened: a daemon that is down, or none at all, is never asked.
  const open = vi.fn(async () => { throw new Error('the daemon is never asked') })
  const where = vi.fn(() => { throw new Error('no data folder is read') })
  const deps: ClientDeps = { pane: undefined, env: {}, open, where, out: (l) => out.push(l), err: (l) => err.push(l) }
  return { deps, out, err, open, where }
}

describe('harness capabilities (#4393)', () => {
  it('answers {"programSessions":1} with --json, asking nothing of the daemon, the account or a token', async () => {
    const h = harness()
    expect(await capabilitiesCommand(['--json'], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['{"programSessions":1}'])
    expect(h.open).not.toHaveBeenCalled()
    expect(h.where).not.toHaveBeenCalled()
  })

  it('says it in words without --json', async () => {
    const h = harness()
    expect(await capabilitiesCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out).toEqual(['Program sessions: 1 (harness ensure, an acknowledged harness reply and harness close --forget, with --program-token-file).'])
  })

  it('prints its usage for --help, and refuses anything else as a usage error', async () => {
    const help = harness()
    expect(await capabilitiesCommand(['--help'], help.deps)).toBe(EXIT.ok)
    expect(help.out).toEqual([CAPABILITIES_USAGE])
    for (const argv of [['lamp'], ['--machine', 'office'], ['--all']]) {
      const h = harness()
      expect(await capabilitiesCommand(argv, h.deps)).toBe(EXIT.usage)
      expect(h.err.at(-1)).toBe(CAPABILITIES_USAGE)
    }
  })

  it('runs with no deps at all', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await capabilitiesCommand(['--json'])).toBe(EXIT.ok)
      expect(log).toHaveBeenCalledWith('{"programSessions":1}')
    } finally { log.mockRestore() }
  })
})
