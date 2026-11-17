/** The entry gives helper discovery the master's verified CLI before any service module loads. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LEAN_CORE_SCRIPT_ENV } from './harnessd/protocol.js'

const observed = vi.hoisted(() => vi.fn())
let directory: string, argv: string[], metadata: string | undefined
beforeEach(() => {
  vi.resetModules(); observed.mockClear()
  directory = mkdtempSync(join(tmpdir(), 'lean-identity-'))
  writeFileSync(join(directory, 'notify.mjs'), '// frozen bundle helper')
  argv = process.argv; metadata = process.env[LEAN_CORE_SCRIPT_ENV]
  vi.doMock('./serviceProcess.js', async () => {
    const { HOOK_SCRIPT } = await import('./engines/kit/hookScript.js')
    const argv = [...process.argv], metadata = process.env.HARNESSD_CORE_SCRIPT
    return { startServiceProcess: (name: string) => observed({ role: name, argv, metadata, helper: HOOK_SCRIPT }) }
  })
  vi.doMock('./coreProcess.js', async () => {
    const { HOOK_SCRIPT } = await import('./engines/kit/hookScript.js')
    const argv = [...process.argv], metadata = process.env.HARNESSD_CORE_SCRIPT
    return { startCoreProcess: (cli: string) => observed({ role: 'core', cli, argv, metadata, helper: HOOK_SCRIPT }) }
  })
})
afterEach(() => {
  vi.doUnmock('./serviceProcess.js'); vi.doUnmock('./coreProcess.js')
  process.argv = argv
  if (metadata === undefined) delete process.env[LEAN_CORE_SCRIPT_ENV]
  else process.env[LEAN_CORE_SCRIPT_ENV] = metadata
  rmSync(directory, { recursive: true, force: true })
})
it.each(['engineSetup', 'search'])('resolves the frozen CLI helper before loading %s and preserves its role', async role => {
  const cli = join(directory, 'cli.js')
  process.argv = [process.execPath, '/fixture/extracted/entry.mjs', '__service', role]
  process.env[LEAN_CORE_SCRIPT_ENV] = cli
  await import('./leanEntry.js')
  expect(observed).toHaveBeenCalledExactlyOnceWith({ role,
    argv: [process.execPath, cli, '__service', role], metadata: undefined, helper: join(directory, 'notify.mjs') })
})
it('preserves a service started by an old master without original-CLI metadata', async () => {
  process.argv = [process.execPath, '/fixture/old/entry.mjs', '__service', 'search']
  delete process.env[LEAN_CORE_SCRIPT_ENV]
  await import('./leanEntry.js')
  expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ role: 'search', argv: process.argv, metadata: undefined }))
})
it('keeps core dispatch and helper identity on the original CLI', async () => {
  const cli = join(directory, 'cli.js')
  process.argv = [process.execPath, '/fixture/extracted/core.mjs', '__run']
  process.env[LEAN_CORE_SCRIPT_ENV] = cli
  await import('./leanCoreEntry.js')
  expect(observed).toHaveBeenCalledExactlyOnceWith({ role: 'core', cli,
    argv: [process.execPath, cli, '__run'], metadata: undefined, helper: join(directory, 'notify.mjs') })
})
