import { describe, expect, it } from 'vitest'
import { checkSid } from './sid.js'
import { windowsUserSid } from './whoami.js'

describe('windowsUserSid', () => {
  it('reads the SID whoami /user prints, a name with a comma included, and nothing else', () => {
    expect(windowsUserSid('"desktop-0tfh0oj\\dell","S-1-5-21-3073114020-2660841771-734626734-1001"\r\n')).toBe('S-1-5-21-3073114020-2660841771-734626734-1001')
    expect(windowsUserSid('"CORP\\Smith, Jo","S-1-5-21-1-2-3-1105"\r\n')).toBe('S-1-5-21-1-2-3-1105')
    expect(windowsUserSid('"a ""quoted"" name","S-1-5-18"')).toBe('S-1-5-18')
    expect(windowsUserSid('')).toBeNull()
    expect(windowsUserSid('"x","not a sid"')).toBeNull()
  })
})

describe('checkSid', () => {
  it('takes a SID, nothing else', () => {
    expect(checkSid('S-1-5-21-3073114020-2660841771-734626734-1001')).toBe('S-1-5-21-3073114020-2660841771-734626734-1001')
    for (const sid of ['', 'S-1', 'S-1-5-', 's-1-5-18', "S-1-5-18'", 'S-1-5-18 ']) expect(() => checkSid(sid), sid).toThrow(/not a SID/)
  })
})
