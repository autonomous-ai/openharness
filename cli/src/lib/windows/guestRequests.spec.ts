import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GUEST_REQUEST_MAX_BYTES, GuestRequestError, canonicalGuestEmail, guestAnswerFile, guestHomeFor, guestRequestFile, guestWorkspaceFor, newGuestRequestId, parseGuestSetupAnswer, parseGuestSetupRequest } from './guestRequests.js'
import { WINDOWS_GUEST_ROOT } from './guestTree.js'

const OWNER = 'C:\\Users\\owner'
const USER = `hg_${createHash('sha256').update('member@example.com').digest('hex').slice(0, 12)}`
const ID = 'a'.repeat(32)
const options = { ownerHome: OWNER }
const request = (value: Record<string, unknown>) => JSON.stringify({ id: ID, ...value })
const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    if (error instanceof GuestRequestError) return error.code
    throw error
  }
  throw new Error('expected a GuestRequestError')
}

describe('the guest setup root', () => {
  it('is the guests\' own tree, never the Team account\'s readable ProgramData folder', () => {
    expect(WINDOWS_GUEST_ROOT).toBe('C:\\ProgramData\\HarnessGuests')
    expect(WINDOWS_GUEST_ROOT).not.toContain('ProgramData\\Harness\\')
    expect(guestRequestFile(ID)).toBe(`${WINDOWS_GUEST_ROOT}\\requests\\${ID}.json`)
    expect(guestAnswerFile(ID)).toBe(`${WINDOWS_GUEST_ROOT}\\answers\\${ID}.json`)
  })

  it('derives the same account as macOS and the exact profile and workspace Windows must make', () => {
    expect(canonicalGuestEmail(' Member@Example.COM ')).toBe('member@example.com')
    expect(USER).toMatch(/^hg_[0-9a-f]{12}$/)
    expect(guestHomeFor(USER)).toBe(`C:\\Users\\${USER}`)
    expect(guestWorkspaceFor(USER)).toBe(`C:\\Users\\${USER}\\work`)
    expect(newGuestRequestId()).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('a setup request', () => {
  it('accepts ensure, remove, unshare and share, and derives a guest user for an email', () => {
    expect(parseGuestSetupRequest(request({ op: 'ensure', email: ' Member@Example.COM ' }), options))
      .toEqual({ id: ID, op: 'ensure', email: 'member@example.com', user: USER })
    expect(parseGuestSetupRequest(request({ op: 'remove', user: USER }), options)).toEqual({ id: ID, op: 'remove', user: USER })
    expect(parseGuestSetupRequest(request({ op: 'unshare', user: USER }), options)).toEqual({ id: ID, op: 'unshare', user: USER })
    expect(parseGuestSetupRequest(request({ op: 'share', user: USER, folders: [{ path: 'C:\\Users\\owner\\work', write: true }] }), options))
      .toEqual({ id: ID, op: 'share', user: USER, folders: [{ path: 'C:\\Users\\owner\\work', write: true }] })
    expect(parseGuestSetupRequest(request({ op: 'share', user: USER, folders: [] }), options))
      .toEqual({ id: ID, op: 'share', user: USER, folders: [] })
  })

  it('refuses an unknown key, a missing one, a bad id, op, email, user, path or level', () => {
    expect(code(() => parseGuestSetupRequest(request({ op: 'ensure', email: 'a@b.co', extra: 1 }), options))).toBe('INVALID_REQUEST')
    expect(code(() => parseGuestSetupRequest(JSON.stringify({ id: ID, op: 'ensure' }), options))).toBe('INVALID_REQUEST')
    expect(code(() => parseGuestSetupRequest(JSON.stringify({ id: 'A'.repeat(32), op: 'ensure', email: 'a@b.co' }), options))).toBe('INVALID_ID')
    expect(code(() => parseGuestSetupRequest(request({ op: 'root' }), options))).toBe('INVALID_REQUEST')
    for (const email of ['', 'a', 'a@', '@b.co', 'a b@c.co', 'a\u0000@b.co']) {
      expect(code(() => parseGuestSetupRequest(request({ op: 'ensure', email }), options)), email).toBe('INVALID_EMAIL')
    }
    expect(code(() => parseGuestSetupRequest(request({ op: 'remove', user: 'owner' }), options))).toBe('INVALID_USER')
    expect(code(() => parseGuestSetupRequest(request({ op: 'share', user: USER, folders: [{ path: 'C:\\Windows', write: false }] }), options))).toBe('INVALID_PATH')
    expect(code(() => parseGuestSetupRequest(request({ op: 'share', user: USER, folders: [{ path: 'C:\\work', write: 'yes' }] }), options))).toBe('INVALID_REQUEST')
    expect(code(() => parseGuestSetupRequest(request({ op: 'share', user: USER, folders: [{ path: 'C:\\Work\\A', write: false }, { path: 'c:\\work\\a', write: true }] }), options))).toBe('INVALID_REQUEST')
  })

  it('refuses bad JSON, a non-object, and a request over its size limit', () => {
    expect(code(() => parseGuestSetupRequest('{', options))).toBe('INVALID_JSON')
    expect(code(() => parseGuestSetupRequest('[]', options))).toBe('INVALID_REQUEST')
    expect(code(() => parseGuestSetupRequest('x'.repeat(GUEST_REQUEST_MAX_BYTES + 1), options))).toBe('TOO_LARGE')
  })
})

describe('the setup answer', () => {
  const ensure = parseGuestSetupRequest(request({ op: 'ensure', email: 'member@example.com' }), options)
  const answer = (value: Record<string, unknown>) => JSON.stringify({ id: ID, ...value })

  it('accepts the account and its exact profile, and a refusal with a bounded plain detail', () => {
    expect(parseGuestSetupAnswer(answer({ ok: true, user: USER, home: guestHomeFor(USER), workspace: guestWorkspaceFor(USER) }), ensure))
      .toEqual({ id: ID, ok: true, user: USER, home: guestHomeFor(USER), workspace: guestWorkspaceFor(USER) })
    expect(parseGuestSetupAnswer(answer({ ok: false, detail: 'Windows would not make the profile.' }), ensure))
      .toEqual({ id: ID, ok: false, detail: 'Windows would not make the profile.' })
    expect(parseGuestSetupAnswer(answer({ ok: true, user: USER, home: guestHomeFor(USER), workspace: guestWorkspaceFor(USER), detail: 'Windows keeps the profile until restart.' }), ensure))
      .toEqual({ id: ID, ok: true, user: USER, home: guestHomeFor(USER), workspace: guestWorkspaceFor(USER), detail: 'Windows keeps the profile until restart.' })
  })

  it('refuses another request, another guest, another profile, bad fields, and detail with a control character', () => {
    expect(code(() => parseGuestSetupAnswer(answer({ id: 'b'.repeat(32), ok: false, detail: 'x' }), ensure))).toBe('INVALID_ID')
    expect(code(() => parseGuestSetupAnswer(answer({ ok: true, user: 'hg_ffffffffffff', home: guestHomeFor('hg_ffffffffffff'), workspace: guestWorkspaceFor('hg_ffffffffffff') }), ensure))).toBe('INVALID_USER')
    expect(code(() => parseGuestSetupAnswer(answer({ ok: true, user: USER, home: 'D:\\x', workspace: guestWorkspaceFor(USER) }), ensure))).toBe('INVALID_PATH')
    expect(code(() => parseGuestSetupAnswer(answer({ ok: true, user: USER, home: guestHomeFor(USER), workspace: guestWorkspaceFor(USER), extra: 1 }), ensure))).toBe('INVALID_REQUEST')
    expect(code(() => parseGuestSetupAnswer(answer({ ok: false, detail: 'bad\u0007detail' }), ensure))).toBe('INVALID_REQUEST')
    expect(code(() => parseGuestSetupAnswer(answer({ ok: 'yes' }), ensure))).toBe('INVALID_REQUEST')
  })
})
