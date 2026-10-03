/**
 * One containment check for every RPC that reads or browses this machine's filesystem.
 *
 * The rule these all got wrong at least once: a path is only inside a folder if the FILE IT RESOLVES
 * TO is inside it. `resolve()` rewrites `..` and `./` as text and knows nothing about symlinks, so a
 * link sitting inside an allowed folder passes a string check while the read lands anywhere on disk.
 * Every caller therefore resolves its target with `realpath` FIRST and only then asks `within`.
 *
 * The roots differ per RPC because what they hand back differs — `mediaPreview` returns the bytes of
 * a file, `gitProject` and `projectPreview` return a repository's shape — so each names its own set
 * rather than sharing one global allowance.
 */
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { env } from '../config/env.js'

/**
 * Whether `path` IS `root` or sits below it. Both are compared as text, so both must already be real
 * paths — handing this a path straight from a client checks the name of a symlink, not its target.
 *
 * `relative()` rather than `startsWith`, because `/a/bc` starts with `/a/b` and is not inside it.
 */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))
}

/**
 * Whether the real path `target` is inside any of `roots`. Roots are resolved here, so a root given
 * as a symlink still matches the files under it.
 *
 * A root that cannot be resolved is dropped rather than compared, which makes an empty or entirely
 * unresolvable set refuse everything — the failure of this check is always a refusal, never an
 * allowance. `HARNESS_FS_BROWSE_UNRESTRICTED=1` is the same opt-out the folder browser has always had.
 */
export async function withinRoots(target: string, roots: readonly string[]): Promise<boolean> {
  if (env.HARNESS_FS_BROWSE_UNRESTRICTED === '1') return true
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => '')))
  return resolved.some((root) => root && within(root, target))
}

/**
 * `withinRoots` for the one caller that must stay synchronous: the folder browser is `readdirSync`
 * and `statSync` throughout (lib/fsBrowse.ts), and one more syscall on that thread costs nothing.
 */
export function withinRootsSync(target: string, roots: readonly string[]): boolean {
  if (env.HARNESS_FS_BROWSE_UNRESTRICTED === '1') return true
  return roots.some((root) => {
    try { return within(realpathSync(root), target) } catch { return false }
  })
}

/**
 * Where agents drop the files they make. macOS gives each user a private `/var/folders/…` as
 * `tmpdir()`, but an agent told to "save it to /tmp" writes to `/tmp` itself, so both are roots.
 */
export function tempRoots(): string[] {
  return [tmpdir(), '/tmp']
}
