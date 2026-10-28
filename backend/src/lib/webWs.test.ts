import { describe, expect, it } from 'vitest'
import { BACKEND_ONLY_DOWN_TYPES, declaredClient } from './webWs.js'

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
    // super_tab_deliveries makes a Swarm host read an agent's deliveries early (lib/adapterDeliveryPushes.ts):
    // forged in a loop, that is request amplification against our own API. device_keys_changed makes the
    // daemon re-read its device key log; devlog_append_result is the backend's answer to its own append.
    expect([...BACKEND_ONLY_DOWN_TYPES].sort()).toEqual(['connectors_changed', 'desk_changed', 'device_keys_changed', 'devlog_append_result', 'machine_meta', 'machine_revoked', 'machines_changed', 'super_tab_deliveries', 'zoo_changed'])
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
