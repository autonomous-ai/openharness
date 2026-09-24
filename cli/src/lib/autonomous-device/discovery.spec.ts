import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { discoverDevices, type DiscoveryTransport } from './discovery.js'

const lamp = { fqdn: 'lamp-ee17._autonomous._tcp.local', name: 'lamp-ee17', host: 'lamp-ee17.local', port: 80, addresses: ['172.168.20.174'] }
/** A fake multicast socket: `sendError` is what macOS returns for the probe query. */
function transport(options: { services?: typeof lamp[]; sendError?: string; bindError?: string } = {}) {
  const mdns = Object.assign(new EventEmitter(), {
    query: (_query: unknown, callback: (error?: NodeJS.ErrnoException | null) => void) =>
      queueMicrotask(() => callback(options.sendError ? Object.assign(new Error(`send ${options.sendError} 224.0.0.251:5353`), { code: options.sendError }) : null)),
  })
  let destroyed = false
  const create = (): DiscoveryTransport => ({
    find: onService => {
      for (const service of options.services ?? []) queueMicrotask(() => onService(service))
      if (options.bindError) queueMicrotask(() => mdns.emit('error', Object.assign(new Error(`bind ${options.bindError}`), { code: options.bindError })))
    },
    mdns,
    destroy: () => { destroyed = true },
  })
  return { create, destroyed: () => destroyed }
}

describe('autonomous device discovery', () => {
  it('lists advertised devices by their IPv4 address', async () => {
    const t = transport({ services: [lamp] })
    expect(await discoverDevices(20, t.create)).toEqual([{ id: lamp.fqdn, name: 'lamp-ee17', host: '172.168.20.174', port: 80 }])
    expect(t.destroyed()).toBe(true)
  })

  it('reports an empty network as empty, not as blocked', async () => {
    expect(await discoverDevices(20, transport().create)).toEqual([])
  })

  it.each(['EHOSTUNREACH', 'ENETUNREACH', 'EPERM'])('names a refused multicast send (%s) as a blocked local network', async code => {
    await expect(discoverDevices(20, transport({ sendError: code }).create)).rejects.toMatchObject({ code: 'LOCAL_NETWORK_BLOCKED' })
  })

  it('names a refused socket bind as a blocked local network instead of crashing on the error event', async () => {
    await expect(discoverDevices(1000, transport({ bindError: 'EACCES' }).create)).rejects.toMatchObject({ code: 'LOCAL_NETWORK_BLOCKED' })
  })

  it('trusts devices that answered over a failed probe', async () => {
    expect(await discoverDevices(20, transport({ services: [lamp], sendError: 'EHOSTUNREACH' }).create)).toHaveLength(1)
  })

  it('keeps other send failures out of the blocked diagnosis', async () => {
    expect(await discoverDevices(20, transport({ sendError: 'EMSGSIZE' }).create)).toEqual([])
  })
})
