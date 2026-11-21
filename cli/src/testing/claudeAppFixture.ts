/**
 * A store of the Claude app's Code sessions for specs, so no spec reads the person's own
 * (`~/Library/Application Support/Claude/claude-code-sessions`). It lays the files out as the app does
 * (docs/plans/2026-11-19-dial-claude-app-sessions-design.md, "Why"): `<account>/<org>/local_<uuid>.json`, written to a
 * temp file and renamed over, and a deleted session's file swapped for a 13-byte `deleted_<uuid>`.
 */
import { mkdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { claudeStoreRoots } from '../cable/hosts/appPlaces.js'

/** The account and org folders a fixture writes to unless told another. */
export const ACCOUNT = '5c0e7a1d-2b3f-4c8e-9d6a-7f1b2c3d4e5f'
export const ORG = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'

export interface FixtureSession {
  localId: string; cliSessionId: string; cwd: string
  title?: unknown; lastActivityAt?: unknown; isArchived?: unknown
  /** Fields the reader must never keep; one set to `undefined` leaves that field out of the file. */
  more?: Record<string, unknown>
}
export interface FixturePlace { account?: string; org?: string; mtime?: number; bytes?: number }

/**
 * `path` as the file system names it: its nearest existing folder read through every link (and, on Windows, every short
 * name), the rest joined on, in lower case where the OS's folders ignore it. Two spellings of one place give one answer.
 */
function canonical(path: string): string {
  let folder = resolve(path)
  const below: string[] = []
  for (;;) {
    try {
      folder = realpathSync.native(folder)
      break
    } catch {
      // Missing (or unreadable): its parent is the nearest that may exist.
      const parent = dirname(folder)
      if (parent === folder) break
      below.unshift(basename(folder))
      folder = parent
    }
  }
  const named = join(folder, ...below)
  return process.platform === 'darwin' || process.platform === 'win32' ? named.toLowerCase() : named
}

/** Whether `place` is `folder` or inside it, however either is spelled: the one check of every fixture that must never
 *  write a real store. */
export function withinReal(folder: string, place: string): boolean {
  const inside = relative(canonical(folder), canonical(place))
  return inside.split(sep)[0] !== '..' && !isAbsolute(inside)
}

// The env as this module was loaded: tier A empties XDG_CONFIG_HOME, APPDATA and LOCALAPPDATA before it makes a fixture,
// which must not take the store those named off the refused list.
const LOADED_ENV = { ...process.env }

/** Every root the account's own store may have: from the env as loaded, the env now, and no env (the profile's
 *  defaults). The account's own home, from the user database: a test or a benchmark moves HOME, which homedir() follows. */
function realRoots(): string[] {
  const home = userInfo().homedir
  return [LOADED_ENV, process.env, {}].flatMap((env) => claudeStoreRoots(process.platform, env, home).map(({ root }) => root))
}

/** A store of the Claude app's in `root`, a folder the caller made: never a real one. */
export function claudeAppFixture(root: string): {
  readonly root: string
  /** That account's org folder, made when missing. */
  org(place?: FixturePlace): string
  /** Writes `<localId>.json` as the app does, a temp file renamed over it; padded to `bytes`, its mtime set to `mtime`.
   *  Its path. */
  write(session: FixtureSession, place?: FixturePlace): string
  /** Removes the file and leaves a 13-byte `deleted_<uuid>` in its place. */
  remove(localId: string, place?: FixturePlace): void
} {
  if (realRoots().some((real) => withinReal(real, root))) {
    throw new Error('the Claude app fixture never writes the real Claude app store')
  }
  const org = (place: FixturePlace = {}): string => {
    const folder = join(root, place.account ?? ACCOUNT, place.org ?? ORG)
    mkdirSync(folder, { recursive: true })
    return folder
  }
  return {
    root,
    org,
    write(session, place = {}) {
      const { localId, cliSessionId, cwd, title, lastActivityAt, isArchived, more } = session
      let body = Buffer.from(JSON.stringify({ sessionId: localId, cliSessionId, cwd, title, lastActivityAt, isArchived, ...more }))
      // JSON allows trailing white space, so the padded file is still the same session.
      if (place.bytes !== undefined) body = Buffer.concat([body, Buffer.alloc(place.bytes - body.length, ' ')])
      const path = join(org(place), `${localId}.json`)
      const temp = `${path}.tmp`
      writeFileSync(temp, body)
      if (place.mtime !== undefined) utimesSync(temp, place.mtime / 1000, place.mtime / 1000)
      renameSync(temp, path)
      return path
    },
    remove(localId, place = {}) {
      const folder = org(place)
      rmSync(join(folder, `${localId}.json`))
      // Only its size is known of the app's tombstone.
      writeFileSync(join(folder, `deleted_${localId.replace(/^local_/, '')}`), 'x'.repeat(13))
    },
  }
}
