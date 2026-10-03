import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll } from 'vitest'

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Build the real CLI once per test file, then start a fresh Node process for each command.
 * This avoids reloading the entire TypeScript graph through tsx on every invocation. Each suite
 * owns its temporary bundle, so concurrent suites/watch runs cannot reuse stale dist output.
 * Auth, devices and Grid command fixtures do not need embedded release assets; release bundle
 * integration remains responsible for the registry, built-in harnesses, workers and hook payload.
 */
export function useBundledCli(): () => string {
  let directory: string | undefined
  let executable: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harness-command-bundle-'))
    const output = join(directory, 'cli.mjs')
    const { version } = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')) as { version: string }
    await build({
      entryPoints: [join(CLI_ROOT, 'src', 'cli.ts')],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      external: ['bufferutil', 'utf-8-validate'],
      define: { __ADAPTER_VERSION__: JSON.stringify(version) },
      banner: { js: 'import { createRequire as ___cr } from "node:module"; const require = ___cr(import.meta.url);' },
      minify: true,
      keepNames: true,
      legalComments: 'eof',
      logLevel: 'silent',
    })
    executable = output
  }, 30_000)

  afterAll(async () => {
    executable = undefined
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  return () => {
    if (!executable) throw new Error('CLI fixture must finish building before it can run')
    return executable
  }
}
