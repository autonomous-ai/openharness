/**
 * Cursor's folder window (docs/plans/2026-11-18-dial-cursor-design.md, §2): a tap on an agent in Cursor that no terminal
 * or tab reaches, Cursor's own agent always, runs `open -b com.todesktop.230313mzl4w4u92 <folder>`, so the window
 * already open on the agent's folder comes forward, else Cursor opens one. The pane is the folder, not the agent's chat:
 * Cursor documents no link to one. A multi-root window (`.code-workspace`) is opened by its first root, the folder its
 * hook names, so a tap may open a second window on that folder instead of raising the workspace's. `open -b` is
 * macOS's, so elsewhere nothing runs.
 *
 * The folder came from a hook and becomes a command's argument: its form is checked at `paneOf` and again before
 * `open`, which takes it as one argument with no shell, and it must be a folder at each look and again at the tap. It is
 * the person's own path, so the adapter takes no `log` and writes no line: an error it catches, whose message may name
 * the folder, goes nowhere, and a tap's outcome is the opener's line, by the adapter's id alone (open.ts).
 */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { openPath } from './open.js'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

/** The longest folder path a tap opens: Linux's PATH_MAX, above macOS's 1024. */
export const CURSOR_FOLDER_MAX = 4096
// No `g` flag: a test keeps no position between paths.
const CONTROL = /[\u0000-\u001f\u007f]/

export interface CursorFolderDeps {
  run: OrcaDeps['run']
  platform: NodeJS.Platform
  /** The raw `HARNESS_OPEN_BIN` (open.ts openPath). */
  bin?: string
  /** Whether the path is a folder now. */
  isFolder(path: string): boolean
}

/** `statSync(path).isDirectory()`; false for a file, a path that is not there, or any error. */
export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const inForm = (path: string | undefined): path is string =>
  !!path && path.length <= CURSOR_FOLDER_MAX && isAbsolute(path) && !CONTROL.test(path)

export function createCursorFolderAdapter(deps: CursorFolderDeps): HostAdapter {
  const mac = deps.platform === 'darwin'
  const openBin = openPath(deps.bin)
  // A check that throws answers that no folder is there: its error may name the folder.
  const there = (path: string): boolean => {
    try {
      return deps.isFolder(path)
    } catch {
      return false
    }
  }
  const canFocus = (pane: Pane): boolean => mac && inForm(pane.id) && there(pane.id)

  return {
    id: 'cursor-folder',
    tap: 'instead',
    // A session the scan found has no bundle of its own until its first hook: a tap on one with no reachable terminal
    // still brings Cursor, by this one (observed.ts target()).
    bundle: APP_BUNDLES.cursor,
    paneOf(place: Place): Pane | undefined {
      // The app decides, never a hint; any engine: whatever agent in Cursor no other pane reaches falls to its folder.
      return place.app === 'cursor' && inForm(place.cwd) ? { adapter: 'cursor-folder', id: place.cwd } : undefined
    },
    canFocus,
    async focus(pane) {
      // Asked again: the folder may have gone, or become a file, since the look.
      if (!canFocus(pane)) return false
      try {
        return (await deps.run(openBin, ['-b', APP_BUNDLES.cursor, pane.id], RUN_TIMEOUT_MS)).code === 0
      } catch {
        return false
      }
    },
  }
}
