/**
 * Claude Code's background commands: its Bash tool runs each command, foreground or background, as a direct child
 * `<shell> -c source '<config>/shell-snapshots/snapshot-….sh' … && eval '<command>' … && pwd -P >| …` (Claude Code
 * 2.1.322, macOS, zsh 5.9, recorded 2026-11-12). The trailing `pwd` keeps that shell alive for as long as the command
 * runs. Its other children (MCP servers, `caffeinate`) must read 0, or the cleanup would never close a Claude Code
 * harness. A pipeline's subshells carry the same argv one level down, so only direct children are passed in.
 */

import { programName, type ProcessRow } from '../../lib/processTable.js'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
// The program, then `-c` within its first three option words. Anchored, so the command itself is never tokenised.
const SHELL_DASH_C = /^(\S+)(?:\s+-\S+){0,2}?\s+-c\s/
const SNAPSHOT = '/shell-snapshots/snapshot-'

/** How many of an engine's direct children are the shells Claude Code's Bash tool runs. */
export function claudeBackgroundCommands(children: readonly Pick<ProcessRow, 'args'>[]): number {
  let count = 0
  for (const { args } of children) {
    const head = SHELL_DASH_C.exec(args)
    if (head && SHELLS.has(programName(head[1])) && args.includes(SNAPSHOT)) count++
  }
  return count
}
