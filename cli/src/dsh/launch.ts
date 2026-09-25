/**
 * What a DSH adds to its base engine's launch: the three `HARNESS_*` variables every DSH script can
 * rely on, the manifest's own env with `${dsh}`/`${workspace}` expanded, and its extra argv.
 *
 * Applied on create AND on every relaunch (`launchOverrides.ts`), so an agent restored after a reboot
 * or restarted in place is still the DSH it was created as — and still discoverable as one, since
 * `HARNESS_DSH` is what `probe.ts` reads off the live process.
 */
import type { InstalledDsh } from './installed.js'
import { expandDshValue } from './manifest.js'

export interface DshLaunch {
  env: Record<string, string>
  args: string[]
}

/** Clear every inherited session fact that this launch does not explicitly provide. This includes
 * all context for Coding and an old account's private grid when the new harness has none. */
export const DSH_SESSION_ENV = ['HARNESS_DSH', 'HARNESS_DSH_DIR', 'HARNESS_WORKSPACE', 'HARNESS_CONTEXT_FILE', 'HARNESS_SKILLS_DIR', 'HARNESS_PRIVATE_GRID'] as const
export function harnessEnvToClear(launchEnv: Record<string, string> = {}): string[] {
  return DSH_SESSION_ENV.filter(name => !Object.hasOwn(launchEnv, name))
}

/** Facts about the signed-in account a harness is told rather than left to guess or ask. */
export interface DshAccount {
  /** The account's private grid — what "my grid" means to the person. */
  privateGrid?: string | null
}

/** [account] as `HARNESS_*` variables, for the workspace init and the agent alike. */
export function dshAccountEnv(account: DshAccount): Record<string, string> {
  return account.privateGrid ? { HARNESS_PRIVATE_GRID: account.privateGrid } : {}
}

export function dshLaunch(dsh: InstalledDsh, workspace: string, account: DshAccount = {}, engine = dsh.manifest.engine): DshLaunch {
  const vars = { dsh: dsh.realDir, workspace }
  const env: Record<string, string> = {
    HARNESS_DSH: dsh.id,
    HARNESS_DSH_DIR: dsh.realDir,
    HARNESS_WORKSPACE: workspace,
    ...dshAccountEnv(account),
  }
  for (const [key, value] of Object.entries(dsh.manifest.agent?.env ?? {})) {
    if (key.startsWith('HARNESS_')) continue // ours; a manifest cannot rename itself
    env[key] = expandDshValue(value, vars)
  }
  // A saved session keeps its engine even if a package update changes the default.
  // Default-engine flags must never be handed to a different engine on restore.
  const args = (engine === dsh.manifest.engine ? dsh.manifest.agent?.args ?? [] : [])
    .map((arg) => expandDshValue(arg, vars))
  return { env, args }
}
