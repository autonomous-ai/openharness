/**
 * The only thing the Windows guest setup task accepts (docs/superpowers/specs/2026-11-05-windows-guests-design.md,
 * "Setup: one UAC prompt"): one small JSON file naming one validated operation. The owner writes it; the SYSTEM task
 * reads it, does exactly that, writes one answer, and deletes it. Nothing on a command line, nothing a guest can write.
 *
 * The root is **not** under `C:\ProgramData\Harness`: that folder is readable by Users for the Team account (team.json,
 * its status and relay), and every guest is in Users. Keeping guests under it would let a guest read the owner's Team
 * subscription relay. `C:\ProgramData\HarnessGuests` is the guests' own tree: the owner and SYSTEM, the shared runtime
 * for guests to read, and nothing else.
 */
import { randomBytes } from 'node:crypto'
import { guestUserFor, isGuestUser } from '../guestAccounts.js'
import { GUEST_SHARE_MAX, checkGuestSharePath, type GuestSharedFolder } from './guestShare.js'

export const WINDOWS_GUEST_ROOT = 'C:\\ProgramData\\HarnessGuests'
export const WINDOWS_GUEST_REQUESTS = `${WINDOWS_GUEST_ROOT}\\requests`
export const WINDOWS_GUEST_ANSWERS = `${WINDOWS_GUEST_ROOT}\\answers`
export const WINDOWS_GUEST_RECORDS = `${WINDOWS_GUEST_ROOT}\\records`
export const WINDOWS_GUEST_SCRIPTS = `${WINDOWS_GUEST_ROOT}\\scripts`
export const WINDOWS_GUEST_RUNTIME = `${WINDOWS_GUEST_ROOT}\\runtime`
export const WINDOWS_GUEST_HOOK = `${WINDOWS_GUEST_ROOT}\\hook`

/** The macOS form's cap, and the same one the setup record enforces. */
export const GUEST_REQUEST_MAX_BYTES = 16_384
export const GUEST_ANSWER_DETAIL_MAX = 2_000

export const guestHomeFor = (user: string): string => `C:\\Users\\${user}`
export const guestWorkspaceFor = (user: string): string => `${guestHomeFor(user)}\\work`

export type GuestSetupOperation = 'ensure' | 'remove' | 'share' | 'unshare'

export interface GuestEnsureRequest {
  id: string
  op: 'ensure'
  email: string
  /** Derived from the email, the same name the macOS helper uses, so the platforms agree in tests. */
  user: string
}
export interface GuestAccountRequest { id: string; op: 'remove' | 'unshare'; user: string }
/** The owner's whole set, not one folder: the SYSTEM task changes only the difference from its record. */
export interface GuestShareRequest { id: string; op: 'share'; user: string; folders: GuestSharedFolder[] }
export type GuestSetupRequest = GuestEnsureRequest | GuestAccountRequest | GuestShareRequest

export type GuestRequestErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'TOO_LARGE'
  | 'INVALID_EMAIL'
  | 'INVALID_USER'
  | 'INVALID_PATH'
  | 'INVALID_ID'

export class GuestRequestError extends Error {
  constructor(readonly code: GuestRequestErrorCode, message: string) {
    super(message)
    this.name = 'GuestRequestError'
  }
}

const fail = (code: GuestRequestErrorCode, message: string): never => {
  throw new GuestRequestError(code, message)
}

const ID = /^[0-9a-f]{32}$/
/** One `@`, no spaces or controls, a local part of at most 64 and a domain of at most 253 characters. */
const EMAIL = /^[^\s@\u0000-\u001f]{1,64}@[^\s@\u0000-\u001f]{1,253}$/

/** A fresh request id: 128 random bits, the name nobody can guess and the SYSTEM task accepts once. */
export const newGuestRequestId = (): string => randomBytes(16).toString('hex')

export const guestRequestFile = (id: string): string => `${WINDOWS_GUEST_REQUESTS}\\${id}.json`
export const guestAnswerFile = (id: string): string => `${WINDOWS_GUEST_ANSWERS}\\${id}.json`

export function canonicalGuestEmail(email: string): string {
  const value = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (!EMAIL.test(value)) fail('INVALID_EMAIL', 'the email is not a plain address')
  return value
}

export interface ParseGuestRequestOptions {
  ownerHome: string
  fixedDrives?: ReadonlySet<string>
  isReparse?: (path: string) => boolean
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(value).sort()
  const want = [...allowed].sort()
  if (keys.length !== want.length || keys.some((key, i) => key !== want[i])) {
    fail('INVALID_REQUEST', `the request must name exactly ${allowed.join(', ')}`)
  }
}

/** Required keys and optional ones: no other key, every required one present. */
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    fail('INVALID_REQUEST', `the answer must name ${required.join(', ')}${optional.length ? ` (optionally ${optional.join(', ')})` : ''}`)
  }
}

function text(value: unknown, what: string, max = 400): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GuestRequestError('INVALID_REQUEST', `${what} must be plain text`)
  }
  return value
}

/**
 * One request from its JSON text. Every field is checked here and again by the SYSTEM script; an unknown key is a
 * refusal, not ignored, so a client that expects another operation to happen is told.
 */
export function parseGuestSetupRequest(source: string, options: ParseGuestRequestOptions): GuestSetupRequest {
  if (typeof source !== 'string') fail('INVALID_JSON', 'the request is not text')
  if (Buffer.byteLength(source, 'utf8') > GUEST_REQUEST_MAX_BYTES) fail('TOO_LARGE', 'the request is too large')
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    fail('INVALID_JSON', 'the request is not JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', 'the request must be an object')
  const request = value as Record<string, unknown>
  const id = typeof request.id === 'string' && ID.test(request.id) ? request.id : fail('INVALID_ID', 'the request id is not 128 random bits')
  const op = request.op
  if (op === 'ensure') {
    onlyKeys(request, ['id', 'op', 'email'])
    const email = canonicalGuestEmail(request.email as string)
    return { id, op, email, user: guestUserFor(email) }
  }
  if (op === 'remove' || op === 'unshare') {
    onlyKeys(request, ['id', 'op', 'user'])
    const user = text(request.user, 'user', 32)
    if (!isGuestUser(user)) fail('INVALID_USER', 'the user is not a guest account')
    return { id, op, user }
  }
  if (op === 'share') {
    onlyKeys(request, ['id', 'op', 'user', 'folders'])
    const user = text(request.user, 'user', 32)
    if (!isGuestUser(user)) fail('INVALID_USER', 'the user is not a guest account')
    if (!Array.isArray(request.folders) || request.folders.length > GUEST_SHARE_MAX) {
      return fail('INVALID_REQUEST', `folders must be an array of at most ${GUEST_SHARE_MAX}`)
    }
    const folders: GuestSharedFolder[] = []
    const seen = new Set<string>()
    for (const entry of request.folders) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('INVALID_REQUEST', 'each folder must be an object')
      const folder = entry as Record<string, unknown>
      onlyKeys(folder, ['path', 'write'])
      if (typeof folder.write !== 'boolean') return fail('INVALID_REQUEST', 'each folder needs write: true or false')
      const path = text(folder.path, 'path', 1_024)
      let checked: ReturnType<typeof checkGuestSharePath>
      try {
        checked = checkGuestSharePath(path, {
          ownerHome: options.ownerHome,
          ...(options.fixedDrives ? { fixedDrives: options.fixedDrives } : {}),
          ...(options.isReparse ? { isReparse: options.isReparse } : {}),
        })
      } catch (error) {
        throw new GuestRequestError('INVALID_PATH', error instanceof Error ? error.message : 'the folder cannot be shared')
      }
      const key = checked.path.toLowerCase()
      if (seen.has(key)) return fail('INVALID_REQUEST', `the folder ${checked.path} is named twice`)
      seen.add(key)
      folders.push({ path: checked.path, write: folder.write })
    }
    return { id, op, user, folders }
  }
  return fail('INVALID_REQUEST', 'op must be ensure, remove, share or unshare')
}

export type GuestSetupAnswer =
  | { id: string; ok: true; user: string; home: string; workspace: string; detail?: string }
  | { id: string; ok: false; detail: string }

function hasControl(text: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
}

/**
 * The SYSTEM task's answer. An answer names the request it answers, and on success the account and its real profile
 * (Windows may suffix a profile folder; the setup reads `Win32_UserProfile.LocalPath`, not a guess). The caller
 * compares the user with the one it asked for, so an answer swapped in from another request is refused.
 */
export function parseGuestSetupAnswer(source: string, expected: GuestSetupRequest): GuestSetupAnswer {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > GUEST_REQUEST_MAX_BYTES) {
    fail('INVALID_JSON', 'the answer is not a small text')
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    fail('INVALID_JSON', 'the answer is not JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', 'the answer must be an object')
  const answer = value as Record<string, unknown>
  if (answer.id !== expected.id) fail('INVALID_ID', 'the answer names another request')
  if (answer.ok === true) {
    keys(answer, ['id', 'ok', 'user', 'home', 'workspace'], ['detail'])
    const user = text(answer.user, 'user', 32)
    if (!isGuestUser(user)) fail('INVALID_USER', 'the answer names no guest account')
    if (user !== expected.user) fail('INVALID_USER', 'the answer names another guest account')
    const home = text(answer.home, 'home', 1_024)
    const workspace = text(answer.workspace, 'workspace', 1_024)
    const detail = answer.detail === undefined ? undefined : text(answer.detail, 'detail', GUEST_ANSWER_DETAIL_MAX)
    if (home !== guestHomeFor(user) || workspace !== guestWorkspaceFor(user)) {
      fail('INVALID_PATH', 'the answer\'s profile is not the guest\'s')
    }
    return { id: expected.id, ok: true, user, home, workspace, ...(detail ? { detail } : {}) }
  }
  if (answer.ok === false) {
    onlyKeys(answer, ['id', 'ok', 'detail'])
    const detail = typeof answer.detail === 'string' ? answer.detail.trim() : ''
    if (!detail || detail.length > GUEST_ANSWER_DETAIL_MAX || hasControl(detail)) {
      fail('INVALID_REQUEST', 'the answer has no usable detail')
    }
    return { id: expected.id, ok: false, detail }
  }
  return fail('INVALID_REQUEST', 'ok must be true or false')
}
