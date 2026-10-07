import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatewayNeeded, wakeGateway } from './gatewayWake.js'

describe('the gateway needed as the core starts', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'gateway-wake-')) })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it('is not, signed out with nothing paired: nothing could reach it, and it would dial nothing', () => {
    expect(gatewayNeeded({ signedIn: false, dataDir })).toBeNull()
    // Lists that are there and empty, or not lists, pair nothing.
    mkdirSync(join(dataDir, 'e2e'))
    writeFileSync(join(dataDir, 'e2e', 'paired.json'), '[]')
    writeFileSync(join(dataDir, 'autonomous-device-connections.json'), '{"not":"a list"}')
    expect(gatewayNeeded({ signedIn: false, dataDir })).toBeNull()
  })

  it('is, signed in: the relay, the remote clients, the trust group and the device key log are its', () => {
    expect(gatewayNeeded({ signedIn: true, dataDir })).toBe('signed in')
  })

  it('is, with anything paired here, whatever its role, or a Wi-Fi device linked directly', () => {
    mkdirSync(join(dataDir, 'e2e'))
    writeFileSync(join(dataDir, 'e2e', 'paired.json'), JSON.stringify([{ identityPub: 'p', label: 'browser', pairedAt: 1, role: 'web' }]))
    expect(gatewayNeeded({ signedIn: false, dataDir })).toBe('a pairing')
    writeFileSync(join(dataDir, 'e2e', 'paired.json'), '[]')
    writeFileSync(join(dataDir, 'autonomous-device-connections.json'), JSON.stringify([{ discoveryId: 'd', fingerprint: 'f' }]))
    expect(gatewayNeeded({ signedIn: false, dataDir })).toBe('a direct link')
  })
})

describe('the gateway asked for as the core starts', () => {
  it('when it runs out here and is needed, saying why', () => {
    const wanted: string[] = []
    const lines: string[] = []
    wakeGateway({ outOfProcess: new Set(['gateway']), signedIn: true, dataDir: '/nowhere', want: (service) => wanted.push(service), log: (line) => lines.push(line) })
    expect(wanted).toEqual(['gateway'])
    expect(lines).toEqual(['[gateway] signed in: asking for the gateway\'s process'])
  })

  it('not when it is not needed, nor when it runs in the core\'s process', () => {
    const wanted: string[] = []
    wakeGateway({ outOfProcess: new Set(['gateway']), signedIn: false, dataDir: '/nowhere', want: (service) => wanted.push(service) })
    wakeGateway({ outOfProcess: new Set(['search']), signedIn: true, dataDir: '/nowhere', want: (service) => wanted.push(service) })
    expect(wanted).toEqual([])
  })

  it('says why on the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      wakeGateway({ outOfProcess: new Set(['gateway']), signedIn: true, dataDir: '/nowhere', want: () => {} })
      expect(log).toHaveBeenCalledWith('[gateway] signed in: asking for the gateway\'s process')
    } finally { log.mockRestore() }
  })
})
