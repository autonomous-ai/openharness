import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { createHomeAdopter, readAdoptedHomes } from '../engines/kit/homeAdoption.js'
import { writeWhole, type Done, type JournalIo } from './journal.js'
import { movedPath, type MovePlan } from './plan.js'

export interface RewriteIo extends JournalIo, Pick<typeof import('node:fs'), 'lstatSync' | 'readFileSync' | 'readdirSync' | 'chmodSync'> {}

const NODE_FS: RewriteIo = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, lstatSync, readFileSync, readdirSync, chmodSync }

type Homes = ReturnType<typeof readAdoptedHomes>['homes']
type Journal = { add(done: Done): void }
type Rewrite = (path: string, change: (text: string) => string) => void

// The data folder's records that store a path: lib/registry.ts, lib/claudeHomes.ts, lib/codexProfiles.ts and
// devices/dialSkillFiles.ts write them.
const DATA_RECORDS = ['registry.json', 'claude-profiles.json', 'codex-profiles.json', 'dial-setup.json', 'dial-skill.json']
// What Claude Code keeps by path in a profile: its plugins load from there once the bridge is gone.
const PROFILE_RECORDS = [['plugins', 'installed_plugins.json'], ['plugins', 'known_marketplaces.json']]
// engines/kit/homeAdoption.ts's catalog, and the sealed pool beside it.
const ENGINE_HOMES = 'engine-homes.json'
const POOL = ['.adoptions', '.adopted', '.confirmations']
const ASIDE = '.before-move'
// A JSON string, and the colon after it when it is a key: outside its strings JSON has no quote.
const STRING = /"(?:\\.|[^"\\])*"(\s*:)?/g

/**
 * Rewrites each record in the staged trees, and in the data folder [dataDir] wherever an override keeps it, that stores a
 * path in the old tree, so it names that entry's place after the commit. A file's previous bytes are in [journal] before
 * it changes. [left] names the files that could not be read as JSON, and the engine-home journal when it is refused.
 */
export function rewriteInside(plan: MovePlan, dataDir: string, journal: Journal, io: RewriteIo = NODE_FS): { files: number; left: string[] } {
  const left: string[] = []
  let files = 0
  const rewrite: Rewrite = (path, change) => {
    const info = io.lstatSync(path, { throwIfNoEntry: false })
    if (!info) return
    const bytes = info.isFile() ? io.readFileSync(path) : null
    // restoreFile writes the saved bytes back as text: only a file whose bytes are its text is touched.
    const text = bytes && Buffer.from(bytes.toString()).equals(bytes) ? bytes.toString() : null
    const next = text === null ? null : unlessNotJson(() => change(text))
    if (text === null || next === null) {
      left.push(path)
      return
    }
    if (next === text) return
    journal.add({ did: 'file', path, before: Buffer.from(text).toString('base64') })
    writeWhole(path, next, io)
    // writeWhole makes a file owner-only; the record keeps the mode it had.
    io.chmodSync(path, info.mode & 0o7777)
    files += 1
  }
  const move = (text: string): string => moveStrings(plan, text)
  const staged = (name: string): string | undefined => plan.entries.find((entry) => entry.name === name)?.staged

  const runtime = staged('runtime')
  if (runtime) for (const { name } of entriesOf(runtime, io)) if (name.startsWith('current-')) rewrite(join(runtime, name), (text) => movePointer(plan, text))
  for (const name of DATA_RECORDS) rewrite(join(dataDir, name), move)
  const stopped = join(dataDir, 'stopped-agents')
  for (const { name } of entriesOf(stopped, io)) if (name.endsWith('.json')) rewrite(join(stopped, name), move)
  // lib/nodeMigration.ts keeps it in the CLI folder.
  const cli = staged('cli')
  if (cli) rewrite(join(cli, 'node-migration.json'), move)
  const dsh = staged('dsh')
  if (dsh) rewrite(join(dsh, 'installed.json'), (text) => markPending(move(text), !!runtime))
  const profiles = staged('claude-profiles')
  if (profiles) {
    for (const profile of entriesOf(profiles, io)) {
      if (profile.isDirectory()) for (const record of PROFILE_RECORDS) rewrite(join(profiles, profile.name, ...record), move)
    }
  }
  const engineHomes = join(dataDir, ENGINE_HOMES)
  if (!reseal(plan, engineHomes, rewrite, journal, io)) left.push(engineHomes)
  return { files, left }
}

/** Puts back a rewritten file's exact bytes, keeping the mode it has; removes one that was not there. */
export function restoreFile(done: Extract<Done, { did: 'file' }>): void {
  if (done.before === null) {
    rmSync(done.path, { force: true })
    return
  }
  const mode = lstatSync(done.path, { throwIfNoEntry: false })?.mode
  writeWhole(done.path, Buffer.from(done.before, 'base64').toString())
  if (mode !== undefined) chmodSync(done.path, mode & 0o7777)
}

/** Brings back a name set aside, over whatever took its place. With no aside on disk the name never moved: a crash came between the journal line and the rename. */
export function restoreAside(done: Extract<Done, { did: 'aside' }>): void {
  if (!lstatSync(done.aside, { throwIfNoEntry: false })) return
  rmSync(done.path, { recursive: true, force: true })
  renameSync(done.aside, done.path)
}

/** The finish: what was set aside goes. */
export function dropAside(done: Extract<Done, { did: 'aside' }>): void {
  rmSync(done.aside, { recursive: true, force: true })
}

/**
 * engine-homes.json: its catalog is rewritten like any record. Its sealed pool is chained by digests and only adds homes,
 * so it is set aside whole and sealed again, through homeAdoption.ts's own writer, as one record of every home, moved.
 * False, with nothing changed, when readAdoptedHomes refuses the journal.
 */
function reseal(plan: MovePlan, file: string, rewrite: Rewrite, journal: Journal, io: RewriteIo): boolean {
  let homes: Homes
  try {
    homes = readAdoptedHomes(file).homes
  } catch {
    return false
  }
  const moved: Homes = { claude: homes.claude.map((home) => movedPath(plan, home)), codex: homes.codex.map((home) => movedPath(plan, home)) }
  if (sameHomes(moved, homes)) return true
  rewrite(file, (text) => moveStrings(plan, text))
  const pool = POOL.map((name) => file + name).filter((path) => io.lstatSync(path, { throwIfNoEntry: false }))
  if (!pool.length) return true
  for (const path of pool) {
    journal.add({ did: 'aside', path, aside: path + ASIDE })
    io.renameSync(path, path + ASIDE)
  }
  createHomeAdopter(file).adopt(moved)
  if (!sameHomes(readAdoptedHomes(file).homes, moved)) throw new Error('the engine-home journal sealed again does not read back the moved homes')
  return true
}

const sameHomes = (a: Homes, b: Homes): boolean => (['claude', 'codex'] as const).every((engine) =>
  new Set(a[engine]).size === new Set(b[engine]).size && a[engine].every((home) => b[engine].includes(home)))

/** [text], a JSON record, with each string value that is a path in the old tree naming its new place; keys and every other byte as they were. */
function moveStrings(plan: MovePlan, text: string): string {
  // A file that is not JSON throws here, and is left.
  JSON.parse(text)
  return text.replace(STRING, (token: string, key: string | undefined) => {
    if (key) return token
    const value = JSON.parse(token) as string
    const moved = movedPath(plan, value)
    return moved === value ? token : JSON.stringify(moved)
  })
}

/** A runtime pointer (`current-node`, `current-grid`, any `current-*`): one path and its line end. */
function movePointer(plan: MovePlan, text: string): string {
  const path = text.trimEnd()
  return movedPath(plan, path) + text.slice(path.length)
}

/**
 * dsh/installed.json, its paths moved: what a package's setup built (venvs, launchers) names its old folder, and runs on
 * Harness's Python under `runtime`. So each package is marked to be set up again by the Store (dsh/setupAgain.ts): one
 * linked to a checkout outside the tree only when [runtimeMoved], as its own files stay where they are.
 */
function markPending(text: string, runtimeMoved: boolean): string {
  const records = JSON.parse(text) as unknown
  if (!Array.isArray(records)) return text
  // dsh/installed.ts writeInstalledIndex's spelling: an index with nothing to mark comes out as it was, and is not written.
  return `${JSON.stringify(records.map((record) => record?.linked === true && !runtimeMoved ? record : { ...record, setup: 'pending' }), null, 2)}\n`
}

function unlessNotJson(change: () => string): string | null {
  try {
    return change()
  } catch {
    return null
  }
}

function entriesOf(folder: string, io: RewriteIo): Dirent[] {
  try {
    return io.readdirSync(folder, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
