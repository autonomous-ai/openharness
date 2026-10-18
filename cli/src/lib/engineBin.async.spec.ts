import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const accessGate = vi.hoisted(() => ({
  enabled: false,
  started: 0,
  releases: [] as Array<() => void>,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    access: async (...args: Parameters<typeof original.access>) => {
      if (accessGate.enabled) {
        accessGate.started += 1
        await new Promise<void>((resolve) => accessGate.releases.push(resolve))
      }
      return original.access(...args)
    },
  }
})

const { agentAliasOwner, engineBinaryOwnershipSnapshot } = await import('./engineBin.js')

const originalPath = process.env.PATH
const tempDirs: string[] = []

afterEach(() => {
  accessGate.enabled = false
  for (const release of accessGate.releases.splice(0)) release()
  accessGate.started = 0
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('asynchronous engine binary ownership', () => {
  it('yields the event loop during PATH probes without weakening agent inode ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-async-'))
    tempDirs.push(root)
    const cursorBin = join(root, 'cursor', 'bin')
    const grokBin = join(root, 'grok', 'bin')
    const cursorTarget = join(root, 'share', 'cursor-agent', 'versions', '2099.01.01', 'cursor-agent')
    const grokTarget = join(root, 'grok', 'downloads', 'renamed-grok-image')
    mkdirSync(cursorBin, { recursive: true })
    mkdirSync(grokBin, { recursive: true })
    mkdirSync(join(cursorTarget, '..'), { recursive: true })
    mkdirSync(join(grokTarget, '..'), { recursive: true })
    writeFileSync(cursorTarget, '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(grokTarget, 'grok', { mode: 0o755 })
    symlinkSync(cursorTarget, join(cursorBin, 'agent'))
    symlinkSync(cursorTarget, join(cursorBin, 'cursor-agent'))
    symlinkSync(grokTarget, join(grokBin, 'agent'))
    symlinkSync(grokTarget, join(grokBin, 'grok'))
    process.env.PATH = [grokBin, cursorBin].join(delimiter)

    accessGate.enabled = true
    let settled = false
    const snapshotPromise = engineBinaryOwnershipSnapshot().finally(() => { settled = true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(accessGate.started).toBeGreaterThan(0)
    expect(settled).toBe(false)
    accessGate.enabled = false
    for (const release of accessGate.releases.splice(0)) release()

    const snapshot = await snapshotPromise
    expect(snapshot.agentCandidates).toHaveLength(2)
    expect(agentAliasOwner([snapshot.agentCandidates[0].fileKey], snapshot)).toBe('grok')
    expect(agentAliasOwner([snapshot.agentCandidates[1].fileKey], snapshot)).toBe('cursor')
    expect(snapshot.conflictingFileKeys.size).toBe(0)
  })
})
