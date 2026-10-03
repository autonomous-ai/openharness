import { join } from 'node:path'
import { env } from '../../config/env.js'

/** Cursor's hooks and chat databases follow its config root, which can differ from its data root. */
export function cursorConfigDir(vars: NodeJS.ProcessEnv = process.env): string {
  return vars.CURSOR_CONFIG_DIR?.trim()
    || (vars.XDG_CONFIG_HOME?.trim() ? join(vars.XDG_CONFIG_HOME.trim(), 'cursor') : env.CURSOR_HOME)
}

/** Agent transcripts live under projects in Cursor's data root. */
export function cursorDataDir(vars: NodeJS.ProcessEnv = process.env): string {
  return vars.CURSOR_DATA_DIR?.trim() || env.CURSOR_HOME
}
