/**
 * A temporary folder for each Vitest worker of this run, set before anything asks for one (vitest.setup.ts runs next).
 *
 * The native evidence readers hold a directory listing when any ancestor of the folder they list changes
 * while they list it (engines/kit/nativeFiles.ts): an ancestor moved away and back around opendir looks
 * exactly like that, so the hold is deliberate. Every spec's fixtures sit under os.tmpdir(). With one
 * temporary folder for the whole run, any other worker's mkdtemp or rm there changed an ancestor of every
 * fixture, and the listing a spec was waiting on came back held instead. On CI's Linux shards that failed
 * 2 of 3 PR runs on 2026-10-11, in whichever spec was listing at the time: nativeInstall wrote no claim
 * (ENOENT on claims/00000000.json), transcriptBindings and agentHandoff read "a binding directory or
 * ancestor changed during enumeration". A worker runs its files one at a time, so a folder of its own
 * changes only under the spec that is running. The folder names its run too (src/__fixtures__/vitestRun.ts): runs going at
 * once, as several gates on one Mac do, shared vw1, vw2… before, and changed each other's ancestors.
 *
 * The name is short on purpose: vitest.setup.ts puts the daemon's data folder, which holds its Unix socket,
 * in here, a socket's path has 96 bytes (lib/localSocket.ts), and macOS's temporary folder takes 48. A run's
 * name is its process id in base 36: at most 4 characters on macOS, whose process ids stop at 99,999.
 * The end-to-end suite runs one file at a time, with its own socket budget, and does not load this.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = process.env.HARNESS_TEST_RUN
// Without a name, every run would share this folder again.
if (!run) throw new Error('vitest.tmpdir.ts needs src/__fixtures__/vitestRun.ts as the run\'s globalSetup, which names the run')
const folder = join(tmpdir(), `${run}-${process.env.VITEST_POOL_ID ?? process.pid}`)
mkdirSync(folder, { recursive: true, mode: 0o700 })
process.env.TMPDIR = folder
