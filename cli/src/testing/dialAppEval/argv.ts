// A command the devices ran, as the eval reads it: the program it runs and the word after a flag. It imports nothing,
// so the checks, tier A's world and its steps all read commands the same way.

/** A command's program, as its path or name ends, without `.exe`: Windows' programs are named as the others are. */
export const programOf = (argv: readonly string[]): string => (argv[0] ?? '').split(/[\\/]/).at(-1)!.replace(/\.exe$/, '')

/** Orca's CLI by the names programOf gives each platform's (devices/orcaHomes.ts orcaBinary): its launcher on macOS,
 *  the .deb's and the AppImage's `orca-ide` on Linux, `orca.exe` on Windows. */
export const ORCA_PROGRAMS: readonly string[] = ['orca', 'orca-ide']

/** The word after a flag, when the command has the flag. */
export function flagOf(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at < 0 ? undefined : argv[at + 1]
}
