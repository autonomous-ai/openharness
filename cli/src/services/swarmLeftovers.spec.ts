import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real rm, unless a test makes one name's fail.
const failing = new Set<string>()
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    rm: vi.fn(async (path: string, options: Parameters<typeof real.rm>[1]) => {
      if ([...failing].some((name) => path.endsWith(name))) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return real.rm(path, options)
    }),
  }
})

const { removeSwarmLeftovers, SWARM_LEFTOVERS } = await import('./swarmLeftovers.js')

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'swarm-leftovers-')) })
afterEach(() => { failing.clear(); rmSync(dataDir, { recursive: true, force: true }) })

/** Everything the Swarm wrote here, as a build before 2026-11-14 left it. */
function leftBehind(): void {
  mkdirSync(join(dataDir, 'super-tabs', 'lead-switch'), { recursive: true })
  writeFileSync(join(dataDir, 'super-tabs', `host-${'a'.repeat(32)}.json`), '{}')
  mkdirSync(join(dataDir, 'swarm-github', 'hooks'), { recursive: true })
  writeFileSync(join(dataDir, 'swarm-github', 'hooks', 'commit-msg'), '#!/bin/sh\n')
  mkdirSync(join(dataDir, 'uploads'))
  writeFileSync(join(dataDir, 'uploads', 'chat-file.png'), 'png')
  for (const name of SWARM_LEFTOVERS.filter((name) => name.includes('.') || name === 'registry-swarm-auto')) writeFileSync(join(dataDir, name), '{}')
}

describe('what the Swarm left in the data folder', () => {
  it('is deleted, every listed file and folder, and nothing else: a project it cloned is the person\'s work', async () => {
    leftBehind()
    mkdirSync(join(dataDir, 'swarm-projects', 'tab-1', '.git'), { recursive: true })
    mkdirSync(join(dataDir, 'handoff-receipts'))
    for (const name of ['registry.json', 'registry-own-modes', 'agent-names.json']) writeFileSync(join(dataDir, name), '[]')
    const log = vi.fn()
    expect(await removeSwarmLeftovers({ dataDir, log })).toBe(SWARM_LEFTOVERS.length)
    for (const name of SWARM_LEFTOVERS) expect(existsSync(join(dataDir, name)), name).toBe(false)
    for (const name of ['swarm-projects/tab-1/.git', 'handoff-receipts', 'registry.json', 'registry-own-modes', 'agent-names.json']) {
      expect(existsSync(join(dataDir, name)), name).toBe(true)
    }
    expect(log).toHaveBeenCalledExactlyOnceWith(`removed ${SWARM_LEFTOVERS.length} of the Swarm's files and folders from the data folder`)
  })

  it('says nothing and deletes nothing once there is nothing left', async () => {
    writeFileSync(join(dataDir, 'registry.json'), '[]')
    const log = vi.fn()
    expect(await removeSwarmLeftovers({ dataDir, log })).toBe(0)
    expect(log).not.toHaveBeenCalled()
    expect(existsSync(join(dataDir, 'registry.json'))).toBe(true)
  })

  it('deletes a link in a leftover\'s place, never what it points at', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'swarm-leftovers-elsewhere-'))
    try {
      writeFileSync(join(elsewhere, 'keep.txt'), 'mine')
      symlinkSync(elsewhere, join(dataDir, 'uploads'), 'dir')
      expect(await removeSwarmLeftovers({ dataDir, log: () => {} })).toBe(1)
      expect(existsSync(join(dataDir, 'uploads'))).toBe(false)
      expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('mine')
    } finally { rmSync(elsewhere, { recursive: true, force: true }) }
  })

  it('names one it cannot delete, deletes the rest, and leaves that one for the next start', async () => {
    leftBehind()
    failing.add('swarm-github')
    const log = vi.fn()
    expect(await removeSwarmLeftovers({ dataDir, log })).toBe(SWARM_LEFTOVERS.length - 1)
    expect(log).toHaveBeenCalledWith('could not remove swarm-github, left by the Swarm (EACCES); trying again at the next start')
    expect(existsSync(join(dataDir, 'swarm-github'))).toBe(true)
    expect(existsSync(join(dataDir, 'super-tabs'))).toBe(false)
    failing.clear()
    expect(await removeSwarmLeftovers({ dataDir, log })).toBe(1)
    expect(existsSync(join(dataDir, 'swarm-github'))).toBe(false)
  })

  it('names a failure that has no code as unknown', async () => {
    mkdirSync(join(dataDir, 'uploads'))
    failing.add('uploads')
    const { rm } = await import('node:fs/promises')
    vi.mocked(rm).mockImplementationOnce(async () => { throw new Error('odd') })
    const log = vi.fn()
    expect(await removeSwarmLeftovers({ dataDir, log })).toBe(0)
    expect(log).toHaveBeenCalledWith('could not remove uploads, left by the Swarm (unknown); trying again at the next start')
  })
})
