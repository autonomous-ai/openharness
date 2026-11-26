/**
 * A plugin's folder on Windows, which has no mode bits: Node makes a file's mode up there from its read-only flag, so
 * the writer neither sets nor compares modes, and a folder with an executable is written once, then the same, never
 * anew at every run. A Mac or Linux run would prove nothing; pluginFolder.spec.ts holds their modes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensurePluginFolder } from './pluginFolder.js'

const HOOKS = { 'hooks/asked': '#!/bin/sh\n', 'hooks/hooks.json': '{}' }

const dataDirs: string[] = []
afterEach(() => {
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('a plugin\'s folder on Windows', () => {
  it('a folder with an executable is written, then the same', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'plugin-folder-'))
    dataDirs.push(dataDir)
    const folder = join(dataDir, 'claude-marketplace')

    expect(ensurePluginFolder(folder, HOOKS, ['hooks/asked'])).toBe('written')

    for (const [key, text] of Object.entries(HOOKS)) expect(readFileSync(join(folder, key), 'utf8'), key).toBe(text)
    expect(ensurePluginFolder(folder, HOOKS, ['hooks/asked'])).toBe('same')
  })
})
