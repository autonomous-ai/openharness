/**
 * `E2E_ARTIFACTS_DIR=<folder>`: keep the whole log of every daemon a failing test ran, as files, for
 * CI to upload (.github/workflows/cli-e2e.yml). A failing test prints the tail of a daemon's log to the
 * console (`onTestFailed` in each file), which is what a developer at the terminal reads; a CI run has
 * eight runners' worth of console and no machine to look at afterwards, and the line that explains a
 * failure is often hundreds of lines above that tail.
 *
 * Every daemon writes its output here as it goes (`IsolatedDaemon` calls `artifactLog`), into the
 * folder of the test running at that moment: `<dir>/<file>/<test>/<daemon>.log`. Output written while
 * no test runs (a `beforeAll`'s daemon starting) goes to `<dir>/<file>/outside-tests/`. Once a test has
 * finished, after its own `afterEach` has closed its daemons, its folder is removed if it passed; the
 * file's `outside-tests` folder is removed at the end of the file if every test in it passed. What is
 * left is the failures, and only those are uploaded. Written synchronously, so a worker that dies or a
 * test that times out leaves everything up to that moment.
 *
 * A vitest setup file (vitest.e2e.config.ts): its hooks are the first registered, so they run around
 * every test's own.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, beforeEach, expect } from 'vitest'

const ROOT = process.env.E2E_ARTIFACTS_DIR || null

/** A test's name as a folder: what a person can still read, and nothing a path cannot hold. */
export function folderName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return (safe || 'unnamed').slice(0, 120)
}

/** The folder of the test file running in this worker ([path], or the one vitest says is running). */
function fileFolder(path = expect.getState().testPath): string | null {
  if (!ROOT || !path) return null
  return join(ROOT, folderName(basename(path).replace(/\.e2e\.ts$/, '')))
}

let current: string | null = null

/** Whether this run keeps artifacts at all: callers skip work whose only use is an artifact. */
export function artifactsEnabled(): boolean {
  return ROOT !== null
}

/** Append [text] to `<the running test's folder>/<name>`. A no-op unless E2E_ARTIFACTS_DIR is set. */
export function artifactLog(name: string, text: string): void {
  const folder = current ?? (fileFolder() && join(fileFolder()!, 'outside-tests'))
  if (!folder || !text) return
  try {
    mkdirSync(folder, { recursive: true })
    appendFileSync(join(folder, folderName(name)), text)
  } catch { /* a full or missing disk must not fail the test this only records */ }
}

if (ROOT) {
  let failed = false
  beforeEach((context) => {
    // A test skipped from inside (`ctx.skip()`) never calls its onTestFinished: nothing it wrote failed.
    if (current) rmSync(current, { recursive: true, force: true })
    const file = fileFolder(context.task.file.filepath)
    if (!file) return
    const folder = join(file, folderName(context.task.fullTestName ?? context.task.name))
    current = folder
    // After every afterEach, so a daemon closed in one has said all it will.
    context.onTestFinished(() => {
      if (context.task.result?.state === 'fail') failed = true
      else rmSync(folder, { recursive: true, force: true })
      if (current === folder) current = null
    })
  })
  afterAll(() => {
    const file = fileFolder()
    if (!file) return
    if (!failed) rmSync(join(file, 'outside-tests'), { recursive: true, force: true })
    try { if (!readdirSync(file).length) rmSync(file, { recursive: true, force: true }) } catch { /* never made */ }
  })
}
