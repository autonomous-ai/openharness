/** A launch golden may inspect only these private programs, never the machine's installed agents. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_CLI_COMMANDS } from '../lib/engineBin.js'
import { shellSingleQuote } from '../lib/shellQuote.js'

export function launchShapeExecutables(root: string): void {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const command of [...Object.values(ENGINE_CLI_COMMANDS).filter(Boolean), 'tmux']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nif [ "$1" = --version ]; then printf "2.0.0\\n"; else printf "%s\\n" "--no-daemon --approve-for-me --dangerously-skip-permissions --yolo --auto"; fi\n', { mode: 0o700 })
  }
  process.env.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`
  // A login zsh may reset PATH before its rc file. The selected fixture directory stays first.
  writeFileSync(join(root, 'zdotdir', '.zshrc'), `export PATH=${shellSingleQuote(process.env.PATH)}\n`)
}
