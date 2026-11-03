/**
 * The owner's daemon restarting (a CLI update) under a running Harness Team session: its engine holds the relay's address
 * and token from its launch, and its next model request must find the relay there again with no person acting.
 *
 * 2026-11-03: after the 0.5.26 update every running Team agent on Pro-9 and Pro-10 got "Connection refused" for four hours.
 * The relay runs in the owner's Swarm service, which the core started at a restart only for a Mac hosting a Swarm of its own
 * (core/api.ts EXPERIMENTS); a Mac that only lends its Team account started it at the first request that woke it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { EXPERIMENTS } from '../core/api.js'
import { wakeExperiments } from '../core/experiments.js'
import { startSubscriptionRelay } from '../lib/subscriptionRelay.js'
import type { TeamConfig } from './config.js'
import { readRememberedGrant, TEAM_RELAY_GRANT_FILE, TeamRelayPublisher, writeRememberedGrant, type TeamRelayGrant } from './relay.js'

const config = { user: 'harnessteam', owner: 'owner', ownerHome: '/Users/owner' } as TeamConfig
const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), 'team-relay-restart-')); cleanup.push(dir); return dir }
/** What the core asks for as it starts, the Swarm service running in a process of its own as it does under a master. */
const woken = (dir: string) => wakeExperiments({ dataDir: dir, experiments: EXPERIMENTS, outOfProcess: new Set(Object.keys(EXPERIMENTS)), want: () => {} })

describe('restarting the owner\'s daemon under a running Team session', () => {
  it('wakes the Swarm service at start while a Team relay is kept here, and the session\'s next model request succeeds', async () => {
    const dir = dataDir()
    const file = join(dir, TEAM_RELAY_GRANT_FILE)
    const owner = { read: async () => ({ provider: 'claude' as const, accessToken: 'owner-fixture', expiresAt: null, accountId: null }), refresh: async () => null }
    const upstream = createServer((_req, res) => { res.writeHead(200); res.end('{}') })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => { upstream.closeAllConnections(); upstream.close() })
    const claude = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    // The Swarm service's relay, as superTabs/service.ts wires it, on this data folder's kept grant.
    const service = () => {
      let present = false
      const published: TeamRelayGrant[] = []
      const p = new TeamRelayPublisher({ config: () => config, user: () => 'owner', team: () => false,
        startRelay: port => startSubscriptionRelay({ owner, upstream: { claude }, ...(port ? { port } : {}) }),
        publish: async (_c, grant) => { present = true; published.push(grant) }, published: () => present, withdraw: () => { present = false }, log: () => {},
        remembered: () => readRememberedGrant(file), remember: grant => writeRememberedGrant(file, grant), forget: () => rmSync(file, { force: true }), wait: async () => {} })
      return { p, published }
    }
    const before = service()
    await before.p.tick()
    // The running session: Claude Code launched with the grant's address and token in its environment.
    const session = before.published[0]!
    const ask = async () => (await fetch(`${session.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: '{}' })).status
    expect(await ask()).toBe(200)

    // The update: the daemon stops, and with it the relay.
    await before.p.stop()
    await expect(ask()).rejects.toThrow()

    // The new daemon's core starts the Swarm service only if it asks for it; this Mac hosts no Swarm of its own.
    const after = woken(dir).includes('superTabs') ? service() : null
    await after?.p.tick()
    onTestFinished(() => after?.p.stop())
    expect(await ask().catch((error: Error) => `refused: ${(error.cause as Error | undefined)?.message ?? error.message}`)).toBe(200)
  })

  it('wakes nothing for a data folder with neither the grant nor a host journal', () => {
    expect(woken(dataDir())).toEqual([])
  })

  it('names the kept grant by the name the publisher writes, beside the host journal', () => {
    expect(EXPERIMENTS.superTabs!.state).toEqual(expect.arrayContaining([TEAM_RELAY_GRANT_FILE, 'super-tabs/host-*.json']))
    const dir = dataDir()
    writeFileSync(join(dir, TEAM_RELAY_GRANT_FILE), '{}')
    expect(woken(dir)).toEqual(['superTabs'])
  })
})
