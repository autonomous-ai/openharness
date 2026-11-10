import { describe, expect, it } from 'vitest'
import { defaultSettings, humanMode, parseSettings, publicSettings, settingsHash, type BrowserSettings } from './settings.js'

const host = { timeZone: 'Asia/Ho_Chi_Minh', languages: 'vi-VN' }

const withProxy: BrowserSettings = {
  ...defaultSettings(host),
  proxy: { scheme: 'socks5', host: 'proxy.example.com', port: 1080, username: 'me', password: 'secret-pw' },
}

describe('agent browser settings', () => {
  it("defaults follow the machine's zone and language", () => {
    expect(defaultSettings(host)).toEqual({
      proxy: null,
      timeZone: null,
      languages: 'vi-VN',
      screen: '1920x1080',
      humanInput: true,
      humanSpeed: 'normal',
      device: null,
    })
    expect(humanMode(defaultSettings(host))).toBe('normal')
  })

  it('parseSettings rejects an unknown screen, a bad port, a host with spaces, and an unknown zone', () => {
    const current = defaultSettings(host)
    const raw = { ...withProxy, proxy: { ...withProxy.proxy } }
    expect(parseSettings(raw, current)).toEqual(withProxy)
    expect(() => parseSettings({ ...raw, screen: '800x600' }, current)).toThrow(/screen/)
    for (const port of [0, 65536, 80.5, '80']) {
      expect(() => parseSettings({ ...raw, proxy: { ...raw.proxy, port } }, current)).toThrow(/proxy\.port/)
    }
    expect(() => parseSettings({ ...raw, proxy: { ...raw.proxy, host: 'proxy example.com' } }, current)).toThrow(
      /proxy\.host/,
    )
    expect(() => parseSettings({ ...raw, timeZone: 'Mars/Base' }, current)).toThrow(/timeZone/)
    expect(() => parseSettings({ ...raw, timeZone: '+07:00' }, current)).toThrow(/timeZone/)
    expect(parseSettings({ ...raw, timeZone: 'Europe/Berlin' }, current).timeZone).toBe('Europe/Berlin')
    expect(() => parseSettings({ ...raw, languages: 'vi-VN, not a tag' }, current)).toThrow(/languages/)
    expect(() => parseSettings({ ...raw, humanSpeed: 'warp' }, current)).toThrow(/humanSpeed/)
    expect(() => parseSettings({ ...raw, device: { gpuVendor: 'x', gpuRenderer: 'y', cpuCores: 0, memoryGb: 8 } }, current)).toThrow(
      /device\.cpuCores/,
    )
    expect(() => parseSettings(null, current)).toThrow(/settings/)
  })

  it('saving without a password keeps the stored one', () => {
    const { password: _password, ...proxy } = withProxy.proxy!
    const saved = parseSettings({ ...withProxy, proxy: { ...proxy, passwordSet: true } }, withProxy)
    expect(saved.proxy?.password).toBe('secret-pw')
    expect(parseSettings({ ...withProxy, proxy: { ...proxy, password: 'new-pw' } }, withProxy).proxy?.password).toBe('new-pw')
  })

  it('a proxy changed in scheme, host, port or username never gets the stored password', () => {
    const { password: _password, ...proxy } = withProxy.proxy!
    for (const changed of [{ scheme: 'http' }, { host: 'other.example.com' }, { port: 1081 }, { username: 'you' }]) {
      expect(parseSettings({ ...withProxy, proxy: { ...proxy, ...changed } }, withProxy).proxy?.password, JSON.stringify(changed)).toBe('')
    }
    expect(parseSettings({ ...withProxy, proxy }, defaultSettings(host)).proxy?.password).toBe('')
  })

  it('publicSettings never contains the password', () => {
    const shown = publicSettings(withProxy)
    expect(JSON.stringify(shown)).not.toContain('secret-pw')
    expect(shown).toEqual({
      ...withProxy,
      proxy: { scheme: 'socks5', host: 'proxy.example.com', port: 1080, username: 'me', passwordSet: true },
    })
    expect(publicSettings(defaultSettings(host)).proxy).toBeNull()
  })

  it('settingsHash ignores human input and changes with every other field', () => {
    const base = settingsHash(withProxy)
    expect(settingsHash({ ...withProxy, humanInput: false, humanSpeed: 'fast' })).toBe(base)
    const proxy = withProxy.proxy!
    const changed: BrowserSettings[] = [
      { ...withProxy, proxy: null },
      { ...withProxy, proxy: { ...proxy, scheme: 'http' } },
      { ...withProxy, proxy: { ...proxy, host: 'other.example.com' } },
      { ...withProxy, proxy: { ...proxy, port: 1081 } },
      { ...withProxy, proxy: { ...proxy, username: 'you' } },
      { ...withProxy, proxy: { ...proxy, password: 'other-pw' } },
      { ...withProxy, timeZone: 'Europe/Berlin' },
      { ...withProxy, languages: 'en-US' },
      { ...withProxy, screen: '1366x768' },
      { ...withProxy, device: { gpuVendor: 'Apple', gpuRenderer: 'Apple M2', cpuCores: 8, memoryGb: 8 } },
    ]
    for (const s of changed) expect(settingsHash(s)).not.toBe(base)
  })

  it('humanMode is off when human input is off', () => {
    expect(humanMode({ ...withProxy, humanInput: false, humanSpeed: 'slow' })).toBe('off')
    expect(humanMode({ ...withProxy, humanSpeed: 'fast' })).toBe('fast')
  })
})
