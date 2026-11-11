import { missingHookScript } from './notifyHooks.js'

/**
 * What a launch held because [engine]'s hooks are not in place says: [waiting] while they may still be, the file and what
 * to do when a missing notify.mjs stopped their install (notifyHooks.ts missingHookScript). Waiting does not change that
 * (#3954), and a create, resume, relaunch, fork and external resume all say it the same way.
 */
export function hooksHeldDetail(engine: string, waiting: string): string {
  const missing = missingHookScript(engine)
  return missing ? `Harness’s hook script is missing (${missing}). Reinstall Harness, then start the agent again.` : waiting
}
