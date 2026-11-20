/**
 * The login entry install.sh leaves on Linux (write_login_entry): `<config>/autostart/harnessd.desktop`, which runs
 * `harness start` at each login. Uninstall takes it only when it is still the installer's own, by the same test the
 * installer uses (login_entry_own: the first Exec= line, exactly): a file another app put at that path (the Linux Device
 * app's) is not Harness's to remove. Its own entry turned off goes too: what it would start is going.
 */
import { posix } from 'node:path'

export interface LoginEntryDeps {
  platform: NodeJS.Platform
  home: string
  /** $XDG_CONFIG_HOME as the environment has it. */
  configHome?: string
  /** The `harness` launcher the installer wrote the entry for. */
  launcher: string
  /** The file's text, or null when it cannot be read (none there). */
  read(path: string): string | null
  remove(path: string): void
}

/** install.sh login_entry_exec: `"<launcher>" start`, quoted as the Desktop Entry spec quotes an argument inside a value
 *  read as a string, so a backslash is doubled twice, `"`, a backtick and `$` take an escaped backslash, `%` is doubled. */
export function loginEntryExec(launcher: string): string {
  return `"${launcher.replace(/\\/g, '\\\\\\\\').replace(/["`$]/g, '\\\\$&').replace(/%/g, '%%')}" start`
}

/** The entry's path when it was removed; the path and why when it could not be; null when there was none of Harness's. */
export function removeLoginEntry(deps: LoginEntryDeps): string | { path: string; failed: string } | null {
  if (deps.platform !== 'linux') return null
  // install.sh login_entry_file: $XDG_CONFIG_HOME only when absolute, as the XDG spec says.
  const config = deps.configHome?.startsWith('/') ? deps.configHome : posix.join(deps.home, '.config')
  const path = posix.join(config, 'autostart', 'harnessd.desktop')
  const exec = deps.read(path)?.split('\n').find((line) => line.startsWith('Exec='))
  if (exec !== `Exec=${loginEntryExec(deps.launcher)}`) return null
  try {
    deps.remove(path)
    return path
  } catch (error) {
    return { path, failed: error instanceof Error ? error.message : String(error) }
  }
}
