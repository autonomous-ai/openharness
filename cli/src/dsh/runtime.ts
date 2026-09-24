/** Session-scoped harness content. No native skill directories or shared mutable engine config.
 * Create snapshots instructions/env/argv; resume reads that snapshot; fork copies it under a new
 * key. Toolchains and skill assets stay at their installed package paths, as in spec 1.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { PROCESS_ENGINES, type AgentEngine } from '../engines/types.js'
import { HARNESS_BOOTSTRAP, harnessAdapter } from './adapters.js'
import { installedDsh, type InstalledDsh } from './installed.js'
import { dshAccountEnv, dshLaunch, type DshAccount, type DshLaunch } from './launch.js'
import { skillDirsIn } from './materialize.js'

const Snapshot = z.object({
  version: z.literal(1),
  id: z.string(),
  engine: z.enum(PROCESS_ENGINES as [typeof PROCESS_ENGINES[number], ...typeof PROCESS_ENGINES[number][]]),
  instructions: z.string(),
  env: z.record(z.string(), z.string()),
  args: z.array(z.string()),
  skills: z.array(z.object({ name: z.string().regex(/^[^/\\\x00]+$/).refine(name => name !== '.' && name !== '..'), dir: z.string() })),
})
type RuntimeSnapshot = z.infer<typeof Snapshot>

export function harnessRuntimeDir(workspace: string, key: string): string {
  if (!key) throw new Error('A harness runtime needs a session key')
  return join(workspace, '.harness', 'runtime', createHash('sha256').update(key).digest('hex'))
}

/** Do not follow user-created links when writing managed files. The project itself may be a link. */
function ensureRuntimeDir(workspace: string, dir: string): void {
  const root = resolve(workspace)
  let path = root
  for (const part of dir.slice(root.length + 1).split('/')) {
    path = join(path, part)
    if (existsSync(path) || isLink(path)) {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Harness runtime directory is not a plain directory: ${path}`)
    } else mkdirSync(path)
  }
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

function writeManagedFile(path: string, body: string): void {
  if (isLink(path)) throw new Error(`Refusing to replace a symlink: ${path}`)
  writeFileSync(path, body, { mode: 0o600 })
}

/** Older versions appended a marker without an end marker. Remove only text that exactly matches
 * an installed package's instructions; refuse ambiguous edits instead of guessing where user text
 * ends. Also remove only native skill links whose targets are demonstrably owned by that package.
 */
export function migrateHarnessInstructions(workspace: string, current: InstalledDsh,
  lookup: (id: string) => InstalledDsh | null | undefined = installedDsh): void {
  const path = join(workspace, 'AGENTS.md')
  if (!existsSync(path)) return
  const before = readFileSync(path, 'utf8')
  let after = before
  const packages: InstalledDsh[] = []
  for (const match of before.matchAll(/^<!-- harness:dsh ([a-z0-9/-]+) -->\r?\n/gm)) {
    const id = match[1]!
    const pkg = id === current.id || current.manifest.formerly?.includes(id) ? current : lookup(id)
    const instructions = pkg?.manifest.agent?.instructions
    if (!pkg || !instructions) throw new Error(`Cannot safely migrate old harness instructions for ${id} in ${path}; restore the package or remove its marked section.`)
    const body = readFileSync(join(pkg.realDir, instructions), 'utf8').trim()
    const block = `${match[0]}${body}\n`
    if (!after.includes(block)) throw new Error(`The old harness instructions for ${id} in ${path} were edited; move that marked section out of AGENTS.md before launching.`)
    after = after.replace(block, '')
    packages.push(pkg)
  }
  if (after === before) return
  // Keep the exact pre-migration bytes; never replace somebody's earlier backup.
  const backup = join(workspace, '.harness', 'legacy-AGENTS.md')
  ensureRuntimeDir(workspace, join(resolve(workspace), '.harness'))
  if (!existsSync(backup) && !isLink(backup)) writeFileSync(backup, before, { flag: 'wx', mode: 0o600 })
  writeManagedFile(path, after)
  for (const pkg of packages) {
    for (const root of pkg.manifest.agent?.skills ?? []) {
      for (const skill of skillDirsIn(join(pkg.realDir, root))) {
        for (const native of ['.claude/skills', '.agents/skills']) {
          if (isLink(join(workspace, native.split('/')[0]!)) || isLink(join(workspace, native))) continue
          const link = join(workspace, native, basename(skill))
          if (isLink(link) && resolve(link, '..', readlinkSync(link)) === resolve(skill)) rmSync(link)
        }
      }
    }
  }
}

function installBootstrap(workspace: string, engine: AgentEngine): void {
  const adapter = harnessAdapter(engine)
  const file = adapter.instructionFiles.find(name => existsSync(join(workspace, name)))
    ?? (engine === 'claude' ? 'CLAUDE.md' : 'AGENTS.md')
  const path = join(workspace, file)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (before.includes(HARNESS_BOOTSTRAP)) return
  if (before.includes('<!-- harness:runtime')) throw new Error(`The Harness bootstrap in ${path} was edited; restore it before launching.`)
  const projectRules = engine === 'claude' && existsSync(join(workspace, 'AGENTS.md')) && !before.split('\n').some(line => line.trim() === '@AGENTS.md')
    ? '@AGENTS.md\n' : ''
  // Preserve all project bytes. Only the generic, env-dispatched bootstrap is shared by sessions.
  writeManagedFile(path, `${before}${before.endsWith('\n') || !before ? '' : '\n'}\n${projectRules}${HARNESS_BOOTSTRAP}`)
}

function snapshot(dsh: InstalledDsh, workspace: string, engine: AgentEngine): RuntimeSnapshot {
  harnessAdapter(engine)
  const source = dsh.manifest.agent?.instructions
  const instructions = source ? readFileSync(join(dsh.realDir, source), 'utf8') : ''
  const skills: RuntimeSnapshot['skills'] = []
  for (const root of dsh.manifest.agent?.skills ?? []) {
    const dirs = skillDirsIn(join(dsh.realDir, root))
    if (!dirs.length) throw new Error(`No SKILL.md under ${join(dsh.realDir, root)}; repair the harness installation.`)
    for (const dir of dirs) {
      const name = basename(dir)
      const found = skills.find(skill => skill.name === name)
      if (found && found.dir !== dir) throw new Error(`Duplicate harness skill name: ${name}`)
      if (!found) skills.push({ name, dir })
    }
  }
  const launch = dshLaunch(dsh, workspace, {}, engine)
  return Snapshot.parse({ version: 1, id: dsh.id, engine, instructions, env: launch.env, args: launch.args, skills })
}

/** Prepare before spawning any engine process. `sourceKey` is a fork's original bundle. A saved
 * bundle is authoritative: changing the store default or instructions cannot retarget a session.
 */
export function prepareHarnessLaunch(dsh: InstalledDsh, workspace: string, engine: AgentEngine,
  key: string, account: DshAccount = {}, sourceKey?: string | null): DshLaunch {
  const adapter = harnessAdapter(engine)
  if (dsh.manifest.kind === 'viewer') throw new Error(`${dsh.id} is a viewer, not a harness`)
  const ws = realpathSync(workspace)
  const dir = harnessRuntimeDir(ws, key)
  ensureRuntimeDir(ws, dir)
  const ignoreFile = join(ws, '.harness', '.gitignore')
  const ignored = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : ''
  const ignoreRules = ['runtime/', 'legacy-AGENTS.md'].filter(rule => !ignored.split('\n').includes(rule))
  if (ignoreRules.length) writeManagedFile(ignoreFile, `${ignored}${ignored && !ignored.endsWith('\n') ? '\n' : ''}${ignoreRules.join('\n')}\n`)
  const file = join(dir, 'runtime.json')
  const from = sourceKey ? join(harnessRuntimeDir(ws, sourceKey), 'runtime.json') : file
  if (sourceKey) {
    ensureRuntimeDir(ws, harnessRuntimeDir(ws, sourceKey))
    if (!existsSync(from)) throw new Error(`The original harness runtime is missing: ${from}`)
  }
  if (isLink(from)) throw new Error(`Harness runtime snapshot is a symlink: ${from}`)
  const data = existsSync(from) ? Snapshot.parse(JSON.parse(readFileSync(from, 'utf8'))) : snapshot(dsh, ws, engine)
  if (data.engine !== engine || (data.id !== dsh.id && !dsh.manifest.formerly?.includes(data.id))) {
    throw new Error(`Harness runtime belongs to ${data.id} / ${data.engine}, not ${dsh.id} / ${engine}`)
  }
  if (sourceKey && (existsSync(file) || isLink(file))) {
    if (isLink(file)) throw new Error(`Harness runtime snapshot is a symlink: ${file}`)
    const saved = Snapshot.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (JSON.stringify(saved) !== JSON.stringify(data)) throw new Error(`The fork destination already has a different harness runtime: ${file}`)
  }
  const skillsDir = join(dir, 'skills')
  ensureRuntimeDir(ws, skillsDir)
  // Validate before modifying project instructions or committing a snapshot.
  for (const skill of data.skills) {
    if (!existsSync(join(skill.dir, 'SKILL.md'))) throw new Error(`Harness skill is missing: ${skill.dir}; repair the harness installation.`)
    const link = join(skillsDir, skill.name)
    if (existsSync(link) || isLink(link)) {
      if (!isLink(link) || readlinkSync(link) !== skill.dir) throw new Error(`Harness skill path is already occupied: ${link}`)
    } else symlinkSync(skill.dir, link)
  }
  migrateHarnessInstructions(ws, dsh)
  installBootstrap(ws, engine)
  const env: Record<string, string> = { ...data.env, ...dshAccountEnv(account), HARNESS_CONTEXT_FILE: join(dir, 'CONTEXT.md'), HARNESS_SKILLS_DIR: skillsDir }
  // Spec-1 packages used their default engine's discovery paths in env. Translate the path, not
  // arbitrary engine names or source paths inside an upstream installation.
  for (const [name, value] of Object.entries(env)) {
    env[name] = value.replaceAll(`${ws}/.claude/skills`, skillsDir).replaceAll(`${ws}/.agents/skills`, skillsDir)
  }
  const context = [
    `# ${dsh.manifest.name} (${data.id})`,
    `Engine: ${engine}. Workspace: ${JSON.stringify(ws)}.`,
    'Use your file and shell tools for these instructions, skills, and toolchain commands.',
    'Legacy references to .claude/skills or .agents/skills mean HARNESS_SKILLS_DIR for this session.',
    '', data.instructions.trim()
      .replace(/^You are (?:Claude Code|Codex) in /gm, 'You are an agent in ')
      // Rewrite workspace-relative examples into executable, quoted commands. Upstream paths such
      // as $STUDIO_UPSTREAM/.claude/skills remain source paths and must not be redirected.
      .replace(/(?<![\w/$.{}-])\.(?:claude|agents)\/skills(?![\w-])/g, '"$HARNESS_SKILLS_DIR"'),
    '', '## Harness skills',
    ...data.skills.map(skill => `- ${skill.name}: ${JSON.stringify(join(skillsDir, skill.name, 'SKILL.md'))}`),
    '',
  ].join('\n')
  writeManagedFile(env.HARNESS_CONTEXT_FILE!, context)
  if (!existsSync(file)) writeManagedFile(file, `${JSON.stringify(data, null, 2)}\n`)
  return { env, args: [...data.args, ...(adapter.contextArgs?.(env.HARNESS_CONTEXT_FILE!) ?? [])] }
}
