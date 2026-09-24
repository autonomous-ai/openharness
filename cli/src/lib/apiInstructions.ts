/** Discoverable tool access, without copying credentials or model settings into projects. */
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiConnections } from './apiConnections.js'

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

/** Only Harness-created workspaces with saved APIs. Existing instructions are kept;
 * no global agent settings or credentials are written into the project. */
export function prepareApiInstructions(store: ApiConnections, workspace: string, engine: string): void {
  if (engine === 'terminal' || !store.list().length) return
  const name = engine === 'claude' ? 'CLAUDE.md' : engine === 'gemini' ? 'GEMINI.md' : 'AGENTS.md'
  const file = join(workspace, name)
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) return
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!previous.includes(marker)) writeFileSync(file, `${previous.trimEnd()}${previous ? '\n\n' : ''}${API_INSTRUCTIONS}`)
}
