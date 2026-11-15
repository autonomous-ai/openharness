/** Discoverable tool access, without copying credentials or model settings into projects. */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
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

/** Only workspaces Harness made (below [root], where it makes them), and only while APIs are saved. Existing
 * instructions are kept; no global agent settings or credentials are written into the project. A folder the person
 * chose is theirs, and nothing is written into it: until 15 November any folder a harness started in got the note,
 * the person's own repository included (core audit, security 9). */
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

/** [workspace] as it is on disk, when that is below [root] as it is on disk; otherwise null. Resolved first, so a link
 * in the root to a folder of the person's is that folder. The root itself is no workspace. `relative` and `sep` are the
 * platform's, so a folder on Windows (`..\`, another drive) is compared as Windows does. */
function harnessWorkspace(workspace: string, root: string): string | null {
  let folder: string, top: string
  try { folder = realpathSync(workspace); top = realpathSync(root) } catch { return null }
  const path = relative(top, folder)
  return path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? folder : null
}
