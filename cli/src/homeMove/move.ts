/**
 * The move (docs/plans/2026-11-18-linux-xdg-paths-design.md, The move, Rollback, Recovery after a crash): ~/.harness to
 * the XDG roots. Each step is in the journal before it acts, so a failure before the data root's rename is undone, and a
 * crash is undone or finished by the next start. Each step looks at what is there first, so one run twice does it once.
 */
import { isAbsolute, join, resolve } from 'node:path'
import { legacyHarnessHome, type HarnessRootKind } from '../config/harnessHome.js'
import { makeRealFolders, writeBridge } from './bridge.js'
import type { MoveCheck, Reason } from './conditions.js'
import { openJournal, readJournal, type Done, type Journal } from './journal.js'
import type { Tmux } from './panes.js'
import { draftOf, OWN_FILES, type MoveEntry, type MovePlan } from './plan.js'
import { writeMoveRecord } from './record.js'
import { dropAside, restoreAside, restoreFile, rewriteInside, type RewriteIo } from './rewriteInside.js'
import { restoreOutside, rewriteOutside } from './rewriteOutside.js'
import { commitRoot, dropOriginals, mergeRecreated, stageEntry, uncommitRoot, unstageEntry, type StageIo } from './stage.js'

export interface MoveDeps { io: StageIo & RewriteIo; tmux: Tmux; run(command: string, args: string[]): { status: number | null }; now(): number; procNow(): number; log(line: string): void }
export type MoveOutcome = { state: 'bridged'; entries: number; bytesCopied: number; panes: number } | { state: 'failed'; reason: Reason }

type Io = MoveDeps['io']
type Steps = { add(done: Done): void }

// The state root first: the data root's rename is the commit.
const ROOTS = ['state', 'data'] as const

const stagingOf = (plan: MovePlan, root: HarnessRootKind): string => `${plan[root]}.moving`
const there = (path: string, io: Io): boolean => io.lstatSync(path, { throwIfNoEntry: false }) !== undefined
const committed = (plan: MovePlan, io: Io): boolean => there(plan.data, io) && !there(stagingOf(plan, 'data'), io)

/** Moves ~/.harness to the XDG roots as [check] planned it, and leaves the bridge; or puts everything back and says why. */
export async function runMove(check: Extract<MoveCheck, { move: true }>, env: NodeJS.ProcessEnv, deps: MoveDeps): Promise<MoveOutcome> {
  const { plan, oldTag, newTag } = check, { io } = deps
  const begun = { version: 1, startedAt: deps.now(), plan, oldTag, newTag } as const
  const done: Done[] = []
  const oldDataDir = dataDirOf(plan, env)
  let steps: Steps
  let bytesCopied = 0
  try {
    preflight(plan, io)
    const file = openJournal({ ...begun, done: [] }, io)
    steps = {
      add: (step) => {
        file.add(step)
        done.push(step)
      },
    }
    for (const entry of plan.entries) bytesCopied += stage(entry, plan, steps, deps, begun.startedAt)
    // The data folder as staged, or where an override keeps it.
    rewriteInside(plan, rebase(oldDataDir, plan.entries.map((entry) => [entry.from, entry.staged])), steps, io)
    rewriteOutside(plan, outside(plan.home, env, oldDataDir), steps, deps.run)
    // A data folder an override keeps out of the tree keeps its tag, and its panes theirs.
    if (newTag !== oldTag) deps.tmux.retag(oldTag, newTag, steps)
    // A hook that ran since an entry's link went in may have put a folder in its place.
    for (const entry of plan.entries) mergeRecreated(entry, io)
    for (const root of ROOTS) {
      steps.add({ did: 'commit', root })
      commitRoot(plan, root, io)
    }
  } catch (error) {
    rollBack({ ...begun, done }, deps)
    return failed(plan.legacy, error, deps)
  }
  return complete({ ...begun, done }, steps, oldDataDir, bytesCopied, deps)
}

/** A journal an earlier move left: finished when the data root is committed, rolled back when not. Null with no journal. */
export async function recoverMove(home: string, env: NodeJS.ProcessEnv, deps: MoveDeps): Promise<MoveOutcome | { state: 'rolled-back' } | null> {
  const journal = readJournal(legacyHarnessHome(home, 'linux'))
  if (!journal) return null
  const { plan } = journal
  if (!committed(plan, deps.io)) {
    const failure = rollBack(journal, deps)
    return failure === null ? { state: 'rolled-back' } : failed(plan.legacy, failure, deps)
  }
  // What it copied is not in the journal: a move finished here counts no bytes.
  return complete(journal, openJournal(journal, deps.io), dataDirOf(plan, env), 0, deps)
}

/**
 * The roots free, and their staging folders made owner-only, with any XDG base missing (the XDG spec's 0700). A root
 * there already, or a staging folder something left full, is somebody's: the move takes nothing over.
 */
function preflight(plan: MovePlan, io: Io): void {
  const taken = ROOTS.some((root) => there(plan[root], io) || (there(stagingOf(plan, root), io) && io.readdirSync(stagingOf(plan, root)).length > 0))
  if (taken) throw Object.assign(new Error('a folder the move goes to is there already'), { reason: 'target-exists' })
  for (const root of ROOTS) io.mkdirSync(stagingOf(plan, root), { recursive: true, mode: 0o700 })
}

/**
 * Stages [entry], its journal line first. Across filesystems it is copied, and a crash during the copy must drop the
 * copy, never the original: the line says so when the staging folder is on another device, and a second line when the
 * rename found it across (two mounts of one filesystem).
 */
function stage(entry: MoveEntry, plan: MovePlan, steps: Steps, { io }: MoveDeps, startedAt: number): number {
  const across = io.lstatSync(plan.legacy).dev !== io.lstatSync(stagingOf(plan, entry.kind)).dev
  steps.add({ did: 'stage', entry: entry.name, copied: across })
  const { copied, bytes } = stageEntry(entry, plan, io, startedAt)
  if (copied !== across) steps.add({ did: 'stage', entry: entry.name, copied })
  return bytes
}

/** Steps 10 and 11: the bridge, then what the move kept until now goes, the journal last. A failure leaves the journal for the next start. */
function complete(journal: Journal, steps: Steps, oldDataDir: string, bytesCopied: number, deps: MoveDeps): MoveOutcome {
  const { plan, done } = journal, { io } = deps
  try {
    const panes = done.flatMap((step) => step.did === 'pane' ? [step.id] : [])
    if (!done.some((step) => step.did === 'bridge')) {
      writeBridge(plan.state, { version: 1, movedAt: deps.procNow(), oldHome: plan.legacy, oldDataDir, oldTag: journal.oldTag, newTag: journal.newTag, panes })
      makeRealFolders(plan.legacy)
      steps.add({ did: 'bridge' })
    }
    for (const entry of plan.entries) if (!entry.known) deps.log(`home move: unknown entry ${entry.name} · moved to data`)
    dropOriginals(plan, io)
    // Set aside while staged: in its root now.
    const roots = ROOTS.map((root) => [stagingOf(plan, root), plan[root]] as const)
    for (const step of done) if (step.did === 'aside') dropAside({ ...step, aside: rebase(step.aside, roots) })
    // The record of a start that waited, or failed, before: the bridge holds nothing of the move's.
    const record = join(plan.legacy, OWN_FILES.record)
    for (const path of [draftOf(record), record]) io.rmSync(path, { force: true })
    const outcome = { state: 'bridged', entries: plan.entries.length, bytesCopied, panes: panes.length } as const
    writeMoveRecord(plan.state, { version: 1, ...outcome, oldProcesses: 0, at: deps.now() })
    forget(plan.legacy, io)
    return outcome
  } catch (error) {
    // Committed: nothing is undone.
    return failed(plan.state, error, deps)
  }
}

/**
 * Undoes [journal]'s steps in reverse, each whatever another's undo threw, so as much as can be is put back; the journal
 * goes only when all were. Returns the first failure, null when none.
 */
function rollBack(journal: Journal, deps: MoveDeps): unknown {
  const { plan } = journal, { io } = deps
  let failure: unknown = null
  const undo = (step: () => void): void => {
    try {
      step()
    } catch (error) {
      failure ??= error
    }
  }
  // A rollback that went on past a step it could not undo put the entries back: what the journal names staged is in
  // ~/.harness now.
  const back = (path: string): string => rebase(path, plan.entries.map((entry) => [entry.staged, entry.from]))
  for (const done of [...journal.done].reverse()) {
    // An entry with two lines is put back by its last, and the first then finds nothing to do.
    if (done.did === 'stage') undo(() => unstageEntry(plan.entries.find((entry) => entry.name === done.entry)!, done.copied, io))
    else if (done.did === 'commit') undo(() => uncommitRoot(plan, done.root, io))
    else if (done.did === 'pane') deps.tmux.tag([done.id], journal.oldTag)
    else if (done.did === 'file') undo(() => restoreChanged(there(done.path, io) ? done : { ...done, path: back(done.path) }, io))
    else if (done.did === 'aside') undo(() => restoreAside(there(done.aside, io) ? done : { ...done, path: back(done.path), aside: back(done.aside) }))
    else undo(() => restoreOutside(done, deps.run))
  }
  // Made by the preflight and emptied by the undo; what something else put in one stays, and holds the next move.
  for (const root of ROOTS) {
    undo(() => {
      if (there(stagingOf(plan, root), io) && io.readdirSync(stagingOf(plan, root)).length === 0) io.rmSync(stagingOf(plan, root), { recursive: true })
    })
  }
  if (failure === null) forget(plan.legacy, io)
  return failure
}

/** A file's bytes back, unless it holds them still: a failure between its journal line and its write changed nothing, and may fail again. */
function restoreChanged(done: Extract<Done, { did: 'file' }>, io: Io): void {
  const now = there(done.path, io) ? io.readFileSync(done.path) : null
  const before = done.before === null ? null : Buffer.from(done.before, 'base64')
  if (now === null ? before === null : before !== null && now.equals(before)) return
  restoreFile(done)
}

/** The journal goes last, its draft (a crash mid-write) just before: either would keep ~/.harness from reading as the bridge. */
function forget(legacy: string, io: Io): void {
  const journal = join(legacy, OWN_FILES.journal)
  io.rmSync(draftOf(journal), { force: true })
  io.rmSync(journal, { force: true })
}

/** The outcome of a move that did not finish, and its record in the state root the rule reads now. */
function failed(folder: string, error: unknown, deps: MoveDeps): MoveOutcome {
  const reason = reasonOf(error), at = deps.now()
  writeMoveRecord(folder, { version: 1, state: 'failed', reason, entries: 0, bytesCopied: 0, panes: 0, oldProcesses: 0, at, failedAt: at })
  return { state: 'failed', reason }
}

function reasonOf(error: unknown): Reason {
  const { reason, code } = error as { reason?: Reason; code?: string }
  if (reason) return reason
  if (code === 'ENOSPC') return 'no-space'
  return code === 'EACCES' || code === 'EPERM' ? 'permission' : 'io'
}

/** The daemon's data folder before the move: an override's, or the tree's own. */
const dataDirOf = (plan: MovePlan, env: NodeJS.ProcessEnv): string => resolve(env.ADAPTER_DATA_DIR || join(plan.legacy, 'cli', 'data'))

/** [path], under the first `from` of [places] it is in, spelled under that place's `to`; a path in none as it is. */
function rebase(path: string, places: readonly (readonly [from: string, to: string])[]): string {
  const place = places.find(([from]) => path === from || path.startsWith(`${from}/`))
  return place ? place[1] + path.slice(place[0].length) : path
}

/**
 * The files outside the tree that name it: the launchers where the installers put them (config/env.ts HARNESS_BIN_DIR),
 * the user unit where systemd reads it first (harnessd/platform.ts), and the log the unit writes when it is this install's.
 */
function outside(home: string, env: NodeJS.ProcessEnv, oldDataDir: string) {
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config')
  return { binDir: env.HARNESS_BIN_DIR || join(home, '.local', 'bin'), unitFile: join(config, 'systemd', 'user', 'harnessd.service'), oldLogFile: join(oldDataDir, 'harness.log'), env }
}
