import { describe, expect, it } from 'vitest'
import type { Roster } from '../messages/roster.js'
import { rosterGrants } from './rosterGrants.js'

const KEY = 'A'.repeat(43) + '='
/** Bob asked, from bob-mac, for his harness `api` in each tab these tests use. */
const ASKED = new Set([`${'a'.repeat(24)}\nbob-mac\napi`, `${'b'.repeat(24)}\nbob-mac\napi`])
function roster(over: Partial<Roster> = {}): Roster {
  return {
    sharedTabId: 'a'.repeat(24), version: 3, name: 'Launch',
    owner: { accountId: 'alice', email: 'alice@example.com', machineId: 'alice-mac', machinePublicKey: KEY },
    leader: null,
    members: [
      { accountId: 'bob', email: 'bob@example.com', name: 'Bob', acceptedAt: '2026-10-15T00:00:00.000Z' },
      { accountId: 'carol', email: 'carol@example.com', name: 'Carol', acceptedAt: '2026-10-15T00:00:00.000Z' },
    ],
    harnesses: [
      { accountId: 'bob', machineId: 'bob-mac', machinePublicKey: KEY, agentId: 'api', name: 'api', engine: 'codex' },
      { accountId: 'bob', machineId: 'bob-pc', machinePublicKey: KEY, agentId: 'web', name: 'web', engine: 'claude' },
      { accountId: 'alice', machineId: 'alice-mac', machinePublicKey: KEY, agentId: 'lead', name: 'lead', engine: 'claude' },
    ],
    invites: [{ email: 'dave@example.com', expiresAt: '2026-11-15T00:00:00.000Z' }],
    ...over,
  }
}

describe('observer grants a hosting computer derives from its rosters', () => {
  it('gives every other account in the tab its harness, named and tagged by tab, and its own account nothing', () => {
    expect(rosterGrants([roster()], { machineId: 'bob-mac', accountId: 'bob' }, ASKED)).toEqual([
      { agentId: 'api', email: 'alice@example.com', tab: 'a'.repeat(24), name: 'api', engine: 'codex' },
      { agentId: 'api', email: 'carol@example.com', tab: 'a'.repeat(24), name: 'api', engine: 'codex' },
    ])
    // The owner's computer grants its own harness to the members, never to the owner's own account.
    expect(rosterGrants([roster()], { machineId: 'alice-mac', accountId: 'alice' }, ASKED).map(g => g.email))
      .toEqual(['bob@example.com', 'carol@example.com'])
  })

  it('derives nothing for a harness on another machine or under another account', () => {
    expect(rosterGrants([roster()], { machineId: 'carol-mac', accountId: 'carol' }, ASKED)).toEqual([])
    // A roster listing this machine under another account (a foreign owner's word) grants nothing here.
    expect(rosterGrants([roster()], { machineId: 'bob-mac', accountId: 'carol' }, ASKED)).toEqual([])
    expect(rosterGrants([], { machineId: 'bob-mac', accountId: 'bob' }, ASKED)).toEqual([])
  })

  it('gives a pending invitation nothing: only accepted members and the owner watch', () => {
    const emails = rosterGrants([roster({ members: [] })], { machineId: 'bob-mac', accountId: 'bob' }, ASKED).map(g => g.email)
    expect(emails).toEqual(['alice@example.com'])
    expect(emails).not.toContain('dave@example.com')
  })

  it('grants nothing for a member harness this machine never asked for: the owner\'s word alone is not consent', () => {
    expect(rosterGrants([roster()], { machineId: 'bob-mac', accountId: 'bob' }, new Set())).toEqual([])
    // Asked in another tab is not asked in this one.
    expect(rosterGrants([roster()], { machineId: 'bob-mac', accountId: 'bob' }, new Set([`${'b'.repeat(24)}\nbob-mac\napi`]))).toEqual([])
    // The owner's own harnesses come from its desk: they need no asking.
    expect(rosterGrants([roster()], { machineId: 'alice-mac', accountId: 'alice' }, new Set())).toHaveLength(2)
  })

  it('lists one entry per tab, so a harness in two tabs is granted by each', () => {
    const second = roster({ sharedTabId: 'b'.repeat(24), members: [] })
    expect(rosterGrants([roster(), second], { machineId: 'bob-mac', accountId: 'bob' }, ASKED).map(g => `${g.tab[0]}:${g.email}`))
      .toEqual(['a:alice@example.com', 'a:carol@example.com', 'b:alice@example.com'])
  })
})
