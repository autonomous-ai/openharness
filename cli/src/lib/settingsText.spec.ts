import { describe, expect, it } from 'vitest'
import { settingsText } from './settingsText.js'

const bom = '﻿'

describe('settingsText', () => {
  it('drops one leading BOM, as PowerShell 5 writes it', () => {
    expect(settingsText(Buffer.from(`${bom}{"a":1}\n`))).toBe('{"a":1}\n')
  })

  it('keeps a second leading BOM and any BOM past the start', () => {
    expect(settingsText(Buffer.from(`${bom}${bom}{}`))).toBe(`${bom}{}`)
    expect(settingsText(Buffer.from(`{"a":"${bom}"}`))).toBe(`{"a":"${bom}"}`)
  })

  it('leaves text without a BOM as it is', () => {
    expect(settingsText(Buffer.from('{"a":"é"}\r\n'))).toBe('{"a":"é"}\r\n')
  })

  it('throws on bytes that are not UTF-8, as a UTF-16 file is', () => {
    expect(() => settingsText(Buffer.from([0xff, 0xfe, 0x7b, 0x00]))).toThrow()
  })
})
