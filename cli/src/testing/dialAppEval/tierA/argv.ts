// A command the devices ran, as tier A reads it: the program it runs and the word after a flag. It imports nothing, so
// the world and its steps all read commands the same way.

/** A command's program, as its path or name ends. */
export const programOf = (argv: readonly string[]): string => (argv[0] ?? '').split(/[\\/]/).at(-1)!

/** The word after a flag, when the command has the flag. */
export function flagOf(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at < 0 ? undefined : argv[at + 1]
}
