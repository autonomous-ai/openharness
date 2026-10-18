import { describe, expect, it } from 'vitest'
import { b64d, b64e, newIdentity, verify } from '../lib/e2ee/core.js'
import { keyChangeBytes, rosterBytes } from '../messages/roster.js'
import { TabSessions } from './tabKey.js'

const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const alice = newIdentity(), bob = newIdentity()
const A = new TabSessions(() => alice, () => 'alice-mac'), B = new TabSessions(() => bob, () => 'bob-mini')
const toBob = { sharedTabId: TAB, machineId: 'bob-mini', peerPub: b64e(bob.pub) }
const toAlice = { sharedTabId: TAB, machineId: 'alice-mac', peerPub: b64e(alice.pub) }

describe('the gateway\'s shared-tab keys', () => {
  it('signs a roster and a key change with this machine\'s identity, and nothing malformed', async () => {
    expect(await A.publicKey()).toBe(b64e(alice.pub))
    const s = await A.signRoster(TAB, 2, '{"x":1}')
    expect(verify(alice.pub, rosterBytes(TAB, 2, '{"x":1}'), b64d(s))).toBe(true)
    const k = await A.signKeyChange(TAB, b64e(bob.pub))
    expect(verify(alice.pub, keyChangeBytes(TAB, b64e(bob.pub)), b64d(k))).toBe(true)
    await expect(A.signRoster('tab-1', 2, '{}')).rejects.toThrow('not a roster')
    await expect(A.signRoster(TAB, 0, '{}')).rejects.toThrow('not a roster')
    await expect(A.signKeyChange(TAB, 'AAAA')).rejects.toThrow('not a key')
  })

  it('runs a session from hello to sealed frames, and refuses a stranger', async () => {
    const hello = await A.hello(toBob)
    const answer = await B.accept(toAlice, hello)
    expect('welcome' in answer).toBe(true)
    expect(await A.welcome(toBob, (answer as { welcome: Record<string, unknown> }).welcome)).toBe(true)
    const sealed = await A.seal(toBob, { type: 'ping' })
    expect(await B.open(toAlice, (sealed as { frame: Record<string, unknown> }).frame)).toEqual({ frame: { type: 'ping' } })
    expect(await B.open(toAlice, { __e2e: { v: 1, k: 'p', n: 99, ct: 'AA' } })).toEqual({ unreadable: true })
    expect(await B.accept({ ...toAlice, peerPub: b64e(newIdentity().pub) }, hello)).toEqual({ refused: true })
    expect(await B.accept(toAlice, { nonsense: 1 })).toEqual({ refused: true })
  })

  it('seals and opens nothing without a session, and forgets one dropped', async () => {
    const other = { ...toBob, machineId: 'carol-pc' }
    expect(await A.seal(other, {})).toEqual({ lost: true })
    expect(await A.open(other, {})).toEqual({ lost: true })
    expect(await A.welcome(other, {})).toBe(false)
    expect(await A.welcome(toBob, { ephemeral: 1 })).toBe(false)
    A.drop(toBob)
    expect(await A.seal(toBob, {})).toEqual({ lost: true })
    A.clear()
  })

  it('refuses what came off the wire as something else, and spends a hello on a welcome that fails', async () => {
    const wire = (value: unknown) => value as never
    await expect(A.signRoster(wire(7), 2, '{}')).rejects.toThrow('not a roster')
    await expect(A.signRoster(TAB, 2, wire(null))).rejects.toThrow('not a roster')
    await expect(A.signKeyChange(TAB, wire(null))).rejects.toThrow('not a key')
    await expect(A.signKeyChange(wire(undefined), b64e(bob.pub))).rejects.toThrow('not a key')
    expect(await B.accept(toAlice, wire(null))).toEqual({ refused: true })
    expect(await B.accept(toAlice, wire([]))).toEqual({ refused: true })

    const hello = await A.hello(toBob)
    const answer = await B.accept(toAlice, hello) as { welcome: Record<string, unknown> }
    expect(await A.welcome(toBob, wire(null))).toBe(false)
    // The finish is one-shot: the good welcome that follows finds no hello, and the caller says hello again.
    expect(await A.welcome(toBob, answer.welcome)).toBe(false)
    expect(await A.seal(toBob, {})).toEqual({ lost: true })
    const again = await B.accept(toAlice, await A.hello(toBob)) as { welcome: Record<string, unknown> }
    expect(await A.welcome(toBob, again.welcome)).toBe(true)
    A.clear()
    expect(await A.seal(toBob, {})).toEqual({ lost: true })
  })
})
