/**
 * A temporary folder for each Vitest worker, set before anything asks for one (vitest.setup.ts runs next).
 *
 * The native evidence readers hold a directory listing when any ancestor of the folder they list changes
 * while they list it (engines/kit/nativeFiles.ts): an ancestor moved away and back around opendir looks
 * exactly like that, so the hold is deliberate. Every spec's fixtures sit under os.tmpdir(). With one
 * temporary folder for the whole run, any other worker's mkdtemp or rm there changed an ancestor of every
 * fixture, and the listing a spec was waiting on came back held instead. On CI's Linux shards that failed
 * 2 of 3 PR runs on 2026-10-11, in whichever spec was listing at the time: nativeInstall wrote no claim
 * (ENOENT on claims/00000000.json), transcriptBindings and agentHandoff read "a binding directory or
 * ancestor changed during enumeration". A worker runs its files one at a time, so a folder of its own
 * changes only under the spec that is running. It is in its run's own folder (src/__fixtures__/vitestRun.ts),
 * so a run going at the same time, as another gate on the same Mac does, never changes it either.
 *
 * The names are short on purpose: vitest.setup.ts puts the daemon's data folder, which holds its Unix socket,
 * in here, and a socket's path has 96 bytes (lib/localSocket.ts); the run's folder is in /tmp on macOS for it.
 * The end-to-end suite runs one file at a time, with its own socket budget, and does not load this.
 * On Windows os.tmpdir() reads TEMP, which this leaves alone: there each machine runs one suite at a time (windows.yml).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { inject } from 'vitest'

const root = inject('runFolder')
// Without its run's folder, every run would share one folder again.
if (!root) throw new Error('vitest.tmpdir.ts needs src/__fixtures__/vitestRun.ts as the run\'s globalSetup, which makes the run\'s folder')
const folder = join(root, `${process.env.VITEST_POOL_ID ?? process.pid}`)
mkdirSync(folder, { recursive: true, mode: 0o700 })
process.env.TMPDIR = folder
