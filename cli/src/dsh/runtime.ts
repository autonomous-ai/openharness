/** Session-scoped harness content. No native skill directories or shared mutable engine config.
 * Create snapshots instructions/env/argv; resume reads that snapshot; fork copies it under a new
 * key. Toolchains and skill assets stay at their installed package paths, as in spec 1.
 */
import { ignoreHarnessRuntime } from '../lib/harnessRuntimeIgnore.js'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
// Not `env`: the launch's own environment is named that below.
import { env as config } from '../config/env.js'
import { harnessPath, legacyHarnessHome, legacyHarnessPath } from '../config/harnessHome.js'
import { PROCESS_ENGINES, type AgentEngine } from '../engines/types.js'
import { instructionFileOf, launchContract } from '../engines/launches.js'
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
  return join(runtimesOf(workspace), createHash('sha256').update(key).digest('hex'))
}

/** The home as written and as its links lead (`/home` is a link on some systems), so a real path still finds it. */
function homeSpellings(): string[] {
  const home = homedir()
  try { return [home, realpathSync(home)] } catch { return [home] }
}

/**
 * Where a workspace's harness runtimes live: in its own `.harness`. The home's is Harness's own folder, which on Linux
 * moves to the XDG places and leaves a bridge of links behind: a harness launched in the home then keeps its runtimes in
 * the state root's `runtime`, where the move put the ones made before it.
 */
function runtimesOf(workspace: string): string {
  const own = join(workspace, '.harness', 'runtime')
  const moved = harnessPath('runtime')
  if (moved === legacyHarnessPath('runtime')) return own
  const dir = resolve(workspace, '.harness')
  return homeSpellings().some(home => legacyHarnessHome(home) === dir) ? moved : own
}

/**
 * The folder a launch makes a runtime's folders from, each checked to be a plain one: the workspace, itself possibly a
 * link, or for the home after the move Harness's own runtime folder, made whole.
 */
function runtimeBase(ws: string): string {
  const runtimes = runtimesOf(ws)
  if (runtimes === join(ws, '.harness', 'runtime')) return ws
  mkdirSync(runtimes, { recursive: true })
  return runtimes
}

/** Do not follow user-created links when writing managed files. The project itself may be a link. */
function ensureRuntimeDir(workspace: string, dir: string): void {
  const root = resolve(workspace)
  let path = root
  // By the platform's separator: split on '/', a Windows path was one part, and its non-recursive mkdir failed with
  // ENOENT on every first launch in a workspace (dsh_runtime_failed from Oct 22, the day after Windows shipped).
  for (const part of relative(root, dir).split(sep)) {
    path = join(path, part)
    if (existsSync(path) || isLink(path)) {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Harness runtime directory is not a plain directory: ${path}`)
    } else mkdirSync(path)
  }
}

/**
 * [path] at the dsh folder's new place when it names the old one: on Linux Harness's folder moves from `~/.harness` to the
 * XDG places, and a workspace's saved runtime and skill links still name the old folder. Only the default folder moves; a
 * DSH_DIR the person named is theirs.
 */
function movedDshPath(path: string): string {
  const legacy = legacyHarnessPath('dsh')
  if (!path.startsWith(legacy + sep) || config.DSH_DIR === legacy || config.DSH_DIR !== harnessPath('dsh')) return path
  return config.DSH_DIR + path.slice(legacy.length)
}

function movedSnapshot(data: RuntimeSnapshot): RuntimeSnapshot {
  return { ...data, env: Object.fromEntries(Object.entries(data.env).map(([name, value]) => [name, movedDshPath(value)])),
    args: data.args.map(movedDshPath), skills: data.skills.map(skill => ({ ...skill, dir: movedDshPath(skill.dir) })) }
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

function writeManagedFile(path: string, body: string): void {
  if (isLink(path)) throw new Error(`Refusing to replace a symlink: ${path}`)
  // A killed Store must never truncate the context an already-running agent is reading.
  const temporary = `${path}.${randomUUID()}.tmp`
  const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600
  const fd = openSync(temporary, 'wx', mode)
  try {
    try { writeFileSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
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
          // unlinkSync, not rmSync: on current Node rmSync follows a link to a directory and
          // throws EISDIR, which crashed the migration it exists to finish. A link is unlinked.
          if (isLink(link) && resolve(link, '..', readlinkSync(link)) === resolve(skill)) unlinkSync(link)
        }
      }
    }
  }
}

function installBootstrap(workspace: string, engine: AgentEngine): void {
  const adapter = harnessAdapter(engine)
  const file = adapter.instructionFiles.find(name => existsSync(join(workspace, name)))
    ?? instructionFileOf(engine) ?? 'AGENTS.md'
  const path = join(workspace, file)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (before.includes(HARNESS_BOOTSTRAP)) return
  if (before.includes('<!-- harness:runtime')) throw new Error(`The Harness bootstrap in ${path} was edited; restore it before launching.`)
  // An engine that reads the project's AGENTS.md only through an import line in its own file gets that line.
  const imports = launchContract(engine)?.instructionImport
  const projectRules = imports && existsSync(join(workspace, imports.file)) && !before.split('\n').some(line => line.trim() === imports.line)
    ? `${imports.line}\n` : ''
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
/**
 * Why `engine` cannot run the harness `id`, or null when it can. The words are what a refused
 * create says, so they name what WOULD work rather than only what was wrong.
 */
/**
 * The runtime bundle a fork copies. A session records its key when it is created; one created
 * before keys were recorded still has a bundle under its agent id if it ran on this version, and
 * that is the one to copy. Neither means the fork starts a fresh bundle rather than failing.
 */
export function forkRuntimeKey(source: { cwd: string; agentId: string; dshRuntime?: string | null }): string | null {
  if (source.dshRuntime) return source.dshRuntime
  return existsSync(join(harnessRuntimeDir(source.cwd, source.agentId), 'runtime.json')) ? source.agentId : null
}

export function prepareHarnessLaunch(dsh: InstalledDsh, workspace: string, engine: AgentEngine,
  key: string, account: DshAccount = {}, sourceKey?: string | null): DshLaunch {
  const adapter = harnessAdapter(engine)
  if (dsh.manifest.kind === 'viewer') throw new Error(`${dsh.id} is a viewer, not a harness`)
  const ws = realpathSync(workspace)
  const base = runtimeBase(ws)
  const dir = harnessRuntimeDir(ws, key)
  ensureRuntimeDir(base, dir)
  // Into the workspace's own .harness only, never Harness's folder in the home.
  if (base === ws) ignoreHarnessRuntime(ws)
  const file = join(dir, 'runtime.json')
  const from = sourceKey ? join(harnessRuntimeDir(ws, sourceKey), 'runtime.json') : file
  if (sourceKey) {
    ensureRuntimeDir(base, harnessRuntimeDir(ws, sourceKey))
    if (!existsSync(from)) throw new Error(`The original harness runtime is missing: ${from}`)
  }
  if (isLink(from)) throw new Error(`Harness runtime snapshot is a symlink: ${from}`)
  const data = existsSync(from) ? movedSnapshot(Snapshot.parse(JSON.parse(readFileSync(from, 'utf8')))) : snapshot(dsh, ws, engine)
  if (data.engine !== engine || (data.id !== dsh.id && !dsh.manifest.formerly?.includes(data.id))) {
    throw new Error(`Harness runtime belongs to ${data.id} / ${data.engine}, not ${dsh.id} / ${engine}`)
  }
  if (sourceKey && (existsSync(file) || isLink(file))) {
    if (isLink(file)) throw new Error(`Harness runtime snapshot is a symlink: ${file}`)
    const saved = movedSnapshot(Snapshot.parse(JSON.parse(readFileSync(file, 'utf8'))))
    if (JSON.stringify(saved) !== JSON.stringify(data)) throw new Error(`The fork destination already has a different harness runtime: ${file}`)
  }
  const skillsDir = join(dir, 'skills')
  ensureRuntimeDir(base, skillsDir)
  // Validate before modifying project instructions or committing a snapshot.
  for (const skill of data.skills) {
    if (!existsSync(join(skill.dir, 'SKILL.md'))) throw new Error(`Harness skill is missing: ${skill.dir}; repair the harness installation.`)
    const link = join(skillsDir, skill.name)
    if (existsSync(link) || isLink(link)) {
      const target = isLink(link) ? readlinkSync(link) : ''
      const atNewPlace = movedDshPath(target)
      // Compared resolved, so a link that writes the same folder another way (a trailing separator) is still its own.
      if (!target || resolve(atNewPlace) !== resolve(skill.dir)) throw new Error(`Harness skill path is already occupied: ${link}`)
      // Made before Harness's folder moved: linked again at the new place, so nothing waits on the old folder's bridge.
      if (atNewPlace !== target) {
        unlinkSync(link)
        symlinkSync(skill.dir, link, 'junction')
      }
    // A junction on Windows: a directory symlink needs Developer Mode or an administrator (EPERM), a junction
    // neither. Other platforms ignore the type.
    } else symlinkSync(skill.dir, link, 'junction')
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
  // Written once, and again when the move of Harness's folder gave its paths their new place.
  const body = `${JSON.stringify(data, null, 2)}\n`
  if (!existsSync(file) || readFileSync(file, 'utf8') !== body) writeManagedFile(file, body)
  return { env, args: [...data.args, ...(adapter.contextArgs?.(env.HARNESS_CONTEXT_FILE!) ?? []), ...(adapter.envArgs?.(env) ?? [])] }
}
