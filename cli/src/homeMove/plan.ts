import { posix } from 'node:path'
import { HARNESS_ENTRIES, legacyHarnessHome, xdgRoots, type HarnessRootKind } from '../config/harnessHome.js'

/**
 * One top-level name of ~/.harness: where it is, where it waits until the commit, and where it ends. One not `present`
 * at the move gets its link alone.
 */
export interface MoveEntry { name: string; kind: HarnessRootKind; known: boolean; present: boolean; from: string; staged: string; to: string }
export interface MovePlan { home: string; legacy: string; data: string; state: string; entries: MoveEntry[] }

/**
 * The move's journal, the previous bytes of the files it rewrites (journal.ts), its record, and the originals a copy
 * across filesystems keeps until the finish (stage.ts): they sit in ~/.harness while it runs, and are not Harness's to move.
 */
export const OWN_FILES = { journal: '.move.json', before: '.move-before', record: 'home-move.json', kept: '.move-old' } as const
/** Where a file of the move's is written before it is renamed into place, whole. A crash can leave one: it is the move's too. */
export const draftOf = (path: string): string => `${path}.next`
const OWN_NAMES: readonly string[] = Object.values(OWN_FILES).flatMap((name) => [name, draftOf(name)])

const known = (name: string): name is keyof typeof HARNESS_ENTRIES => Object.hasOwn(HARNESS_ENTRIES, name)

// A name the table does not know goes to data: nothing is lost.
const kindOf = (name: string): HarnessRootKind => known(name) ? HARNESS_ENTRIES[name] : 'data'

/**
 * Every top-level name of ~/.harness but the move's own files (OWN_FILES, their drafts), then every name of the table
 * not there: its link, which points nowhere until the new daemon makes it, makes an old process that writes it late
 * fail, rather than make a real folder in the bridge. An unknown name goes to data.
 */
export function planMove(home: string, env: NodeJS.ProcessEnv, names: readonly string[]): MovePlan {
  // The move runs on Linux alone: its paths are Linux's wherever this is asked.
  const legacy = legacyHarnessHome(home, 'linux')
  const roots = xdgRoots(home, env)
  const present = names.filter((name) => !OWN_NAMES.includes(name))
  const entries = [...present, ...Object.keys(HARNESS_ENTRIES).filter((name) => !present.includes(name))].map((name) => {
    const kind = kindOf(name)
    return {
      name, kind, known: known(name), present: present.includes(name),
      from: posix.join(legacy, name), staged: posix.join(`${roots[kind]}.moving`, name), to: posix.join(roots[kind], name),
    }
  })
  return { home, legacy, ...roots, entries }
}

/** An old-tree path's place after the move; any other path as it is. */
export function movedPath(plan: Pick<MovePlan, 'legacy' | 'data' | 'state'>, path: string): string {
  if (!path.startsWith(`${plan.legacy}/`)) return path
  const rest = path.slice(plan.legacy.length + 1)
  return `${plan[kindOf(rest.split('/')[0])]}/${rest}`
}
