import { buildSync } from 'esbuild'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { directNodeEntryDigest, probeNativeProcessControl } from './nativeProcessControlProbe.js'

const host = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: host.exec }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platform); host.exec.mockReset() })

it.each([
  ['node', '/fixture/main.js'], ['agent', '/fixture/main.js'], ['/fixture/with space/node', '--no-warnings', '--', '/fixture/main.js'],
].map(argv => ({ argv })))('digests only a direct entry from native argv boundaries %#', ({ argv }) => {
  expect(directNodeEntryDigest('/fixture/node', argv)).toBe(createHash('sha256').update('/fixture/main.js').digest('hex'))
})
it.each([
  [], ['node'], ['', 'node', '/fixture/main.js'], ['node /fixture/node', '/fixture/main.js'],
  ['node', '-e', '/fixture/main.js'], ['node', '--print', '/fixture/main.js'], ['node', '--require', '/fixture/main.js'],
  ['node', '/fixture/main.js', ''], ['node', 'relative.js'], ['node', '/fixture/main\0.js'],
  ['node', ...Array(8).fill('--no-warnings'), '/fixture/main.js'],
].map(argv => ({ argv })))('omits uncertain or unsupported direct entry evidence %#', ({ argv }) => {
  expect(directNodeEntryDigest('/fixture/node', argv)).toBeUndefined()
})
it('does not classify a shell image through Node-looking argv', () => {
  expect(directNodeEntryDigest('/bin/bash', ['node', '/fixture/main.js'])).toBeUndefined()
})

it('bundles the shared hook probes without daemon configuration, state migration or session modules', () => {
  const result = buildSync({ entryPoints: ['src/lib/nativeProcessControlProbe.ts', 'src/lib/nativeProcessImageArtifact.ts'],
    outdir: 'unused-fixture-output', bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  expect(Object.keys(result.metafile.inputs).sort()).toEqual([
    'src/engines/kit/identityScan.ts', 'src/engines/kit/nativeEvidence.ts', 'src/lib/childLocale.ts',
    'src/lib/nativeProcessControlProbe.ts', 'src/lib/nativeProcessImageArtifact.ts',
  ])
})

it('holds a missing injected helper without selecting a daemon runtime directory or weaker probe', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const prepare = vi.fn().mockResolvedValue(null), invalidate = vi.fn()
  await expect(probeNativeProcessControl([42], 0, new NativeEvidenceBudget(), false, { prepare, invalidate }))
    .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', message: expect.stringContaining('helper is unavailable') })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(invalidate).not.toHaveBeenCalled()
  expect(host.exec).not.toHaveBeenCalled()
})

it('invalidates only the injected helper after its executable disappears', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const prepare = vi.fn().mockResolvedValue({ path: '/fixture/native-helper', key: 'fixture-key' }), invalidate = vi.fn()
  host.exec.mockImplementation((_path, _args, _options, done) => done(Object.assign(Error('fixture helper vanished'), { code: 'ENOENT' }), Buffer.alloc(0), Buffer.alloc(0)))
  await expect(probeNativeProcessControl([42], 0, new NativeEvidenceBudget(), false, { prepare, invalidate }))
    .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(host.exec.mock.calls[0].slice(0, 2)).toEqual(['/fixture/native-helper', ['--identity', expect.any(String), '0', '42']])
  expect(invalidate).toHaveBeenCalledExactlyOnceWith('fixture-key')
})
