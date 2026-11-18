/**
 * The suite's third global setup (vitest.e2e.config.ts), before the bundle is built: on macOS every daemon under test
 * gets the native process-image helper a release embeds as `__DARWIN_PROCESS_IMAGES__`. Without it every Codex native
 * read failed with "the native control helper is unavailable", the read hold was never released, and the agent-client
 * trust test waited out its 2 minutes on a Mac while it passed on Linux, which has no helper.
 *
 * The artifact HARNESS_PROCESS_IMAGES_ARTIFACT names is used as given, else one is built once by the release's builder
 * (src/testing/darwinProcessImages.ts) and named there, so `E2E_BUNDLE`'s build embeds it as a release does. A daemon
 * run from the sources loads E2E_PROCESS_IMAGES_PRELOAD, which sets the global to what the bundle build would embed,
 * checked the same way (scripts/lib/processImageBundle.mjs). A helper that cannot be built stops the run: running
 * without it would reopen this gap without a word.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { darwinProcessImages } from '../../src/testing/darwinProcessImages.js'
import { readProcessImageBundle } from '../../scripts/lib/processImageBundle.mjs'

export default function setup(): (() => void) | undefined {
  if (process.platform !== 'darwin') return undefined
  const dir = mkdtempSync(join(tmpdir(), 'harness-e2e-process-images-'))
  try {
    let artifact = process.env.HARNESS_PROCESS_IMAGES_ARTIFACT
    if (!artifact) {
      artifact = join(dir, 'process-images.json')
      writeFileSync(artifact, darwinProcessImages())
      process.env.HARNESS_PROCESS_IMAGES_ARTIFACT = artifact
    }
    const preload = join(dir, 'preload.mjs')
    writeFileSync(preload, `globalThis.__DARWIN_PROCESS_IMAGES__ = ${JSON.stringify(readProcessImageBundle({ path: artifact }))}\n`)
    // Read by every daemon the run starts from the sources (`IsolatedDaemon.start`); the workers inherit it.
    process.env.E2E_PROCESS_IMAGES_PRELOAD = preload
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return () => rmSync(dir, { recursive: true, force: true })
}
