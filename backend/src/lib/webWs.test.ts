import { describe, expect, it } from 'vitest'
import { BACKEND_ONLY_DOWN_TYPES, declaredClient, sendWhenAwake } from './webWs.js'
import type { HubClient } from './hub.js'

/**
 * `handleFrame` forwards anything it does not recognise straight to the adapter
 * (`client.sendDown(frame)`), so the only thing standing between a web client and a frame the
 * adapter obeys as the backend's own is the refusal list. `handleFrame` itself needs a live socket
 * to exercise, so what is pinned here is that list — the realistic regression is an entry being
 * dropped during a tidy-up, which reopens the hole silently.
 */
describe('frames a web client may never forge', () => {
  it('refuses the backend-authoritative frames that are not `__`-prefixed', () => {
    // machine_meta names the account's private grid — the inference endpoint every agent on that
    // computer is then pointed at. machine_revoked makes the adapter clear its session and exit.
    // desk_changed / zoo_changed / machines_changed / connectors_changed make every window re-read from the backend:
    // forged in a loop, that is request amplification against our own API. device_keys_changed makes the
    // daemon re-read its device key log; devlog_append_result is the backend's answer to its own append.
    expect([...BACKEND_ONLY_DOWN_TYPES].sort()).toEqual(['connectors_changed', 'desk_changed', 'device_keys_changed', 'devlog_append_result', 'machine_meta', 'machine_revoked', 'machines_changed', 'zoo_changed'])
  })

  it('covers only frames that are NOT already caught by the `__` rule', () => {
    // A `__`-prefixed type here would be dead weight: handleFrame drops those earlier, and listing
    // one would suggest this set is the whole rule rather than the exception to it.
    for (const type of BACKEND_ONLY_DOWN_TYPES) expect(type.startsWith('__')).toBe(false)
  })
})

describe('who a per-user socket says it is', () => {
  const declared = (query: string) => declaredClient(new URLSearchParams(query))

  it('reads the phone\'s surface, release and debug flag', () => {
    expect(declared('client=mobile&release=1.0.8')).toEqual({ surface: 'mobile', build: { release: '1.0.8', debug: false } })
    expect(declared('autonomousEnv=prod&client=mobile&release=1.0.8&debug=1')).toEqual({ surface: 'mobile', build: { release: '1.0.8', debug: true } })
  })

  it('takes an app that predates the release as no release and not a debug build', () => {
    expect(declared('client=mobile')).toEqual({ surface: 'mobile', build: { release: null, debug: false } })
  })

  it('takes only debug=1 as a debug build', () => {
    for (const value of ['0', 'true', '', 'yes', '2']) expect(declared(`client=mobile&debug=${value}`).build.debug).toBe(false)
  })

  it('says nothing of the build for the web viewer or an undeclared client', () => {
    expect(declared('client=web&release=1.0.8&debug=1')).toEqual({ surface: 'web', build: {} })
    expect(declared('release=1.0.8&debug=1')).toEqual({ surface: null, build: {} })
    expect(declared('client=desktop&release=1.0.8')).toEqual({ surface: null, build: {} })
  })
})

/** A frame waits for its machine to wake before it goes down (2026-10-28 prod: "Cannot read properties of null (reading
 *  'sendDown')", once the person deselected the machine during that wait). */
describe('a frame sent once its machine is awake', () => {
  const hubClient = () => { const sent: unknown[] = []; return { sent, client: { sendDown: (frame: unknown) => { sent.push(frame) } } as unknown as HubClient } }
  const frame = { type: 'message', payload: { text: 'hi' } }

  it('goes to the client still selected', async () => {
    const a = hubClient()
    await sendWhenAwake(() => a.client, async () => {}, frame)
    expect(a.sent).toEqual([frame])
  })

  it('is dropped when the machine was deselected, or another selected, during the wake', async () => {
    const a = hubClient(), b = hubClient()
    let selected: HubClient | null = a.client
    await sendWhenAwake(() => selected, async () => { selected = null }, frame)
    selected = a.client
    await sendWhenAwake(() => selected, async () => { selected = b.client }, frame)
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([])
  })

  it('sends nothing when the wake fails, and says why', async () => {
    const a = hubClient()
    await expect(sendWhenAwake(() => a.client, async () => { throw new Error('Machine could not be started') }, frame)).rejects.toThrow('Machine could not be started')
    expect(a.sent).toEqual([])
  })
})
