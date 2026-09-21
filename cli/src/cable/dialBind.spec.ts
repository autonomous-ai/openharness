import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { bindTokenForTcp, bindTokenForUsb, isTcpDialPath, setDialBindDirForTest } from './dialBind.js'

describe('dial bind', () => {
  it('mints a token on USB and reuses it, and TCP cannot invent one', () => {
    setDialBindDirForTest(mkdtempSync(join(tmpdir(), 'bind-')))
    expect(bindTokenForTcp('aa:bb:cc:dd:ee:ff')).toBeNull()
    const a = bindTokenForUsb('aa:bb:cc:dd:ee:ff')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(bindTokenForUsb('AA:BB:CC:DD:EE:FF')).toBe(a)
    expect(bindTokenForTcp('aa:bb:cc:dd:ee:ff')).toBe(a)
    expect(bindTokenForTcp('11:22:33:44:55:66')).toBeNull()
    expect(isTcpDialPath('tcp:10.0.0.8:17420')).toBe(true)
    expect(isTcpDialPath('/dev/cu.usbmodem1101')).toBe(false)
    setDialBindDirForTest(undefined)
  })
})

