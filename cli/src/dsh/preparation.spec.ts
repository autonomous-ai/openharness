import * as fs from 'node:fs'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dshPreparations } from './preparation.js'

// Spy-able, for a removal that fails.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

const roots: string[] = []
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-preparation-'))
  roots.push(root)
  const workspace = join(root, 'workspace'), directory = join(root, 'receipts')
  mkdirSync(workspace)
  return { root, workspace, directory, prepare: dshPreparations(directory) }
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('durable Store workspace preparation', () => {
  it('reuses confirmed initialization after a lost reply, but revalidates runtime inputs each time', async () => {
    const { workspace, directory, prepare } = setup()
    const init = vi.fn(async () => ({ created: ['template'], warnings: [] }))
    expect(await prepare(workspace, { init: 'first' }, init, true)).toEqual({ created: ['template'], warnings: [] })
    expect(await dshPreparations(directory)(workspace, { init: 'first' }, init, true)).toEqual({ created: ['template'], warnings: [] })
    expect(init).toHaveBeenCalledOnce()
    const runtime = vi.fn(async () => ({ env: {} }))
    await prepare(workspace, { runtime: 'first' }, runtime)
    await prepare(workspace, { runtime: 'first' }, runtime)
    await prepare(workspace, { runtime: 'first', account: 'new' }, runtime)
    expect(runtime).toHaveBeenCalledTimes(3)
    expect(readdirSync(directory).filter(file => file.endsWith('.pending'))).toEqual([])
  })
  it('fences one canonical workspace across aliases and new request labels until the writer finishes', async () => {
    const { root, workspace, directory, prepare } = setup()
    const alias = join(root, 'alias'); symlinkSync(workspace, alias)
    let finish!: (value: string) => void
    const run = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const first = prepare(workspace, { key: 'one' }, run)
    const repeat = prepare(alias, { key: 'one' }, run)
    await expect(prepare(alias, { key: 'two' }, run)).rejects.toThrow('still running')
    await expect(dshPreparations(directory)(workspace, { key: 'new-after-crash' }, run)).rejects.toThrow('unconfirmed')
    finish('done')
    expect(await first).toBe('done'); expect(await repeat).toBe('done')
    expect(run).toHaveBeenCalledOnce()
  })
  it('never retries uncertain or corrupt intent, even with another engine/package/key', async () => {
    const { workspace, directory, prepare } = setup()
    const broken = vi.fn(async () => { writeFileSync(join(workspace, 'user-content'), 'preserve'); throw new Error('lost writer') })
    await expect(prepare(workspace, { key: 'one' }, broken)).rejects.toThrow('unconfirmed')
    const later = vi.fn(async () => 'must not run')
    await expect(dshPreparations(directory)(workspace, { key: 'two', package: 'other' }, later)).rejects.toThrow('unconfirmed')
    const pending = readdirSync(directory).find(file => file.endsWith('.pending'))!
    writeFileSync(join(directory, pending), '{')
    await expect(prepare(workspace, {}, later)).rejects.toThrow('unconfirmed')
    expect(later).not.toHaveBeenCalled()
    expect(readdirSync(workspace)).toEqual(['user-content'])
  })
  it('confirms an outcome whose written receipt\'s temporary cannot be removed', async () => {
    const { workspace, directory, prepare } = setup()
    const rm = fs.rmSync, unlink = fs.unlinkSync
    // What Windows answers to the removal of a file another program still holds.
    const busy = () => Object.assign(new Error('EBUSY: fixture'), { code: 'EBUSY' })
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => { if (String(path).endsWith('.tmp')) throw busy(); rm(path, options) })
    vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => { if (String(path).endsWith('.tmp')) throw busy(); unlink(path) })
    expect(await prepare(workspace, { key: 'one' }, async () => 'done', true)).toBe('done')
    expect(readdirSync(directory).filter(file => file.endsWith('.pending'))).toEqual([])
  })
  it('does not replay old initialization into a newly recreated folder at the same path', async () => {
    const { workspace, prepare } = setup()
    const init = vi.fn(async () => 'initialized')
    await prepare(workspace, { key: 'same' }, init, true)
    rmSync(workspace, { recursive: true }); mkdirSync(workspace)
    await prepare(workspace, { key: 'same' }, init, true)
    expect(init).toHaveBeenCalledTimes(2)
  })
  it('refuses before writing when the resource or receipt directory cannot be trusted', async () => {
    const { root, workspace, directory } = setup()
    const run = vi.fn(async () => 'written')
    await expect(dshPreparations(directory)(join(root, 'missing'), {}, run)).rejects.toThrow('cannot safely record')
    mkdirSync(directory, { mode: 0o777 })
    const { chmodSync } = await import('node:fs'); chmodSync(directory, 0o777)
    await expect(dshPreparations(directory)(workspace, {}, run)).rejects.toThrow('cannot safely record')
    expect(run).not.toHaveBeenCalled()
  })
})
