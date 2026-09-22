import { statSync } from 'node:fs'

export interface WorkspaceMissing { ok: false; error: 'CWD_NOT_FOUND'; detail: string }

/**
 * The refusal a relaunch gets when the row's working folder is gone.
 *
 * Every relaunch — resume, restart, retarget, a post-reboot restore — enters the row's `cwd` in the pane's
 * shell before exec'ing the engine (`buildEngineLaunchArgv`'s `cd -- "$1" || exit 1`). Discovering that
 * folder missing from inside the pane is the worst place to learn it: restart has already killed the
 * running process by then, and what the frame shows is a generic "did not come back up". Asked here, before
 * anything is signalled, it is a named refusal over an agent that is still running.
 *
 * `null` (no folder on record — a row written before create persisted one) is not a refusal: that row
 * launches without a `cd`, exactly as it has been.
 */
export function workspaceMissing(cwd: string | null | undefined): WorkspaceMissing | null {
  if (!cwd) return null
  try {
    if (statSync(cwd).isDirectory()) return null
  } catch { /* fall through */ }
  return { ok: false, error: 'CWD_NOT_FOUND', detail: 'The saved project folder is no longer available.' }
}
