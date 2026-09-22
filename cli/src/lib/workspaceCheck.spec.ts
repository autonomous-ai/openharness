import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceMissing } from './workspaceCheck.js'

describe('workspaceMissing', () => {
  it('accepts a directory that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ws-'))
    try { expect(workspaceMissing(dir)).toBeNull() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('is not a refusal for a row with no folder on record', () => {
    expect(workspaceMissing(null)).toBeNull()
    expect(workspaceMissing(undefined)).toBeNull()
    expect(workspaceMissing('')).toBeNull()
  })
  it('refuses a folder that is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ws-'))
    rmSync(dir, { recursive: true, force: true })
    expect(workspaceMissing(dir)).toEqual({ ok: false, error: 'CWD_NOT_FOUND', detail: 'The saved project folder is no longer available.' })
  })
  it('refuses a path that is a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ws-'))
    const file = join(dir, 'f')
    writeFileSync(file, '')
    try { expect(workspaceMissing(file)?.error).toBe('CWD_NOT_FOUND') } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
