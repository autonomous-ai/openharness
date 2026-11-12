import { posix } from 'node:path'

/** A mount from `/proc/<pid>/mountinfo`: its ID and its parent's, its filesystem (`major:minor`), the folder of it
 *  mounted, and where. */
export interface Mount { id: string; parent: string; device: string; root: string; point: string }

// The kernel writes a space, tab, newline or backslash in a path as a three-digit octal escape.
const unescaped = (field: string): string => field.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))

/** The mounts `mountinfo` lists, in its order; a line without the ` - ` separator after its six fixed fields is skipped. */
export function parseMountinfo(text: string): Mount[] {
  const mounts: Mount[] = []
  for (const line of text.split('\n')) {
    const fields = line.split(' ')
    if (fields.indexOf('-', 6) < 0) continue
    mounts.push({ id: fields[0], parent: fields[1], device: fields[2], root: unescaped(fields[3]), point: unescaped(fields[4]) })
  }
  return mounts
}

const parts = (path: string): string[] => path.split('/').filter((part) => part !== '' && part !== '.')
const within = (ancestor: readonly string[], path: readonly string[]): boolean => ancestor.length <= path.length && ancestor.every((part, i) => part === path[i])

// The mount a path is on, found as the kernel walks it (proc(5), mountinfo's parent ID): from the root mount, into the
// first mount met on the way down, and at one point into the last mounted, which covers those before it. The deepest
// mount point over a path is not enough: a mount on a folder that a later mount over its parent covers is never met.
function holder(path: readonly string[], mounts: readonly Mount[]): Mount | undefined {
  const ids = new Set(mounts.map(mount => mount.id))
  let at = mounts.find(mount => parts(mount.point).length === 0 && (mount.parent === mount.id || !ids.has(mount.parent)))
  // Each step goes one mount down: more steps than mounts is a list whose parents loop.
  for (let steps = 0; at && steps < mounts.length; steps++) {
    let next: Mount | undefined
    let depth = Infinity
    for (const mount of mounts) {
      if (mount === at || mount.parent !== at.id) continue
      const point = parts(mount.point)
      if (point.length <= depth && within(point, path)) { next = mount; depth = point.length }
    }
    if (!next) return at
    at = next
  }
  return undefined
}

/**
 * `path` as a process with mounts `theirs` names it, in the view of mounts `ours`: the same file of the same
 * filesystem, reached through a mount of ours that nothing covers. `null` when ours do not show that file.
 */
export function hostPath(path: string, theirs: readonly Mount[], ours: readonly Mount[]): string | null {
  const asked = parts(path)
  if (!posix.isAbsolute(path) || asked.includes('..')) return null
  const theirMount = holder(asked, theirs)
  if (!theirMount) return null
  const inside = [...parts(theirMount.root), ...asked.slice(parts(theirMount.point).length)]
  const candidates = ours
    .map((mount, index) => ({ mount, index, root: parts(mount.root) }))
    .filter(({ mount, root }) => mount.device === theirMount.device && within(root, inside))
    .sort((a, b) => b.root.length - a.root.length || b.index - a.index)
  for (const { mount, root } of candidates) {
    const host = [...parts(mount.point), ...inside.slice(root.length)]
    if (holder(host, ours) === mount) return posix.join('/', ...host)
  }
  return null
}
