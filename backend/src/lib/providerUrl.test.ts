import { describe, expect, it } from 'vitest'
import { isBlockedAddress } from './providerUrl.js'

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
