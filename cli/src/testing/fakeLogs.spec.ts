import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installFakeGrid } from '../lib/__fixtures__/fakeGrid.js'
import { fakeCmux } from './fakeCmux.js'
import { fakePlatform } from './fakePlatform.js'

// Each fake logs a call with one append, and a spec may read the log while a call is still running: a line without
// its newline is still being written, and parsed it threw (agentBrowser.spec.ts's fake podman, 2026-11-19).
describe('a fake read while a call is still logging itself', () => {
  it('fakeCmux lists only its whole lines', () => {
    const cmux = fakeCmux()
    try {
      appendFileSync(join(dirname(cmux.binary), 'calls.jsonl'), `${JSON.stringify({ args: ['ping'], stdin: '', env: [] })}\n{"args":["pa`)
      expect(cmux.calls()).toEqual([{ args: ['ping'], stdin: '', env: [] }])
    } finally {
      cmux.remove()
    }
  })

  it('fakePlatform lists only its whole lines', () => {
    const root = mkdtempSync(join(tmpdir(), 'fake-platform-'))
    try {
      const platform = fakePlatform(join(root, 'bin'))
      appendFileSync(join(platform.bin, 'calls.jsonl'), `${JSON.stringify(['launchctl', 'list'])}\n["systemctl","--us`)
      expect(platform.calls()).toEqual([['launchctl', 'list']])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fakeGrid lists only its whole lines', () => {
    const grid = installFakeGrid({})
    try {
      appendFileSync(process.env.FAKE_GRID_LOG!, `${JSON.stringify(['ls'])}\n["--remote","jo`)
      expect(grid.calls()).toEqual([['ls']])
    } finally {
      grid.dispose()
    }
  })
})
