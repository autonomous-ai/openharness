import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress, LookupAllOptions } from 'node:dns'
import { getDefaultAutoSelectFamily, type LookupFunction } from 'node:net'
import { env } from '../config/env.js'
import { isBlockedAddress, providerFetch, readBodyCapped } from './providerUrl.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))
vi.mock('../config/env.js', () => ({ env: { PROVIDER_ALLOW_INSECURE_URLS: false } }))

afterEach(() => {
  vi.resetAllMocks()
  env.PROVIDER_ALLOW_INSECURE_URLS = false
})

describe('isBlockedAddress', () => {
  it('judges every spelling of an IPv4-carrying IPv6 address as that IPv4', () => {
    for (const ip of [
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '[::ffff:a9fe:a9fe]', '0:0:0:0:0:ffff:a9fe:a9fe', '::FFFF:A9FE:A9FE',
      '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:0:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1', '2002:a9fe:a9fe::1', '2002:c0a8:0101::',
    ]) expect(isBlockedAddress(ip), ip).toBe(true)
    // …and lets through what the same IPv4 rules let through.
    for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it('refuses the IPv6 ranges that never reach the public internet', () => {
    for (const ip of [
      '::', '::1', '0:0:0:0:0:0:0:1', '::a9fe:a9fe', '::169.254.169.254',
      '64:ff9b:1::1', '100::1', '2001:db8::1', '2001:0:4136:e378::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', 'fe80::1%en0',
    ]) expect(isBlockedAddress(ip), ip).toBe(true)
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) expect(isBlockedAddress(ip), ip).toBe(false)
  })

  it('keeps the IPv4 rules', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '0.0.0.0']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
  })
})

describe('providerFetch DNS callback', () => {
  // Select the all-address overload used by the guarded connection lookup.
  const lookupAll: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]> = dnsLookup
  // Drive the exact hook installed on HTTPS requests, without dialing fixture addresses.
  async function connect(all: boolean, host = 'provider.example') {
    let resolved: { address: unknown; family?: number } | undefined
    vi.mocked(httpsRequest).mockImplementation(((
      options: { hostname: string; lookup: LookupFunction },
      onResponse: (response: IncomingMessage) => void,
    ) => {
      const request = Object.assign(new EventEmitter(), {
        write: vi.fn(), destroy: vi.fn(),
        end: () => options.lookup(options.hostname, { all }, (error, address, family) => {
          if (error) request.emit('error', error)
          else {
            resolved = { address, family }
            onResponse({ statusCode: 200, headers: {} } as IncomingMessage)
          }
        }),
      })
      return request
    }) as unknown as typeof httpsRequest)
    await providerFetch(`https://${host}`)
    return resolved
  }

  it('returns every validated address for all:true and the scalar shape otherwise', async () => {
    const entries = [{ address: '1.1.1.1', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]
    for (const all of [true, false]) {
      vi.mocked(lookupAll).mockResolvedValue(entries)
      expect(await connect(all)).toEqual(all
        ? { address: entries, family: undefined }
        : { address: entries[0]!.address, family: 4 })
    }
    vi.mocked(dnsLookup).mockClear()
    for (const [host, address, family] of [['1.1.1.1', '1.1.1.1', 4], ['[2606:4700:4700::1111]', '2606:4700:4700::1111', 6]] as const) {
      for (const all of [true, false]) expect(await connect(all, host)).toEqual(all
        ? { address: [{ address, family }], family: undefined }
        : { address, family })
    }
    expect(dnsLookup).not.toHaveBeenCalled()
  })

  it('refuses the entire answer set when any address is blocked, in both callback modes', async () => {
    for (const all of [true, false]) {
      for (const entries of [
        [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
        [{ address: '2606:4700:4700::1111', family: 6 }, { address: '::ffff:a9fe:a9fe', family: 6 }],
        [],
      ]) {
        vi.mocked(lookupAll).mockResolvedValue(entries)
        await expect(connect(all)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' })
      }
      for (const host of ['127.0.0.1', '[::1]']) {
        await expect(connect(all, host)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' })
      }
      vi.mocked(dnsLookup).mockRejectedValue(new Error('fixture resolution failed'))
      await expect(connect(all)).rejects.toMatchObject({ code: 'DNS_FAILED' })
    }
  })

  it('works with a real Node socket using default family autoselection', async () => {
    expect(getDefaultAutoSelectFamily()).toBe(true)
    // The stock development flag is only for this isolated loopback HTTP fixture.
    env.PROVIDER_ALLOW_INSECURE_URLS = true
    vi.mocked(lookupAll).mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const server = createServer((_request, response) => response.end('original provider response'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP')
      const response = await providerFetch(`http://provider.example:${address.port}`)
      expect(response.status).toBe(200)
      expect(await readBodyCapped(response)).toBe('original provider response')
      expect(dnsLookup).toHaveBeenCalledWith('provider.example', { all: true, verbatim: true })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
