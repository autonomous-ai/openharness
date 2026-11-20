/**
 * One watch on the nearest existing folder of a list, as the devices process waits for another program's socket or file
 * to appear. The list is the caller's, and each caller ends it as low as it can: a watch on a high folder is woken by
 * every write below it on macOS.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { pathToWatch } from '../../lib/pathToWatch.js'

/** Calls `changed` on each change in the nearest existing folder of `folders` (nearest first), moving to a nearer
 *  one as it appears and out of one that is removed. `file` is the name the OS gave for what changed in the folder
 *  held, none when it gave none. With none of them there it holds nothing and tells nothing. Never recursive. Returns
 *  its stop. Never throws: a watch that cannot be held tells nothing. */
export function watchNearest(folders: readonly string[], changed: (file?: string) => void): () => void {
  let held: { watcher: FSWatcher; at: number } | undefined
  const hold = () => {
    // inotify ends the watch of a folder that is removed, so a program that made it again would never be seen.
    if (held && !existsSync(folders[held.at])) {
      held.watcher.close()
      held = undefined
    }
    for (let at = 0; at < (held?.at ?? folders.length); at++) {
      // On Windows by its long name: by a short one, the first change would abort the process (lib/pathToWatch.ts).
      // The names told are of the entries in it, which its name does not change.
      const folder = pathToWatch(folders[at])
      if (folder === undefined) continue
      let watcher: FSWatcher
      try {
        watcher = watch(folder, { persistent: false }, (_event, file) => {
          hold()
          changed(file ?? undefined)
        })
      } catch {
        continue
      }
      // A watch that fails tells nothing more, and throws nothing into the devices process. Its folder gone, it moves out.
      watcher.on('error', () => {
        watcher.close()
        hold()
      })
      held?.watcher.close()
      held = { watcher, at }
      return
    }
  }
  hold()
  return () => {
    held?.watcher.close()
    held = undefined
  }
}
