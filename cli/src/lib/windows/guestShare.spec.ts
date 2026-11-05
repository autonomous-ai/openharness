import { describe, expect, it } from 'vitest'
import {
  GUEST_SHARE_MAX, GuestShareError, checkGuestSharePath, guestAclGrant, guestAclRemove, planGuestAcl,
} from './guestShare.js'

const OWNER = 'C:\\Users\\owner'
const USER = 'hg_0123456789ab'
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const share = (path: string, write = false) => ({ path, write })

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    if (error instanceof GuestShareError) return error.code
    throw error
  }
  throw new Error('expected a GuestShareError')
}

describe('a folder the owner may share', () => {
  it('accepts a plain folder, its parents, spaces and Unicode, and marks the owner profile', () => {
    const checked = checkGuestSharePath('C:\\Users\\owner\\My Projects\\Über', { ownerHome: OWNER })
    expect(checked).toEqual({
      path: 'C:\\Users\\owner\\My Projects\\Über',
      ownerProfile: true,
      ancestors: ['C:\\Users', 'C:\\Users\\owner', 'C:\\Users\\owner\\My Projects'],
    })
    expect(checkGuestSharePath('D:\\work\\repo', { ownerHome: OWNER }).ownerProfile).toBe(false)
  })

  it('refuses a root, a system folder, Harness\'s own ProgramData, and another user\'s profile', () => {
    for (const path of [
      'C:\\', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files\\App', 'C:\\Program Files (x86)\\App',
      'C:\\ProgramData', 'C:\\ProgramData\\Harness', 'C:\\ProgramData\\Harness\\Guests', 'C:\\ProgramData\\HarnessGuests',
      // The profile-holding folder itself would inherit an ACE into every profile; the guests' own tree is never shared.
      'C:\\Users', 'C:\\Users\\other\\work', 'C:\\Users\\Public',
      'C:\\$Recycle.Bin', 'C:\\System Volume Information', 'C:\\Recovery', 'C:\\Boot', 'C:\\PerfLogs',
    ]) {
      expect(code(() => checkGuestSharePath(path, { ownerHome: OWNER })), path).toBe('INVALID_PATH')
    }
  })

  it('refuses names Windows would change, alternate streams, UNC and relative paths', () => {
    for (const path of [
      'C:\\work\\..\\other', 'C:\\work\\a.', 'C:\\work\\a ', 'C:\\work\\CON', 'C:\\work\\lpt1.txt',
      'C:\\work\\a:b', 'C:\\work\\a?b', 'C:\\work\\a*b', 'C:\\work\\a<b', 'C:\\work\\a|b', 'C:\\work\\a"b',
      'C:/work', '\\\\server\\share', 'work', 'C:\\work\\\\x',
    ]) {
      expect(code(() => checkGuestSharePath(path, { ownerHome: OWNER })), path).toBe('INVALID_PATH')
    }
  })

  it('refuses a drive that is not a local fixed drive', () => {
    expect(code(() => checkGuestSharePath('Z:\\work', { ownerHome: OWNER, fixedDrives: new Set(['C:', 'D:']) }))).toBe('INVALID_PATH')
    expect(() => checkGuestSharePath('c:\\work', { ownerHome: OWNER, fixedDrives: new Set(['C:']) })).not.toThrow()
  })

  it('refuses a junction anywhere on the path, and the folder itself', () => {
    expect(code(() => checkGuestSharePath('C:\\Users\\owner\\link\\work', {
      ownerHome: OWNER, isReparse: (path) => path === 'C:\\Users\\owner\\link',
    }))).toBe('REPARSE')
    expect(code(() => checkGuestSharePath('C:\\Users\\owner\\work', {
      ownerHome: OWNER, isReparse: (path) => path === 'C:\\Users\\owner\\work',
    }))).toBe('REPARSE')
  })
})

describe('the ACLs', () => {
  it('gives a read folder RX (not R: a directory needs execute), an edit folder M, never F', () => {
    expect(guestAclGrant(USER, SID, 'C:\\work', 'read')).toEqual(['C:\\work', '/grant:r', `*${SID}:(OI)(CI)(RX)`, '/L', '/q'])
    expect(guestAclGrant(USER, SID, 'C:\\work', 'edit')).toEqual(['C:\\work', '/grant:r', `*${SID}:(OI)(CI)M`, '/L', '/q'])
    expect(guestAclGrant(USER, SID, 'C:\\work', 'traverse')).toEqual(['C:\\work', '/grant:r', `*${SID}:(X)`, '/L', '/q'])
    for (const level of ['read', 'edit', 'traverse'] as const) {
      const args = guestAclGrant(USER, SID, 'C:\\work', level)
      expect(args.join(' ')).not.toContain('(F)')
      expect(args).not.toContain('/T')
    }
  })

  it('removes only this guest, never recursively', () => {
    expect(guestAclRemove(USER, SID, 'C:\\work')).toEqual(['C:\\work', '/remove:g', `*${SID}`, '/L', '/q'])
    expect(guestAclRemove(USER, SID, 'C:\\work')).not.toContain('/T')
  })

  it('refuses a caller that is not a guest account, and a SID that is not one', () => {
    expect(code(() => guestAclGrant('owner', SID, 'C:\\work', 'read'))).toBe('NOT_A_GUEST')
    expect(code(() => guestAclGrant(USER, 'owner', 'C:\\work', 'read'))).toBe('INVALID_SID')
  })
})

describe('the difference between what a guest has and what the owner shares', () => {
  it('grants only the folder: Windows Bypass traverse checking needs no parent ACE', () => {
    const plan = planGuestAcl({
      ownerHome: OWNER, user: USER, sid: SID, current: [],
      next: [share('C:\\Users\\owner\\work\\project')],
    })
    expect(plan.grant.map((change) => [change.path, change.level])).toEqual([
      ['C:\\Users\\owner\\work\\project', 'read'],
    ])
    expect(plan.remove).toEqual([])
    expect(plan.record).toEqual([{ path: 'C:\\Users\\owner\\work\\project', level: 'read' }])
  })

  it('changes only the difference: the same folders cost nothing, read to edit is one grant', () => {
    const first = planGuestAcl({ ownerHome: OWNER, user: USER, sid: SID, current: [], next: [share('C:\\work\\a')] })
    const same = planGuestAcl({ ownerHome: OWNER, user: USER, sid: SID, current: first.record, next: [share('C:\\work\\a')] })
    expect(same.grant).toEqual([])
    expect(same.remove).toEqual([])
    const edit = planGuestAcl({ ownerHome: OWNER, user: USER, sid: SID, current: first.record, next: [share('C:\\work\\a', true)] })
    expect(edit.grant.map((change) => [change.path, change.level])).toEqual([['C:\\work\\a', 'edit']])
  })

  it('removes a folder the owner no longer shares, and nothing else', () => {
    const first = planGuestAcl({ ownerHome: OWNER, user: USER, sid: SID, current: [], next: [share('C:\\work\\a'), share('C:\\work\\b')] })
    const next = planGuestAcl({ ownerHome: OWNER, user: USER, sid: SID, current: first.record, next: [share('C:\\work\\b')] })
    expect(next.remove.map((change) => change.path)).toEqual(['C:\\work\\a'])
    expect(next.record.map((ace) => ace.path)).toEqual(['C:\\work\\b'])
  })

  it('keeps a shared parent at its share level even when it is also a parent of another share', () => {
    const plan = planGuestAcl({ ownerHome: OWNER, user: USER, sid: SID, current: [], next: [share('C:\\work', true), share('C:\\work\\child')] })
    expect(plan.record).toEqual([
      { path: 'C:\\work', level: 'edit' },
      { path: 'C:\\work\\child', level: 'read' },
    ])
  })

  it('refuses a path shared under two cases (Windows has one folder), and more than the cap', () => {
    expect(code(() => planGuestAcl({ ownerHome: OWNER, user: USER, sid: SID, current: [], next: [share('C:\\Work\\A'), share('c:\\work\\a')] }))).toBe('DUPLICATE')
    const many = Array.from({ length: GUEST_SHARE_MAX + 1 }, (_, i) => share(`C:\\work\\${i}`))
    expect(code(() => planGuestAcl({ ownerHome: OWNER, user: USER, sid: SID, current: [], next: many }))).toBe('TOO_MANY')
  })

  it('refuses a link in the next share, even when the record already names it', () => {
    expect(code(() => planGuestAcl({
      ownerHome: OWNER, user: USER, sid: SID,
      current: [{ path: 'C:\\Users\\owner\\link\\work', level: 'read' }],
      next: [share('C:\\Users\\owner\\link\\work')],
      isReparse: (path) => path === 'C:\\Users\\owner\\link',
    }))).toBe('REPARSE')
  })
})
