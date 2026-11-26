// Starts the pinned macOS /dev watch helper (native/darwin-dev-watch.c), which prints `dev` each time a /dev node is
// made or removed. Only serial.ts loads this file, by dynamic import(): nativeProcessImages.ts brings the CLI's config
// with it, and a static import would pull that config into the real-PTY fixtures bundled from serial.ts.
import { spawn, type ChildProcess } from 'node:child_process'
import { env } from '../config/env.js'
import { prepareProcessImageHelper, type ProcessImageArtifact } from '../lib/nativeProcessImages.js'

const unavailable = () => Object.assign(new Error('the /dev watch helper is unavailable'), { code: 'HELPER_UNAVAILABLE' })

/** Extracts the helper `source` (the build's define) pins, then spawns it watching. A spawn failure arrives as the
 * child's 'error' event. The helper reads no environment and writes nothing on stderr. */
export async function startDevWatch(source: string): Promise<ChildProcess> {
  let artifact: ProcessImageArtifact
  try { artifact = JSON.parse(source) } catch { throw unavailable() }
  const path = await prepareProcessImageHelper(artifact, env.ADAPTER_RUNTIME_DIR, 'dev-watch')
  if (!path) throw unavailable()
  return spawn(path, ['--watch'], { stdio: ['pipe', 'pipe', 'ignore'], env: {} })
}
