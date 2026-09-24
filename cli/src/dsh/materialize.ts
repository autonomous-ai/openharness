/** Prepare a harness workspace independently of the selected agent. Templates and init belong to
 * the harness; instructions and skills are bound per session by runtime.ts after preparation. */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledDsh } from './installed.js'
import { dshAccountEnv, type DshAccount } from './launch.js'
import { dshSupportedEngines } from './manifest.js'
import { runDshCommand } from './shell.js'

export interface MaterializeResult {
  /** Files and links this call created. */
  created: string[]
  /** Things already in place, left untouched. */
  kept: string[]
  /** Things that could not be done, with why; never fatal. */
  warnings: string[]
  /** Output of the init command, when it ran. */
  initLines: string[]
}

/** Subdirectories of `dir` that carry a SKILL.md, or `dir` itself when it is a single skill. */
export function skillDirsIn(dir: string): string[] {
  if (existsSync(join(dir, 'SKILL.md'))) return [dir]
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .map((name) => join(dir, name))
    .filter((path) => {
      try { return statSync(path).isDirectory() && existsSync(join(path, 'SKILL.md')) } catch { return false }
    })
    .sort()
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function copyTemplate(templateDir: string, workspace: string, result: MaterializeResult): void {
  if (!existsSync(templateDir)) {
    result.warnings.push(`template ${templateDir} is missing`)
    return
  }
  // Never overwrite: a workspace with no marker may still have files the user put there.
  cpSync(templateDir, workspace, { recursive: true, force: false, errorOnExist: false })
  result.created.push(`template → ${workspace}`)
}

/** A command that is a path inside the harness becomes that absolute path, shell-quoted. */
export function resolveDshCommand(dsh: Pick<InstalledDsh, 'realDir'>, command: string): string {
  if (/[\s;&|<>$`'"\\]/.test(command)) return command
  const inside = join(dsh.realDir, command)
  if (!existsSync(inside)) return command
  return `'${inside.replace(/'/g, `'\\''`)}'`
}

export async function materializeWorkspace(dsh: InstalledDsh, workspace: string, account: DshAccount = {}, engine = dsh.manifest.engine ?? 'claude'): Promise<MaterializeResult> {
  const result: MaterializeResult = { created: [], kept: [], warnings: [], initLines: [] }
  if (dsh.manifest.kind === 'viewer') {
    result.warnings.push(`${dsh.id} is a viewer package; it has no workspace to lay out`)
    return result
  }
  if (!dshSupportedEngines(dsh.manifest).includes(engine)) {
    throw new Error(`${dsh.id} does not support ${engine}`)
  }
  const ws = dsh.manifest.workspace
  const marker = ws?.marker ? join(workspace, ws.marker) : null
  // No marker declared means nothing can say the workspace is laid out: the template is copied (never
  // over a file) and the init runs at every create — what the spec says, and what `dsh check` warns of.
  const fresh = marker ? !existsSync(marker) : true
  if (fresh && ws?.template) copyTemplate(join(dsh.realDir, ws.template), workspace, result)
  if (fresh && ws?.init) {
    // The init runs IN the workspace, so a command that names a script by its path inside the
    // harness (the usual shape: `harness/toolchain/init-workspace.sh`) is resolved against the
    // install directory first; anything else is a shell line and runs as written.
    const init = await runDshCommand(resolveDshCommand(dsh, ws.init), {
      cwd: workspace,
      env: { HARNESS_DSH: dsh.id, HARNESS_DSH_DIR: dsh.realDir, HARNESS_WORKSPACE: workspace, ...dshAccountEnv(account) },
      onLine: (line) => result.initLines.push(line),
      timeoutMs: 5 * 60_000,
    })
    if (init.code !== 0 || init.timedOut) {
      result.warnings.push(`init exited ${init.timedOut ? 'by timeout' : init.code ?? init.signal}`)
    }
  } else if (marker && !fresh) {
    result.kept.push(ws!.marker!)
  }
  ensureDir(join(workspace, '.harness'))
  return result
}
