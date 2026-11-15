/** Discoverable tool access, without copying credentials or model settings into projects. */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ApiConnectionMetadata } from './apiConnectionMetadata.js'
import { projectsRoot } from './projectFolder.js'
import { instructionFileOf } from '../engines/launches.js'
import { HARNESS_ADAPTERS } from '../dsh/adapters.js'

const marker = '<!-- harness:apis -->'
export const API_INSTRUCTIONS = `${marker}
## Saved APIs

The user can save API connections in Harness → Models → APIs on this computer.
Run \`harness api list --json\` to discover the current connections; the list contains no keys.
Use \`harness api request <id> <path> --method POST --data @request.json\` for JSON APIs,
or \`harness api run <id> -- <command> [args]\` for a provider SDK/tool. The latter supplies
the connection's documented key variable and HARNESS_API_BASE_URL to that tool only.
Use these APIs when needed for the user's task. Never print, paste, or save API keys in a project.
Adding an API does not change this harness's model or subscription.
`

/** Only a project folder Harness made ([root] is where it makes them), and only while APIs are saved. Existing
 * instructions are kept; no global agent settings or credentials are written into the project. A folder the person
 * chose is theirs, and the note is never written there: until 15 November any folder a harness started in got it, the
 * person's own repository included (core audit, security 9). */
export function prepareApiInstructions(store: Pick<ApiConnectionMetadata, 'list'>, workspace: string, engine: string,
  root: string = projectsRoot()): void {
  // An engine that reads no instruction file in its folder (OpenClaw reads its own workspace's) gets none written there.
  const adapter: { instructionFiles: readonly string[] } | undefined = HARNESS_ADAPTERS[engine as keyof typeof HARNESS_ADAPTERS]
  if (engine === 'terminal' || adapter?.instructionFiles.length === 0) return
  const folder = harnessWorkspace(workspace, root)
  if (!folder || !store.list().length) return
  const name = instructionFileOf(engine) ?? (engine === 'gemini' ? 'GEMINI.md' : 'AGENTS.md')
  const file = join(folder, name)
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) return
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!previous.includes(marker)) writeFileSync(file, `${previous.trimEnd()}${previous ? '\n\n' : ''}${API_INSTRUCTIONS}`)
}

/**
 * [workspace] as it is on disk when it is a project folder Harness made, otherwise null: directly inside [root], as the
 * trust checks read it (core/agents/create.ts), and no git checkout. A checkout is a repository's (a clone, or a worktree
 * of the person's own), and an agent may commit the note in its tracked instructions. Nor the folder that holds the
 * worktrees (lib/gitProject.ts): Claude Code reads a CLAUDE.md in every folder above it, so a note there would reach
 * every worktree below. Both paths are resolved first, with the case as it is on disk (`native`), so a link in the root
 * to a folder of the person's is that folder. A root that is not there holds none; any other failure is thrown, for the
 * caller's log line.
 */
function harnessWorkspace(workspace: string, root: string): string | null {
  let top: string
  try { top = realpathSync.native(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const folder = realpathSync.native(workspace)
  return dirname(folder) === top && basename(folder) !== 'worktrees' && !existsSync(join(folder, '.git')) ? folder : null
}
