import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('builds the ordinary CLI without either optional feature implementation', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['src/cli.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm', metafile: true,
    external: ['bufferutil', 'utf-8-validate'], logLevel: 'silent',
  })
  expect(Object.keys(result.metafile!.inputs).filter(path =>
    /(?:^|\/)companions\/|src\/(?:pair|memory)\//.test(path))).toEqual([])
  for (const name of ['build.mjs', 'build-bundle.mjs']) {
    const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    expect(source).not.toMatch(/(?:memory|plate)WorkerSource|__(?:MEMORY|PLATE)_WORKER__/)
  }
})

it('keeps the default native hook free of companion context and memory receipts', () => {
  const source = readFileSync(new URL('../hook/notify.mjs', import.meta.url), 'utf8')
  expect(source).not.toMatch(/memory-emitted|memoryReceiptId|additionalContext|acknowledgeMemoryOutput/)
})
