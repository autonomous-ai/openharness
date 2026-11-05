/**
 * Windows shared folders for guests (docs/superpowers/specs/2026-11-05-windows-guests-design.md, "Shared folders").
 *
 * Pure description of what the elevated setup script has to do, so the hard parts are tested without a Windows PC:
 * the path checks (a root, another profile, a reparse point), the ACL shape (read is RX, edit is M, never F; `/grant:r`
 * replaces only our ACE, no `/T`), the traverse-only parents, and the difference between what a guest has and what the
 * owner now shares. The PowerShell side calls the same plan; it never builds these strings from user text.
 *
 * A shared folder is the owner's choice, not a trust boundary: a guest with edit can put files there, including a
 * junction. The setup script refuses reparse points on every component, and [isReparse] lets the caller refuse a path
 * whose real components are links before it is recorded.
 */
import { win32 } from 'node:path'
import { isGuestUser } from '../guestAccounts.js'
import { checkSid } from '../../team/windowsLayout.js'

/** The macOS form's cap: a guest sees at most this many folders. */
export const GUEST_SHARE_MAX = 20
/** MAX_PATH less its NUL, as every Windows API without the `\\?\` prefix takes it. */
export const GUEST_SHARE_MAX_PATH = 259

export type GuestShareLevel = 'read' | 'edit'
/** A shared folder's own ACE, or the search-only ACE every parent between it and the drive needs. */
export type GuestAceLevel = GuestShareLevel | 'traverse'

export interface GuestSharedFolder { path: string; write: boolean }
export interface GuestAce { path: string; level: GuestAceLevel }

export interface CheckedGuestShare {
  path: string
  /** The path is inside the owner's profile. Windows denies can beat our allow, so the setup checks it as a guest. */
  ownerProfile: boolean
  /** Every parent from the drive root down to the folder's, the ones that may need traverse-only. */
  ancestors: string[]
}

export type GuestShareErrorCode =
  | 'INVALID_PATH' // not a plain absolute local path, or a root/system/another profile
  | 'TOO_MANY' // more than GUEST_SHARE_MAX after duplicates are folded
  | 'DUPLICATE' // the same folder twice
  | 'REPARSE' // a component is a junction or another reparse point
  | 'NOT_A_GUEST' // not an `hg_<12 hex>` account
  | 'INVALID_SID'

export class GuestShareError extends Error {
  constructor(readonly code: GuestShareErrorCode, message: string) {
    super(message)
    this.name = 'GuestShareError'
  }
}

export interface GuestSharePathOptions {
  /** The owner's profile, `C:\Users\<owner>`; a path under `C:\Users` is only theirs or refused. */
  ownerHome: string
  /** Local fixed drives the owner may share from (drive letters, case-insensitive). Omitted accepts every letter. */
  fixedDrives?: ReadonlySet<string>
  /** Whether an existing path is a junction or another reparse point. The setup script checks the real ones. */
  isReparse?: (path: string) => boolean
}

const WINDOWS_ROOT = /^[A-Za-z]:\\/
const INVALID_SEGMENT = /[<>:"|?*\u0000-\u001f]/
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const TRAILING = /[. ]$/

const SYSTEM_ROOTS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
  'C:\\Recovery',
  'C:\\Boot',
  'C:\\PerfLogs',
]
const SYSTEM_NAMES = new Set(['public', 'default', 'default user', 'all users'])

const lower = (path: string): string => path.toLowerCase()
export const sameWindowsPath = (a: string, b: string): boolean => lower(win32.normalize(a)) === lower(win32.normalize(b))
const within = (path: string, root: string): boolean => {
  const p = lower(win32.normalize(path))
  const r = lower(win32.normalize(root)).replace(/\\+$/, '')
  return p === r || p.startsWith(`${r}\\`)
}

function fail(code: GuestShareErrorCode, message: string): never {
  throw new GuestShareError(code, message)
}

/** The owner's account name from their profile path (`C:\Users\owner`). */
function ownerName(ownerHome: string): string {
  try {
    checkWindowsProfile(ownerHome)
  } catch {
    fail('INVALID_PATH', `the owner's profile is not a plain Windows path: ${JSON.stringify(ownerHome)}`)
  }
  return win32.basename(ownerHome)
}

/** A plain absolute drive path: no UNC, no `/`, no `..`, no segment Windows would rename or reserve. */
function checkWindowsProfile(path: string): string {
  if (typeof path !== 'string' || path.length > GUEST_SHARE_MAX_PATH || !WINDOWS_ROOT.test(path)
    || win32.normalize(path) !== path) {
    fail('INVALID_PATH', `not a plain absolute Windows path: ${JSON.stringify(path)}`)
  }
  const segments = path.slice(3).split('\\')
  if (path.length === 3 || segments.some((segment) => segment === '' || segment === '.' || segment === '..'
    || INVALID_SEGMENT.test(segment) || TRAILING.test(segment) || RESERVED.test(segment))) {
    fail('INVALID_PATH', `not a plain absolute Windows path: ${JSON.stringify(path)}`)
  }
  return path
}

function ancestorsOf(path: string): string[] {
  const parts = path.slice(3).split('\\')
  const parents: string[] = []
  for (let i = 1; i < parts.length; i++) parents.push(`${path.slice(0, 2)}\\${parts.slice(0, i).join('\\')}`)
  return parents
}

/**
 * Checks one folder the owner wants to share, or why it cannot be: a root, a system folder, another user's profile,
 * a name Windows would change, or a link. The owner's own profile is allowed but marked: its deny ACEs may still beat
 * the guest's allow, which only the setup's real check can tell.
 */
export function checkGuestSharePath(path: string, options: GuestSharePathOptions): CheckedGuestShare {
  const owner = ownerName(options.ownerHome)
  checkWindowsProfile(path)
  const drive = path.slice(0, 2).toUpperCase()
  if (options.fixedDrives && !options.fixedDrives.has(drive) && !options.fixedDrives.has(drive.toLowerCase())) {
    fail('INVALID_PATH', `the drive ${drive} is not a local fixed drive`)
  }
  if (path.length === 3) fail('INVALID_PATH', 'a drive root cannot be shared')
  for (const root of SYSTEM_ROOTS) if (within(path, root)) fail('INVALID_PATH', `${root} cannot be shared`)

  const relative = path.slice(3).split('\\')
  // The folder that holds every profile: an ACE there would be inherited by profiles no guest may enter.
  if (relative.length === 1 && lower(relative[0]!) === 'users') fail('INVALID_PATH', 'the folder that holds every profile cannot be shared')
  if (lower(relative[0]!) === 'users' && relative.length >= 2) {
    const profile = relative[1]!
    if (lower(profile) !== lower(owner)) {
      fail('INVALID_PATH', 'another user\'s profile cannot be shared')
    }
    if (SYSTEM_NAMES.has(lower(profile))) fail('INVALID_PATH', 'a Windows profile folder cannot be shared')
  }

  const ancestors = ancestorsOf(path)
  if (options.isReparse) {
    for (const one of [...ancestors, path]) {
      if (options.isReparse(one)) fail('REPARSE', `${one} is a junction or another reparse point`)
    }
  }
  return { path, ownerProfile: within(path, options.ownerHome), ancestors }
}

/** The ACE a shared folder gets: read is RX (not R: a directory needs execute to be entered), edit is M, never F. */
export function guestShareAce(level: GuestShareLevel): string {
  return level === 'read' ? '(OI)(CI)(RX)' : '(OI)(CI)M'
}

/** A parent's ACE: search only, no listing. On a folder that is shared too, the share ACE is used instead. */
export function guestTraverseAce(): string {
  return '(X)'
}

export function guestAceFor(level: GuestAceLevel): string {
  return level === 'traverse' ? guestTraverseAce() : guestShareAce(level)
}

function checkGuest(user: string): string {
  if (!isGuestUser(user)) fail('NOT_A_GUEST', `not a guest account: ${JSON.stringify(user)}`)
  return user
}

function checkGuestSid(sid: string): string {
  try {
    return checkSid(sid, 'guest account')
  } catch {
    fail('INVALID_SID', `the guest account is not a SID: ${JSON.stringify(sid)}`)
  }
}

/** `icacls` arguments for one desired ACE (`/grant:r`: our entry, not a second one; `/L`: the path itself, never a link). */
export function guestAclGrant(user: string, sid: string, path: string, level: GuestAceLevel): string[] {
  checkGuest(user)
  checkGuestSid(sid)
  return [path, '/grant:r', `*${sid}:${guestAceFor(level)}`, '/L', '/q']
}

/** `icacls` arguments that remove only the guest's entries from [path]. */
export function guestAclRemove(user: string, sid: string, path: string): string[] {
  checkGuest(user)
  checkGuestSid(sid)
  return [path, '/remove:g', `*${sid}`, '/L', '/q']
}

export interface GuestAclPlanInput {
  ownerHome: string
  user: string
  sid: string
  /** What the setup record says the guest has now. */
  current: readonly GuestAce[]
  /** The folders the owner shares now, as the form sends them. */
  next: readonly GuestSharedFolder[]
  fixedDrives?: ReadonlySet<string>
  isReparse?: (path: string) => boolean
}

export interface GuestAclChange { path: string; level: GuestAceLevel; args: string[] }
export interface GuestAclPlan {
  grant: GuestAclChange[]
  remove: GuestAclChange[]
  /** What to keep as the setup record once every command has succeeded. */
  record: GuestAce[]
}

/**
 * What changes between the guest's recorded ACEs and the owner's current folders: shared folders get read/edit, every
 * parent up to the drive gets traverse-only, a path no longer needed loses the guest's entries, and a path shared and
 * a parent of another keeps its share ACE. A folder the owner still shares is never weakened to traverse.
 */
export function planGuestAcl(input: GuestAclPlanInput): GuestAclPlan {
  const desired = new Map<string, GuestAce>()
  const shares: Array<{ path: string; level: GuestShareLevel }> = []
  const seen = new Set<string>()
  for (const folder of input.next) {
    const checked = checkGuestSharePath(folder.path, {
      ownerHome: input.ownerHome,
      ...(input.fixedDrives ? { fixedDrives: input.fixedDrives } : {}),
      ...(input.isReparse ? { isReparse: input.isReparse } : {}),
    })
    const key = lower(checked.path)
    if (seen.has(key)) fail('DUPLICATE', `the folder ${checked.path} is shared twice`)
    seen.add(key)
    shares.push({ path: checked.path, level: folder.write ? 'edit' : 'read' })
  }
  if (shares.length > GUEST_SHARE_MAX) fail('TOO_MANY', `at most ${GUEST_SHARE_MAX} folders can be shared`)
  // Windows gives every account "Bypass traverse checking" (SeChangeNotifyPrivilege), so a guest opens a shared
  // folder by its full path without an ACE on any parent. No parent is touched: that keeps the owner's profile
  // untouched, and it avoids the hang a DACL write on C:\Users\<owner> caused on the real PC (2026-11-05).
  for (const share of shares) desired.set(lower(share.path), share)

  const before = new Map<string, GuestAce>()
  for (const ace of input.current) before.set(lower(ace.path), ace)
  const grant: GuestAclChange[] = []
  for (const [key, ace] of desired) {
    const had = before.get(key)
    if (had?.level === ace.level) continue
    grant.push({ path: ace.path, level: ace.level, args: guestAclGrant(input.user, input.sid, ace.path, ace.level) })
  }
  const remove: GuestAclChange[] = []
  for (const [key, ace] of before) {
    if (desired.has(key)) continue
    remove.push({ path: ace.path, level: ace.level, args: guestAclRemove(input.user, input.sid, ace.path) })
  }
  const record = [...desired.values()].map((ace) => ({ path: ace.path, level: ace.level }))
  return { grant, remove, record }
}
