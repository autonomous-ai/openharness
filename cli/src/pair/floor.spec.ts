/**
 * The floor (pair/floor.ts) on its own: how an option is read, which yes is one-time, and the order of the
 * refusals `answerFloor` gives — the dialog's own options first, then "more than this once", then only a
 * permission prompt, its decline always, its yes only when allow-class and never deny-class.
 */
import { describe, expect, it } from 'vitest'
import {
  answerFloor, AUTONOMY_LEVELS, bareOption, DEFAULT_AUTONOMY, isApproveOption, isAutonomy, isDeclineOption, isOneTimeYes,
  isPersistentOption, matchOption, untouchableDetail,
} from './floor.js'

describe('options', () => {
  it('reads an option without its number or its cursor', () => {
    expect(bareOption('  1. Yes')).toBe('Yes')
    expect(bareOption('2) No')).toBe('No')
    expect(bareOption('❯ Yes, proceed')).toBe('Yes, proceed')
    expect(bareOption('› Allow')).toBe('Allow')
    expect(bareOption('- Skip')).toBe('Skip')
    expect(bareOption('Yes 1.')).toBe('Yes 1.')
  })

  it('a yes and a no by their first word only', () => {
    for (const o of ['1. Yes', 'y', 'Allow once', 'Approve', 'Proceed (y)', 'OK', 'Okay', 'Run it', 'Confirm', 'continue']) expect(isApproveOption(o), o).toBe(true)
    for (const o of ['2. No', 'n', 'Deny', 'Reject', 'Decline', 'Cancel', "Don't run", 'Dont', 'Do not run', 'Skip', 'Abort', 'Stop']) expect(isDeclineOption(o), o).toBe(true)
    for (const o of ['Yesterday', 'Nope', 'Tell Claude what to do instead', 'Maybe', 'Not now', 'Allowance']) {
      expect(isApproveOption(o) || isDeclineOption(o), o).toBe(false)
    }
  })

  it('every persistent form, in any case', () => {
    for (const o of ["Yes, don't ask again", 'Yes, DO NOT ASK AGAIN', 'Always', 'Allow all', 'for this session', 'for the rest of the session',
      'Yes during this session', 'Remember my choice', 'every time', 'from now on', 'auto-accept edits', 'autoaccept', 'shift+tab', 'Yes (p)']) {
      expect(isPersistentOption(o), o).toBe(true)
      expect(isOneTimeYes(o), o).toBe(false)
    }
    for (const o of ['Yes (y)', 'Yes, proceed', 'Allow once', 'Alwaysy']) expect(isPersistentOption(o), o).toBe(false)
  })

  it('names the dialog\'s own option exactly, or without its number — never a blank or an unknown', () => {
    const options = ['1. Yes', '2.  Yes,  and  tell me', '3. No']
    expect(matchOption(options, '1. yes')).toBe('1. Yes')
    expect(matchOption(options, 'yes, and tell me')).toBe('2.  Yes,  and  tell me')
    expect(matchOption(options, '  ')).toBeNull()
    expect(matchOption(options, '')).toBeNull()
    expect(matchOption(options, '1')).toBeNull()
    expect(matchOption(options, 'Ye')).toBeNull()
    expect(matchOption([], 'Yes')).toBeNull()
  })
})

describe('answerFloor', () => {
  const q = { options: ['1. Yes', "2. Yes, and don't ask again", '3. No', '4. Tell Claude something'], deny: false, allow: true, permission: true }

  it('refuses in order: not offered, persistent, not a permission prompt', () => {
    expect(answerFloor({ ...q, permission: false }, 'Maybe')).toMatchObject({ error: 'NOT_OFFERED' })
    expect(answerFloor({ ...q, permission: false }, "Yes, and don't ask again")).toMatchObject({ error: 'PERSISTENT' })
    expect(answerFloor({ ...q, permission: false }, 'No')).toMatchObject({ error: 'NOT_ALLOW_CLASS' })
    expect(answerFloor({ ...q, permission: undefined }, 'No')).toMatchObject({ error: 'NOT_ALLOW_CLASS' })
  })

  it('a decline always; a one-time yes only on an allow-class, single-choice, non-deny prompt', () => {
    expect(answerFloor({ ...q, deny: true, allow: true }, '3. No')).toEqual({ ok: true, option: '3. No' })
    expect(answerFloor({ ...q, deny: true, allow: true }, 'Yes')).toMatchObject({ error: 'DENY_CLASS' })
    expect(answerFloor({ ...q, allow: undefined }, 'Yes')).toMatchObject({ error: 'NOT_ALLOW_CLASS' })
    expect(answerFloor({ ...q, multi: true }, 'Yes')).toMatchObject({ error: 'NOT_ALLOW_CLASS' })
    expect(answerFloor(q, 'Tell Claude something')).toMatchObject({ error: 'NOT_ALLOW_CLASS' })     // not a yes
    expect(answerFloor(q, 'yes')).toEqual({ ok: true, option: '1. Yes' })
  })
})

describe('the dial', () => {
  it('knows its levels and starts at watch', () => {
    expect(AUTONOMY_LEVELS).toEqual(['watch', 'suggest', 'act-on-key', 'act-within-rules'])
    expect(DEFAULT_AUTONOMY).toBe('watch')
    for (const level of AUTONOMY_LEVELS) expect(isAutonomy(level)).toBe(true)
    for (const value of ['bypass', 'WATCH', '', null, 1, undefined, ['watch']]) expect(isAutonomy(value)).toBe(false)
  })

  it('says why a harness is never driven', () => {
    expect(untouchableDetail('terminal')).toMatch(/shell, not an agent/)
    expect(untouchableDetail('pair')).toMatch(/own harness/)
  })
})
