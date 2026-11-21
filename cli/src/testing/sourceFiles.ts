import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every file under [root], as a path from it with `/` on every platform, but those in a folder whose name starts with a
 * dot. Specs that read the daemon's source list it here: engines/pluginPosts.spec.ts makes and removes scratch folders
 * in src/.tmp while they run, and one that went mid-walk failed the walk with ENOENT.
 */
export function sourceFiles(root: string): string[] {
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = dir ? `${dir}/${entry.name}` : entry.name
    return !entry.isDirectory() ? [file] : entry.name.startsWith('.') ? [] : walk(file)
  })
  return walk('')
}
