/**
 * Claude Code: `~/.claude/projects/<folder>/<id>.jsonl`. A transcript's first lines say who wrote it:
 * `entrypoint` `cli` (a terminal) or `claude-desktop` (the Claude app). `sdk-cli` is a program driving
 * Claude (Harness's own summaries among them), and a sub-agent's file lives in a folder of its own.
 *
 * A running Claude Code keeps `~/.claude/sessions/<pid>.json` naming its session and saying `idle`
 * between turns: the owner and its state, exactly.
 *
 * Declared in engines/claude/adoption.ts and read by the kit (engines/kit/adoption.ts); these are the names its
 * specs have always used. Core builds the provider from the declaration (engines/adoptions.ts), never from here.
 */
import { join } from 'node:path'

import { adoption } from '../../../engines/claude/adoption.js'
import { adoptionProvider, readAdoptedHead, type AdoptedHead } from '../../../engines/kit/adoption.js'
import type { ExternalProvider, UNSETTLED } from './types.js'

export type ClaudeHead = AdoptedHead

/**
 * A transcript's session, folder and entrypoint, from the first line that has them. UNSETTLED when no
 * such line is there yet in a file shorter than what is read: Claude may still be writing it.
 */
export function readClaudeHead(path: string, windows: readonly number[] = adoption.head.windows): Promise<ClaudeHead | null | typeof UNSETTLED> {
  return readAdoptedHead(path, { ...adoption.head, windows })
}

export function claudeProvider(options: { projectsDir: string; home: string; roots?: () => string[] }): ExternalProvider {
  const records = 'records' in adoption.owners ? adoption.owners.records.folder : 'sessions'
  return adoptionProvider('claude', adoption, {
    roots: options.roots ?? (() => [options.projectsDir]),
    ...(options.roots ? {} : { records: () => [join(options.home, records)] }),
  })
}
