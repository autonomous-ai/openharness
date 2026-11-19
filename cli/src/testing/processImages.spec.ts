/**
 * The process-image helper every daemon under test runs with on macOS (e2e/harness/processImages.ts), as a release
 * embeds it. Every artifact here is made up, with this checkout's build inputs: nothing is built, and the one program
 * run is this Node with the preload the setup writes.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as testNode.spec.ts loads its setup.
const { default: setup, bundledProcessImages } = await import('../../e2e/harness/processImages.js' as string) as {
  default: () => (() => void) | undefined, bundledProcessImages: (bundle: string) => string | undefined }

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const HELPER = Buffer.alloc(64, 7)
/** An artifact as the release's builder writes it, for made-up helper bytes. */
const artifact = (inputs: Record<string, unknown> = {}) => JSON.stringify({
  schema: 1, platform: 'darwin', architectures: ['arm64', 'x86_64'],
  sourceSha256: sha256(readFileSync(join(CLI_ROOT, 'native/darwin-process-images.c'))),
  builderSha256: sha256(readFileSync(join(CLI_ROOT, 'scripts/build-process-images.py'))),
  sha256: sha256(HELPER), size: HELPER.length, base64: HELPER.toString('base64'), ...inputs,
})

describe.runIf(process.platform === 'darwin')('the helper of the daemons under test', () => {
  let base = '', tmp = ''
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'process-images-')))
    tmp = join(base, 'tmp')
    mkdirSync(tmp)
    // The temporary folder behind a link, as macOS's is.
    symlinkSync(tmp, join(base, 't'))
    vi.stubEnv('TMPDIR', join(base, 't'))
    // Stubbed first, so that what the setup sets is taken out again.
    vi.stubEnv('E2E_PROCESS_IMAGES_PRELOAD', undefined)
  })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }) })

  it('gives a daemon from the sources the helper named, as a bundle embeds it, and leaves no folder after the run', () => {
    const given = join(base, 'given.json')
    writeFileSync(given, artifact())
    vi.stubEnv('HARNESS_PROCESS_IMAGES_ARTIFACT', given)
    const teardown = setup()!
    const preload = process.env.E2E_PROCESS_IMAGES_PRELOAD!
    const seen = spawnSync(process.execPath, ['--import', preload, '-e', 'process.stdout.write(globalThis.__DARWIN_PROCESS_IMAGES__)'], { encoding: 'utf8' })
    expect(JSON.parse(seen.stdout)).toEqual({ schema: 1, size: HELPER.length, sha256: sha256(HELPER), base64: HELPER.toString('base64') })
    expect(process.env.HARNESS_PROCESS_IMAGES_ARTIFACT).toBe(given)
    teardown()
    expect(readdirSync(tmp)).toEqual([])
  })

  // Before, a stale HARNESS_PROCESS_IMAGES_ARTIFACT exported on a Mac stopped every end-to-end run with only "Native
  // process-image build inputs do not match", or a bare ENOENT, and nothing said which setting to unset.
  it.each([
    ['an older checkout\'s', (file: string) => writeFileSync(file, artifact({ sourceSha256: sha256(Buffer.from('an older helper')) }))],
    ['a deleted', () => {}],
  ])('stops the run by the setting\'s name when it names %s helper, and leaves no folder', (_, place) => {
    const given = join(base, 'given.json')
    place(given)
    vi.stubEnv('HARNESS_PROCESS_IMAGES_ARTIFACT', given)
    expect(() => setup()).toThrow(/^HARNESS_PROCESS_IMAGES_ARTIFACT names a helper this checkout cannot use: /)
    expect([readdirSync(tmp), process.env.E2E_PROCESS_IMAGES_PRELOAD]).toEqual([[], undefined])
  })
})

// The perf report names the helper of the bundle it measured (e2e/perf.e2e.ts). Before, it named the helper the run
// was given, and a baseline from a release, whose helper another toolchain built, read as carrying none.
describe('the helper a bundle carries', () => {
  // As build-bundle.mjs defines it, through the same printer.
  const bundle = (define: string) => transformSync('export const images = __DARWIN_PROCESS_IMAGES__',
    { define: { __DARWIN_PROCESS_IMAGES__: define }, format: 'esm', minify: true }).code

  it('is the one embedded, whichever it is', () => {
    const embedded = JSON.stringify({ schema: 1, size: HELPER.length, sha256: sha256(HELPER), base64: HELPER.toString('base64') })
    expect(bundledProcessImages(bundle(JSON.stringify(embedded)))).toBe(sha256(HELPER))
  })

  it('is none in a bundle built without one', () => {
    expect(bundledProcessImages(bundle('undefined'))).toBeUndefined()
  })
})
