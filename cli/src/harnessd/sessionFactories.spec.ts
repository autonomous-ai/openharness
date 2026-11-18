import { describe, expect, it } from 'vitest'
import { ENGINES } from '../engines/types.js'
import { CLOUD_AGENT_IDS } from '../lib/cloudAgents.js'
import { SERVICE_HOSTS, sessionFactoryOwners, type ServiceHostSpec } from './services.js'

const host = (service: string, ids: readonly string[]): ServiceHostSpec => ({ services: [service], heapLimitMiB: 128,
  rssLimitMiB: 384, factories: { [service]: ids } })

describe('factories owned by the selected artifact', () => {
  it('uses the native catalogue and the real component declaration without importing adapters', () => {
    const owner = sessionFactoryOwners(ENGINES)
    for (const engine of ENGINES) expect(owner(engine)).toEqual({ kind: 'native' })
    expect(SERVICE_HOSTS.cloud.factories).toEqual({ cloud: CLOUD_AGENT_IDS })
    for (const engine of CLOUD_AGENT_IDS) expect(owner(engine)).toEqual({ kind: 'service', service: 'cloud' })
    for (const value of ['', 'constructor', '__proto__', 'unknown', null, undefined, 7, {}]) expect(owner(value)).toBeUndefined()
  })

  it('keeps every native factory when the component is deleted', () => {
    const { cloud: _cloud, ...withoutCloud } = SERVICE_HOSTS
    const owner = sessionFactoryOwners(ENGINES, withoutCloud)
    for (const engine of ENGINES) expect(owner(engine)).toEqual({ kind: 'native' })
    for (const engine of CLOUD_AGENT_IDS) expect(owner(engine)).toBeUndefined()
  })

  it('keeps one immutable result after the declaration inputs change', () => {
    const native = ['claude'], ids = ['fo'], service = host('cloud', ids)
    const owner = sessionFactoryOwners(native, { cloud: service })
    native[0] = 'codex'; ids[0] = 'new-provider'
    expect(owner('claude')).toEqual({ kind: 'native' })
    expect(owner('fo')).toEqual({ kind: 'service', service: 'cloud' })
    expect(owner('codex')).toBeUndefined()
    expect(owner('new-provider')).toBeUndefined()
    expect(Object.isFrozen(owner('claude'))).toBe(true)
    expect(Object.isFrozen(owner('fo'))).toBe(true)
    expect(() => Object.assign(owner('fo')!, { service: 'other' })).toThrow(TypeError)
  })

  it.each([
    ['duplicate native', ['claude', 'claude'], {}],
    ['duplicate service ID', ['claude'], { cloud: host('cloud', ['fo', 'fo']) }],
    ['native collision', ['claude'], { cloud: host('cloud', ['claude']) }],
    ['two owners', [], { cloud: host('cloud', ['fo']), other: host('other', ['fo']) }],
    ['unknown owner', [], { cloud: { ...host('cloud', ['fo']), factories: { other: ['fo'] } } }],
    ['wrong host', [], { cloud: { ...host('cloud', ['fo']), factories: { other: ['fo'] } }, other: host('other', ['else']) }],
    ['multiply hosted owner', [], { cloud: host('cloud', ['fo']), second: host('cloud', ['else']) }],
    ['empty native ID', [''], {}],
    ['non-string native ID', [null], {}],
    ['invalid native ID', ['Claude Code'], {}],
    ['empty service ID', [], { cloud: host('cloud', ['']) }],
    ['non-string service ID', [], { cloud: { ...host('cloud', []), factories: { cloud: [7] } } }],
    ['invalid service ID', [], { cloud: host('cloud', ['../fo']) }],
    ['empty factory list', [], { cloud: host('cloud', []) }],
    ['non-array factory list', [], { cloud: { ...host('cloud', []), factories: { cloud: 'fo' } } }],
  ])('refuses %s instead of choosing an owner by precedence', (_name, native, hosts) => {
    expect(() => sessionFactoryOwners(native as string[], hosts as Record<string, ServiceHostSpec>))
      .toThrow('INVALID_SESSION_FACTORY_DECLARATION')
  })
})
