import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJson } from './runtime.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('readJson', () => {
  it('reads a Claude Code settings.json saved with a BOM, as Windows PowerShell 5 writes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-read-json-'))
    roots.push(root)
    const file = join(root, 'settings.json')
    writeFileSync(file, `﻿${JSON.stringify({ model: 'opus', effortLevel: 'high' })}`)
    expect(await readJson(file)).toEqual({ model: 'opus', effortLevel: 'high' })
  })
})
