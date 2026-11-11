/**
 * A Swarm agent's own folder, made when its start names a temporary one (task #3713). Scholes, 11-06: project computer's
 * agent Dee started in a Claude scratchpad, a folder under /private/tmp that Claude Code asks "Do you trust this folder?"
 * about on every run, in a terminal no Swarm view shows, so the agent waited on nobody. The core trusts only a Git checkout
 * or a Harness worktree (core/agents/create.ts `swarmFolder`), and a scratchpad is neither.
 *
 * The folder is Harness's, made for this start in its worktrees folder and marked as its,
 * and trusted alone: never a parent, the home folder or a folder a person made. It goes when its agent stops, once nothing
 * of the agent's work is left in it (machines.ts).
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { folderTrust } from '../engines/launchPrep.js'
import { launchEnvironment } from '../engines/kit/launchExecutable.js'
import { worktreeFolderName } from '../lib/agentNames.js'

/** The folder of agent folders, in Harness's worktrees folder. */
export const AGENT_FOLDERS = 'agent-home'
/** The file that says a folder is Harness's agent folder: only a marked one is ever removed. */
export const AGENT_FOLDER_MARK = '.harness-agent-folder'

const TEMPORARY_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders']

/** Whether [path] is inside a temporary folder, as written or with its links resolved; a temporary root itself is not. */
export function temporaryFolder(path: string, tmp: string = tmpdir()): boolean {
  if (!isAbsolute(path)) return false
  const roots = [...TEMPORARY_ROOTS, normalize(tmp)]
  const inside = (candidate: string) => roots.some((root) => candidate !== root && candidate.startsWith(`${root.replace(/[\\/]+$/, '')}${sep}`))
  let resolved = path
  try { resolved = realpathSync(path) } catch { /* not there yet: as written */ }
  return inside(normalize(path)) || inside(resolved)
}

/** The folder for [startId]'s agent: named for its start, never for anything a request names. */
export function agentFolderFor(root: string, startId: string): string {
  return join(root, 'worktrees', AGENT_FOLDERS, worktreeFolderName(`super-tab/${startId}`))
}

/**
 * Makes [folder] private and marked as Harness's, and answers Claude Code's folder question for it alone. Only a folder this
 * makes now, or one it made and marked for the same start before, is used: a link or an unmarked folder already there, or a
 * link in place of agent-home, is refused before anything is written, so neither a mark nor a trust lands elsewhere (security
 * review of #3341). Throws when it refuses; a failed trust write only leaves the question.
 */
export async function prepareAgentFolder(folder: string, engine: unknown, environment?: NodeJS.ProcessEnv): Promise<void> {
  const home = dirname(folder), worktrees = dirname(home)
  mkdirSync(worktrees, { recursive: true, mode: 0o700 })
  try { mkdirSync(home, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (!realDirectory(home) || realpathSync(home) !== join(realpathSync(worktrees), basename(home))) throw new Error('the agent-home folder is not Harness\'s own')
  let made = false
  try { mkdirSync(folder, { mode: 0o700 }); made = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (!realDirectory(folder) || realpathSync(folder) !== join(realpathSync(home), basename(folder))) throw new Error('the agent folder is not one Harness made')
  const mark = join(folder, AGENT_FOLDER_MARK)
  if (made) writeFileSync(mark, 'A Swarm agent\'s folder, made by Harness; removed when the agent stops and nothing of its work is left.\n', { flag: 'wx', mode: 0o600 })
  else if (!lstatSync(mark, { throwIfNoEntry: false })?.isFile()) throw new Error('the agent folder is not one Harness made')
  if (engine !== 'claude') return
  // The environment the launch reads its Claude home from (a CLAUDE_CONFIG_DIR its login shell sets).
  try { folderTrust('claude', undefined, environment ?? await launchEnvironment() ?? undefined)?.record(folder) }
  catch (error) { console.warn(`[super-tabs] could not answer the folder question for an agent: ${(error as Error).message}`) }
}

const realDirectory = (path: string): boolean => { const info = lstatSync(path, { throwIfNoEntry: false }); return !!info && info.isDirectory() && !info.isSymbolicLink() }

/** Whether [folder] holds nothing but Harness's mark: an agent folder whose work is all gone, which a stop may remove. */
export function agentFolderEmpty(folder: string): boolean {
  try { const names = readdirSync(folder); return names.length === 1 && names[0] === AGENT_FOLDER_MARK } catch { return false }
}

/** Whether [path] is an agent folder Harness may remove: a real folder (no link) directly in its agent-home folder, marked. */
export function removableAgentFolder(path: string, root: string): boolean {
  try {
    const home = realpathSync(join(root, 'worktrees', AGENT_FOLDERS))
    const here = realpathSync(path)
    return dirname(here) === home && lstatSync(path).isDirectory() && lstatSync(join(here, AGENT_FOLDER_MARK)).isFile()
  } catch { return false }
}
