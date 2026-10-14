import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { prepareNativeHookArtifact } from './nativeHookArtifact.js'
import { HookPreparationHeld } from './nativeHookFiles.js'

let root: string
const header = (darwin = true) => `#!/usr/bin/env node\n// harness-native-hook-protocol:1\n// harness-native-hook-darwin:${darwin ? 1 : 0}\n// fixture\n`
const file = (path: string, content = header()) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, { mode: 0o600 }); return path }
const inspect = (module: string, entry = '', platform: NodeJS.Platform = 'linux') => prepareNativeHookArtifact(pathToFileURL(module).href, entry, platform)
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'native-artifact-proof-'))) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

it.each(['release', 'lean', 'source', 'per-file'])('selects generated code for the %s layout without using the raw compatibility script', layout => {
  const module = join(root, layout === 'release' ? 'package/cli.js' : layout === 'lean' ? 'data/lean/hash/core.mjs'
    : `app/${layout === 'source' ? 'src' : 'dist'}/engines/kit/notifyHooks.js`)
  const artifact = file(join(root, layout === 'release' || layout === 'lean' ? 'package/notify.mjs' : 'app/dist/notify.mjs'))
  file(join(root, 'app/hook/notify.mjs'), '// legacy')
  let selected!: ReturnType<typeof inspect>
  expect(() => { selected = inspect(module, layout === 'lean' ? join(root, 'package/cli.js') : '') }).not.toThrow()
  expect(selected.path).toBe(artifact)
  expect(selected.proof.files).toHaveLength(1)
  expect(selected.proof.files[0]).toMatchObject({ file: artifact, target: artifact })
  expect(selected.proof.current()).toBe(true)
})

it('holds a missing artifact at call time and can prepare it after it is built', () => {
  const module = join(root, 'package/cli.js')
  expect(() => inspect(module)).toThrow(HookPreparationHeld)
  expect(() => inspect(module)).toThrow(/missing/)
  file(join(root, 'package/notify.mjs'))
  expect(inspect(module).proof.current()).toBe(true)
})

it.each(['old script', 'wrong protocol', 'unmarked', 'directory', 'writable', 'oversized'])('holds a %s without falling through to another package', failure => {
  const module = join(root, 'package/cli.js'), path = join(root, 'package/notify.mjs')
  file(join(root, 'alternate/notify.mjs'))
  if (failure === 'directory') mkdirSync(path, { recursive: true })
  else {
    file(path, failure === 'oversized' ? header() + ' '.repeat(4 * 1024 * 1024)
      : failure === 'wrong protocol' ? header().replace('protocol:1', 'protocol:2')
        : failure === 'old script' || failure === 'unmarked' ? '#!/usr/bin/env node\n// legacy\n' : header())
    if (failure === 'writable') chmodSync(path, 0o666)
  }
  expect(() => inspect(module, join(root, 'alternate/cli.js'))).toThrow(HookPreparationHeld)
})

it('requires the pinned helper on macOS but permits the same helperless artifact on Linux', () => {
  const module = join(root, 'package/cli.js'), artifact = file(join(root, 'package/notify.mjs'), header(false))
  expect(() => inspect(module, '', 'darwin')).toThrow(/pinned macOS process helper/)
  expect(inspect(module).path).toBe(artifact)
  writeFileSync(artifact, header())
  expect(inspect(module, '', 'darwin').proof.current()).toBe(true)
  expect(() => inspect(module, '', 'win32')).toThrow(/platform/)
})

it('reads the exact capability declaration without crediting a contradictory later comment', () => {
  const module = join(root, 'package/cli.js')
  file(join(root, 'package/notify.mjs'), header(false) + '// harness-native-hook-darwin:1\n')
  expect(() => inspect(module, '', 'darwin')).toThrow(/pinned macOS process helper/)
})

it.each(['high bit', 'BOM', 'unfinished'])('does not reinterpret a %s header as the native protocol', problem => {
  const module = join(root, 'package/cli.js'), artifact = file(join(root, 'package/notify.mjs'))
  const bytes = Buffer.from(header())
  if (problem === 'high bit') bytes[bytes.indexOf('protocol')] |= 0x80
  writeFileSync(artifact, problem === 'BOM' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
    : problem === 'unfinished' ? bytes.subarray(0, bytes.indexOf('darwin:') + 8) : bytes)
  expect(() => inspect(module)).toThrow(HookPreparationHeld)
})

it.each(['content', 'replacement', 'mode', 'removed', 'alias'])('revokes the original dependency when its %s changes', change => {
  const module = join(root, 'package/cli.js'), path = file(join(root, 'package/notify.mjs'))
  const proof = inspect(module)
  if (change === 'content') writeFileSync(path, '// old client')
  if (change === 'mode') chmodSync(path, 0o666)
  if (change === 'removed') rmSync(path)
  if (change === 'replacement') renameSync(file(join(root, 'replacement'), readFileSync(path, 'utf8')), path)
  if (change === 'alias') { rmSync(path); symlinkSync(file(join(root, 'aliased')), path) }
  expect(proof.proof.current()).toBe(false)
  expect(proof.verify).toThrow(HookPreparationHeld)
})

it('pins an existing package alias to its original physical artifact', () => {
  const module = join(root, 'alias/cli.js')
  file(join(root, 'first/notify.mjs')); file(join(root, 'second/notify.mjs'))
  symlinkSync(join(root, 'first'), join(root, 'alias'))
  const proof = inspect(module)
  expect(proof.proof.files[0].target).toBe(join(root, 'first/notify.mjs'))
  rmSync(join(root, 'alias')); symlinkSync(join(root, 'second'), join(root, 'alias'))
  expect(proof.proof.current()).toBe(false)
})
