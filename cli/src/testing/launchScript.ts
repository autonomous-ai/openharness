import { readFileSync } from 'node:fs'

/**
 * The script an engine launch hands its pane's shell, as the shell will read it: from the one-time file
 * a POSIX login shell sources (`. '<file>'`, engineLaunch.ts `sourcedOnce`), without the line that
 * removes the file, or the `-c` script itself when it went on the command line.
 */
export function launchScriptOf(argv: readonly string[]): string {
  for (const arg of argv) {
    const quoted = /^\. '(.+)'$/s.exec(arg)?.[1]
    if (quoted) return readFileSync(quoted.replace(/'"'"'/g, "'"), 'utf8').replace(/^rm -f -- '[^\n]*'\n/, '')
  }
  const flag = argv.findIndex((arg) => arg === '-lic' || arg === '-ic' || arg === '-c')
  return argv[flag + 1] ?? ''
}
