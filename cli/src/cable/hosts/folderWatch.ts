/**
 * One watch on the nearest existing folder of a list, as the devices process waits for another program's socket or file
 * to appear. The list is the caller's, and each caller ends it as low as it can: a watch on a high folder is woken by
 * every write below it on macOS.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { pathToWatch } from '../../lib/pathToWatch.js'

/** How long after a watch of the process starts or closes every watch held looks once more. On macOS every folder the
 *  process watches is in one FSEvents stream, which libuv builds anew on its own thread at each watch's start and close
 *  (src/unix/fsevents.c): fs.watch returns before the new stream starts, 0.08 to 4 s later on a loaded Mac
 *  (2026-11-21), and a socket or file made in between is told to no watch, the one starting or one held long before. */
const LIVE_MS = 5_000

/** The look of each watch held in the process. */
const looks = new Set<() => void>()
let looking: NodeJS.Timeout | undefined

/** A watch started or closed, and the stream is built anew: every watch held looks LIVE_MS after the last of them, once
 *  for a burst of starts and closes. Pushed by them, never polled: nothing waits while no watch is held. */
function rebuilt(): void {
  clearTimeout(looking)
  looking = looks.size === 0 ? undefined : setTimeout(() => {
    looking = undefined
    // A look's caller can stop another watch, which is then not looked at.
    for (const look of [...looks]) if (looks.has(look)) look()
  }, LIVE_MS).unref()
}

/** Calls `changed` on each change in the nearest existing folder of `folders` (nearest first), moving to a nearer
 *  one as it appears and out of one that is removed. `file` is the name the OS gave for what changed in the folder
 *  held, none when it gave none. LIVE_MS after any watch of the process starts or closes, a watch held looks: it moves
 *  as on a change, and tells one with no name, for what was made while the stream was not live. With none of them
 *  there it holds nothing and tells nothing. Never recursive. Returns its stop. Never throws: a watch that cannot be
 *  held tells nothing. */
export function watchNearest(folders: readonly string[], changed: (file?: string) => void): () => void {
  let held: { watcher: FSWatcher; at: number } | undefined
  // As a change told: a nearer folder made while the stream was not live is told by no change, so the look moves there.
  // A change told spares no look: it says the stream is live, not what was made before, which a caller that reads only
  // the entry a change names (claudeAppSource.ts) would never read.
  const look = () => {
    hold()
    changed()
  }
  /** A watch closed, after which this holds none live. */
  const close = (watcher: FSWatcher) => {
    watcher.close()
    if (looks.delete(look)) rebuilt()
  }
  const hold = () => {
    // inotify ends the watch of a folder that is removed, so a program that made it again would never be seen.
    if (held && !existsSync(folders[held.at])) {
      close(held.watcher)
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
      // A watch that fails tells nothing more, its look neither, and throws nothing into the devices process. Its folder
      // gone, it moves out, and the watch it starts there looks with the rest.
      watcher.on('error', () => {
        close(watcher)
        hold()
      })
      held?.watcher.close()
      held = { watcher, at }
      looks.add(look)
      rebuilt()
      return
    }
  }
  hold()
  return () => {
    if (held) close(held.watcher)
    held = undefined
  }
}
