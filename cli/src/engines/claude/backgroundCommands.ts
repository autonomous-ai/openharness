/**
 * Claude Code's background commands: its Bash tool runs each command, foreground or background, as a direct child
 * `<shell> -c source '<config>/shell-snapshots/snapshot-….sh' … && eval '<command>' … && pwd -P >| …` (Claude Code
 * 2.1.322, macOS, zsh 5.9, recorded 2026-11-12). The trailing `pwd` keeps that shell alive for as long as the command
 * runs. With its sandbox on, Linux runs `/bin/sh -c 'bwrap … -- <shell> -c <that command>'` instead: sh execs bwrap,
 * which stays the direct child while the shell runs below it, so a bwrap naming a snapshot counts as the shell would
 * (@anthropic-ai/sandbox-runtime 0.0.82). Its other children (MCP servers, `caffeinate`, the sandbox's socat bridges)
 * must read 0, or the cleanup would never close a Claude Code harness. A pipeline's subshells carry the same argv one
 * level down, so only direct children are passed in.
 */

import { programName, type ProcessRow } from '../../lib/processTable.js'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
// `-c` within the program's first three option words. Anchored, so the command itself is never tokenised.
const SHELL_DASH_C = /^\S+(?:\s+-\S+){0,2}?\s+-c\s/
const SNAPSHOT = '/shell-snapshots/snapshot-'

/** How many of an engine's direct children are the shells Claude Code's Bash tool runs, bare or under bwrap. */
export function claudeBackgroundCommands(children: readonly Pick<ProcessRow, 'args'>[]): number {
  let count = 0
  for (const { args } of children) {
    if (!args.includes(SNAPSHOT)) continue
    const program = programName(args.split(/\s/, 1)[0])
    if (program === 'bwrap' || (SHELLS.has(program) && SHELL_DASH_C.test(args))) count++
  }
  return count
}
