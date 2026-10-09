/**
 * Codex: every local session is a rollout under `~/.codex/sessions/YYYY/MM/DD/` (or
 * `archived_sessions/`). Its first line (`session_meta`) says who wrote it: `source` `cli` (a
 * terminal) or `vscode` (the Codex app, whose `originator` is "Codex Desktop", and the editor
 * extensions). `exec` is a script and a `subagent` source is another thread's helper. Thread names
 * are in `session_index.jsonl`.
 *
 * Codex keeps no process record, but holds its rollout open while it runs, so `lsof` names the
 * owner; the rollout's last turn event says whether a turn is running.
 *
 * Declared in engines/codex/adoption.ts and read by the kit (engines/kit/adoption.ts); these are the names its
 * specs have always used. Core builds the provider from the declaration (engines/adoptions.ts), never from here.
 */
import { adoption } from '../../../engines/codex/adoption.js'
import { adoptedTitles, adoptionProvider, readAdoptedHead, servesOthers, turnOpen, walkFiles, type AdoptedHead } from '../../../engines/kit/adoption.js'
import type { ExternalProvider, RunningProcess, ScanContext, UNSETTLED } from './types.js'

export type CodexHead = AdoptedHead

const files = adoption.files.layout === 'walk' ? adoption.files : null
const open = 'open' in adoption.owners ? adoption.owners.open : null
const tail = 'tail' in adoption.busy ? adoption.busy.tail : null

/**
 * A rollout's session, folder and source, from its first line. UNSETTLED while that line has no end
 * yet in a file shorter than what is read: Codex is still writing it.
 */
export function readCodexHead(path: string): Promise<CodexHead | null | typeof UNSETTLED> {
  return readAdoptedHead(path, adoption.head)
}

/** Thread names: `session_index.jsonl`, one `{id, thread_name}` a line, the last one winning. */
export function codexTitles(path: string, ctx: ScanContext): Promise<Map<string, string>> {
  return adoptedTitles('codex', path, adoption.titles!, ctx)
}

/** Every rollout file under a sessions folder (`YYYY/MM/DD/rollout-*.jsonl`), at any depth up to 4. */
export function rollouts(dir: string): Promise<string[]> {
  return walkFiles(dir, files!)
}

/** Whether a Codex process serves other clients rather than a person's terminal. */
export function codexServer(row: RunningProcess | undefined): boolean {
  return servesOthers(row, open!.servers)
}

/**
 * Whether a rollout's last turn is still running: the last `task_started`, `task_complete` or
 * `turn_aborted` event near its end says. What was said can name the events; only events count.
 * A file that cannot say counts as busy.
 */
export function codexTurnOpen(path: string, unknown: boolean | null = true): Promise<boolean | null> {
  return turnOpen(path, tail!, unknown)
}

export function codexProvider(options: { home: string; roots?: () => string[] }): ExternalProvider {
  return adoptionProvider('codex', adoption, { roots: options.roots ?? (() => [options.home]) })
}
