import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const BUILDER = fileURLToPath(new URL('../../scripts/build-process-images.py', import.meta.url))
let built: string | undefined

/** The private Darwin process-image helper a native macOS test stubs in as `__DARWIN_PROCESS_IMAGES__`: the verified
 *  artifact HARNESS_PROCESS_IMAGES_ARTIFACT names (the release's), else one built once from this checkout by the
 *  release's own builder. Agent Macs run `npm run test:resume` with no artifact set, so its native tests failed there
 *  while Linux CI, which skips them, passed (task #4405). Building needs Xcode's command line tools, as a release does. */
export function darwinProcessImages(): string {
  const given = process.env.HARNESS_PROCESS_IMAGES_ARTIFACT
  if (given) return readFileSync(given, 'utf8')
  if (built) return built
  const dir = mkdtempSync(join(tmpdir(), 'harness-process-images-'))
  try {
    const output = join(dir, 'process-images.json')
    try {
      execFileSync('python3', [BUILDER, '--output', output], { stdio: 'pipe', timeout: 120_000 })
    } catch (error) {
      const detail = (error as { stderr?: Buffer }).stderr?.toString().trim() || String(error)
      throw new Error(`Building the Darwin process-image helper for native tests needs Xcode's command line tools: ${detail}`)
    }
    return built = readFileSync(output, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
