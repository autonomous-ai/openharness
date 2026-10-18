import { describe, expect, it, vi } from 'vitest'
import { TAB_KEY_OFF, type TabKey } from '../core/api.js'
import { answerTabKey, askTabKey, TAB_KEY_ABSENT, TAB_KEY_METHODS } from './tabKeyWire.js'

const link = { sharedTabId: 'a1b2c3d4e5f6a1b2c3d4e5f6', machineId: 'bob-mini', peerPub: 'UEVFUg==' }

describe('shared tabs\' keys asked across a process', () => {
  it('answers the nine methods with what the key said, and nothing else', async () => {
    const key = {
      publicKey: vi.fn(async () => 'cHVi'), signRoster: vi.fn(async () => 'cm9z'), signKeyChange: vi.fn(async () => 'a2V5'),
      hello: vi.fn(async () => ({ ephemeral: 'e' })), welcome: vi.fn(async () => true), accept: vi.fn(async () => ({ welcome: { ephemeral: 'w' } })),
      seal: vi.fn(async () => ({ frame: { __e2e: 1 } })), open: vi.fn(async () => ({ unreadable: true as const })), drop: vi.fn(),
    } satisfies TabKey
    expect(TAB_KEY_METHODS).toHaveLength(9)
    expect(await answerTabKey(key, { method: 'publicKey' })).toEqual({ result: 'cHVi' })
    expect(await answerTabKey(key, { method: 'signRoster', args: [link.sharedTabId, 2, '{}'] })).toEqual({ result: 'cm9z' })
    expect(key.signRoster).toHaveBeenCalledWith(link.sharedTabId, 2, '{}')
    // The signatures' arguments are the key's to refuse: passed as they came.
    await answerTabKey(key, { method: 'signKeyChange', args: [7, null] })
    expect(key.signKeyChange).toHaveBeenCalledWith(7, null)
    expect(await answerTabKey(key, { method: 'hello', args: [link] })).toEqual({ result: { ephemeral: 'e' } })
    expect(await answerTabKey(key, { method: 'welcome', args: [link, { ephemeral: 'w' }] })).toEqual({ result: true })
    expect(await answerTabKey(key, { method: 'accept', args: [link, { ephemeral: 'h' }] })).toEqual({ result: { welcome: { ephemeral: 'w' } } })
    expect(await answerTabKey(key, { method: 'seal', args: [link, { type: 'ping' }] })).toEqual({ result: { frame: { __e2e: 1 } } })
    expect(await answerTabKey(key, { method: 'open', args: [link, { __e2e: 1 }] })).toEqual({ result: { unreadable: true } })
    expect(await answerTabKey(key, { method: 'drop', args: [link] })).toEqual({})
    expect(key.drop).toHaveBeenCalledWith(link)
    // A link and a frame are taken as the shapes they must be, whatever came.
    await answerTabKey(key, { method: 'seal', args: [{ sharedTabId: 1, machineId: null }, 'not a frame'] })
    expect(key.seal).toHaveBeenLastCalledWith({ sharedTabId: '', machineId: '', peerPub: '' }, {})
    await answerTabKey(key, { method: 'welcome', args: 'not a list' })
    expect(key.welcome).toHaveBeenLastCalledWith({ sharedTabId: '', machineId: '', peerPub: '' }, {})
    for (const method of ['clear', 'constructor', '__proto__', 'toString', 7, undefined]) {
      expect(await answerTabKey(key, { method, args: [] })).toEqual({ error: 'UNKNOWN_METHOD' })
    }
  })

  it('answers a refusal or a failure with why, never thrown across the link', async () => {
    expect(await answerTabKey(TAB_KEY_OFF, { method: 'hello', args: [link] })).toEqual({ error: 'no key: this process holds no E2EE identity' })
    const odd = { ...TAB_KEY_OFF, publicKey: () => Promise.reject('odd') }
    expect(await answerTabKey(odd, { method: 'publicKey', args: [] })).toEqual({ error: 'odd' })
  })

  it('asks each method as one call, and falls back as TAB_KEY_OFF does when nobody answers', async () => {
    let answer: Record<string, unknown> | Error = { result: 'c2ln' }
    const call = vi.fn(async (_payload: Record<string, unknown>) => { if (answer instanceof Error) throw answer; return answer })
    const key = askTabKey(call)
    expect(await key.publicKey()).toBe('c2ln')
    expect(call).toHaveBeenLastCalledWith({ method: 'publicKey', args: [] })
    expect(await key.signRoster(link.sharedTabId, 2, '{}')).toBe('c2ln')
    expect(call).toHaveBeenLastCalledWith({ method: 'signRoster', args: [link.sharedTabId, 2, '{}'] })
    expect(await key.signKeyChange(link.sharedTabId, 'UEVFUg==')).toBe('c2ln')
    expect(call).toHaveBeenLastCalledWith({ method: 'signKeyChange', args: [link.sharedTabId, 'UEVFUg=='] })
    answer = { result: { ephemeral: 'e' } }
    expect(await key.hello(link)).toEqual({ ephemeral: 'e' })
    answer = { result: true }
    expect(await key.welcome(link, { ephemeral: 'w' })).toBe(true)
    expect(call).toHaveBeenLastCalledWith({ method: 'welcome', args: [link, { ephemeral: 'w' }] })
    answer = { result: { welcome: { ephemeral: 'w' } } }
    expect(await key.accept(link, {})).toEqual({ welcome: { ephemeral: 'w' } })
    answer = { result: { frame: { __e2e: 1 } } }
    expect(await key.seal(link, {})).toEqual({ frame: { __e2e: 1 } })
    expect(await key.open(link, {})).toEqual({ frame: { __e2e: 1 } })
    answer = { result: { unreadable: true } }
    expect(await key.open(link, {})).toEqual({ unreadable: true })
    key.drop(link)
    expect(call).toHaveBeenLastCalledWith({ method: 'drop', args: [link] })

    // The key's own refusal is said as it was; the link's (`SERVICE_…`), or none, as the key being away.
    answer = { error: 'not a roster' }
    await expect(key.signRoster('x', 0, '')).rejects.toThrow('not a roster')
    await expect(key.hello(link)).rejects.toThrow('not a roster')
    for (const absent of [{ error: 'SERVICE_UNAVAILABLE' }, {}, { result: ['not', 'a', 'frame'] }]) {
      answer = absent
      await expect(key.publicKey()).rejects.toThrow(TAB_KEY_ABSENT)
      await expect(key.hello(link)).rejects.toThrow(TAB_KEY_ABSENT)
      expect(await key.welcome(link, {})).toBe(false)
      expect(await key.accept(link, {})).toEqual({ refused: true })
      expect(await key.seal(link, {})).toEqual({ lost: true })
      expect(await key.open(link, {})).toEqual({ lost: true })
    }
    answer = { result: { welcome: 'w', frame: 'f' } }
    expect(await key.accept(link, {})).toEqual({ refused: true })
    expect(await key.seal(link, {})).toEqual({ lost: true })

    // No link at all: the signatures and the hello reject with it; the rest fall back; a drop is never waited on.
    answer = new Error('not connected to the core')
    await expect(key.publicKey()).rejects.toThrow('not connected to the core')
    await expect(key.hello(link)).rejects.toThrow('not connected to the core')
    expect(await key.welcome(link, {})).toBe(false)
    expect(await key.accept(link, {})).toEqual({ refused: true })
    expect(await key.seal(link, {})).toEqual({ lost: true })
    expect(await key.open(link, {})).toEqual({ lost: true })
    expect(key.drop(link)).toBeUndefined()
  })
})
