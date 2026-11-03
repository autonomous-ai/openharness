/**
 * npm and npx on the Harness Team account's PATH, from its own copy of Harness's Node.
 *
 * Setup linked only `node` into the account's `~/.local/bin`, so a teammate's Builder there had no npm: it could not
 * install a project's packages or run its JavaScript tests, and the Swarm read the account as having no npm (2026-10-28,
 * the account on this Mac and Mac Auto's). Setup now links them too (script.ts `TEAM_COPY`); an account set up before
 * runs no setup again, so its daemon adds what is missing as it connects. It never replaces a link or file already there.
 */
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The Node tools linked beside `node`. */
export const TEAM_NODE_TOOLS = ['npm', 'npx'] as const

export interface TeamNodeToolsDeps {
  /** Whether this daemon is a Mac's Harness Team account. */
  team(): boolean
  /** The account's own Node (`current-node`), whose folder holds npm and npx. */
  node(): string
  /** `~/.local/bin` of this account. */
  binDir: string
  log(line: string): void
}

/** Links each of [TEAM_NODE_TOOLS] the account's Node has and its bin folder lacks; what it linked. Never throws. */
export function linkTeamNodeTools(deps: TeamNodeToolsDeps): string[] {
  const linked: string[] = []
  try {
    if (!deps.team()) return linked
    const from = dirname(deps.node())
    for (const tool of TEAM_NODE_TOOLS) {
      const target = join(deps.binDir, tool)
      if (!existsSync(join(from, tool)) || present(target)) continue
      mkdirSync(deps.binDir, { recursive: true })
      symlinkSync(join(from, tool), target)
      linked.push(tool)
    }
    if (linked.length) deps.log(`team: linked ${linked.join(' and ')} for the Harness Team account from ${from}`)
  } catch (error) {
    deps.log(`team: could not link npm for the Harness Team account: ${error instanceof Error ? error.message : String(error)}`)
  }
  return linked
}

/** A link or file at [path], even a link whose target is gone. */
function present(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}
