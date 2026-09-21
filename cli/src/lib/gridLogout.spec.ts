/**
 * Which `grid` the sign-out passthrough runs — the same answer as the hand-off, for the same reason:
 * the sign-in and the sign-out must land on ONE binary, the one `gridExec.ts` resolves for every
 * other grid call (override → managed runtime → PATH). What the passthrough does and does not wrap
 * is covered in `gridCommand.spec.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let runtimeDir = ''
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HARNESS_GRID_BIN: process.env.HARNESS_GRID_BIN, ADAPTER_RUNTIME_DIR: process.env.ADAPTER_RUNTIME_DIR }

async function load() {
  vi.resetModules()
  process.env.ADAPTER_RUNTIME_DIR = runtimeDir
  return import('./gridLogout.js')
}

/** Records its argv under `label` and exits 0. A shell script, so an empty PATH cannot break it. */
function fakeGrid(dir: string, label: string): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'grid')
  writeFileSync(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${join(root, `${label}.args`)}"`,
    `printf '%s' "\${GRID_NO_UPDATE_CHECK-unset}" > "${join(root, `${label}.update-check`)}"`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  return bin
}

function ran(label: string): boolean { return existsSync(join(root, `${label}.args`)) }
function argsOf(label: string): string[] { return readFileSync(join(root, `${label}.args`), 'utf8').trim().split('\n') }
function updateCheckSeenBy(label: string): string { return readFileSync(join(root, `${label}.update-check`), 'utf8') }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grid-logout-'))
  runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  mkdirSync(join(root, 'empty-bin'))
  process.env.PATH = join(root, 'empty-bin')
  // The resolver's last resort is `$HOME/.local/bin/grid` (gridExec.ts) — on a developer's machine
  // that is a REAL grid, and the "no child" case below ran its real `grid logout` before HOME was
  // pointed here. Every case now sees a home with nothing under it.
  process.env.HOME = root
  delete process.env.HARNESS_GRID_BIN
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe('passThroughToGridLogout — which grid it runs', () => {
  it('runs the grid HARNESS_GRID_BIN names, with nothing on PATH', async () => {
    process.env.HARNESS_GRID_BIN = fakeGrid(join(root, 'elsewhere'), 'override')
    const { passThroughToGridLogout } = await load()

    const outcome = await passThroughToGridLogout(['--force'])

    expect(outcome).toEqual({ ran: true, exitCode: 0 })
    expect(argsOf('override')).toEqual(['logout', '--force'])
    // Same as the hand-off: a pinned binary must never be told to `grid update` itself.
    expect(updateCheckSeenBy('override')).toBe('1')
  })

  it('prefers the managed runtime over a grid on PATH', async () => {
    fakeGrid(join(root, 'path-bin'), 'path')
    process.env.PATH = join(root, 'path-bin')
    const managed = fakeGrid(join(runtimeDir, 'grid-0.3.47-darwin-arm64'), 'managed')
    writeFileSync(join(runtimeDir, 'current-grid'), `${managed}\n`)
    const { passThroughToGridLogout } = await load()

    const outcome = await passThroughToGridLogout([])

    expect(outcome).toEqual({ ran: true, exitCode: 0 })
    expect(argsOf('managed')).toEqual(['logout'])
    expect(ran('path')).toBe(false)
  })

  it('says there was no child to run when neither the managed runtime nor PATH has one', async () => {
    const { passThroughToGridLogout } = await load()

    const outcome = await passThroughToGridLogout([])

    expect(outcome).toMatchObject({ ran: false, exitCode: 1 })
    expect(outcome.ran === false && outcome.message).toContain('grid')
  })
})
