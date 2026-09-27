import { describe, expect, it } from 'vitest'
import { DAEMONS_DARK, daemonsFor, describeDaemonsSwitch, parseDaemonsSwitch } from './daemonsSwitch.js'

describe('the daemons switch', () => {
  it('is off unless it says so plainly', () => {
    for (const flag of [undefined, '', 'false', '0', 'off', 'no', 'maybe', 'truthy']) expect(parseDaemonsSwitch(flag).on).toBe(false)
    for (const flag of ['true', '1', 'on', 'yes', ' TRUE ', 'On']) expect(parseDaemonsSwitch(flag).on).toBe(true)
  })

  it('reads the allowlist as ids and case-free emails, and an empty one as everyone', () => {
    expect(parseDaemonsSwitch('true', '').users).toBeNull()
    expect(parseDaemonsSwitch('true', ' , ').users).toBeNull()
    expect([...parseDaemonsSwitch('true', 'User-Id-1, Founder@Example.COM ,').users!]).toEqual(['User-Id-1', 'founder@example.com'])
  })

  it('lets an account in only while on, and then only one the allowlist names', () => {
    const founder = { sub: 'id-1', email: 'Founder@example.com' }
    const other = { sub: 'id-2', email: 'other@example.com' }
    expect(daemonsFor(DAEMONS_DARK, founder)).toBe(false)
    expect(daemonsFor(parseDaemonsSwitch('false', 'id-1'), founder)).toBe(false)
    expect(daemonsFor(parseDaemonsSwitch('true'), other)).toBe(true)
    expect(daemonsFor(parseDaemonsSwitch('true', 'id-1'), founder)).toBe(true)
    expect(daemonsFor(parseDaemonsSwitch('true', 'founder@EXAMPLE.com'), founder)).toBe(true)
    expect(daemonsFor(parseDaemonsSwitch('true', 'id-1'), other)).toBe(false)
    expect(daemonsFor(parseDaemonsSwitch('true', 'ID-1'), founder)).toBe(false)   // ids are exact
    expect(daemonsFor(parseDaemonsSwitch('true'), null)).toBe(false)
  })

  it('says what it does in the boot log without naming anyone', () => {
    expect(describeDaemonsSwitch(DAEMONS_DARK)).toBe('daemons: off (HARNESS_DAEMONS)')
    expect(describeDaemonsSwitch(parseDaemonsSwitch('true'))).toBe('daemons: on for everyone')
    expect(describeDaemonsSwitch(parseDaemonsSwitch('true', 'a@example.com'))).toBe('daemons: on for 1 allowlisted account')
  })
})
