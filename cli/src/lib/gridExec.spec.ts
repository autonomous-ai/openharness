/**
 * Which `grid` this daemon runs, and what every child of it inherits.
 *
 * `gridBinaryPath()` is the one resolver behind every grid call — the daemon's own (`gridExec`), the
 * sign-in hand-off and the sign-out, and the PATH the agent's pane gets (`engineLaunch.ts`). The
 * order is the contract: the developer override, then the managed runtime's pointer, then PATH —
 * with the pointer trusted only when it names something runnable INSIDE the runtime dir.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let runtimeDir = ''
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HARNESS_GRID_BIN: process.env.HARNESS_GRID_BIN, ADAPTER_RUNTIME_DIR: process.env.ADAPTER_RUNTIME_DIR }

/** `gridExec.ts` reads `env.ADAPTER_RUNTIME_DIR` at import time, so the module is loaded fresh per case. */
async function load() {
  vi.resetModules()
  process.env.ADAPTER_RUNTIME_DIR = runtimeDir
  return import('./gridExec.js')
}

/** A `grid` that prints what it was given: its argv, then GRID_NO_UPDATE_CHECK. A shell script with
 *  builtins only, so an empty PATH cannot fail it for a reason that is not the one under test. */
function fakeGrid(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'grid')
  writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' "$@" "update-check=${GRID_NO_UPDATE_CHECK-unset}"\nexit 0\n', { mode: 0o755 })
  return bin
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grid-exec-'))
  runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  mkdirSync(join(root, 'empty-bin'))
  process.env.PATH = join(root, 'empty-bin')
  // The resolver's last fallback is `$HOME/.local/bin/grid` (grid's own installer's path), so a
  // developer machine that has one must not leak into "nothing to run".
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

describe('gridBinaryPath', () => {
  it('is the developer override when there is one, whatever else exists', async () => {
    const managed = fakeGrid(join(runtimeDir, 'grid-0.3.47-darwin-arm64'))
    writeFileSync(join(runtimeDir, 'current-grid'), `${managed}\n`)
    const { gridBinaryPath } = await load()

    expect(gridBinaryPath({ HARNESS_GRID_BIN: '/elsewhere/grid' })).toBe('/elsewhere/grid')
  })

  it('is the managed runtime when its pointer names a runnable grid inside the runtime dir', async () => {
    const managed = fakeGrid(join(runtimeDir, 'grid-0.3.47-darwin-arm64'))
    writeFileSync(join(runtimeDir, 'current-grid'), `${managed}\n`)
    const { gridBinaryPath } = await load()

    expect(gridBinaryPath({})).toBe(managed)
  })

  it('falls through to PATH when the pointer names something outside the runtime dir', async () => {
    writeFileSync(join(runtimeDir, 'current-grid'), '/bin/sh\n')
    const { gridBinaryPath } = await load()

    expect(gridBinaryPath({})).toBe('grid')
  })

  it('falls through to PATH when the pointer names something that is not there, or not runnable', async () => {
    const { gridBinaryPath } = await load()

    writeFileSync(join(runtimeDir, 'current-grid'), `${join(runtimeDir, 'grid-gone', 'grid')}\n`)
    expect(gridBinaryPath({})).toBe('grid')

    const unrunnable = fakeGrid(join(runtimeDir, 'grid-0.3.47-darwin-arm64'))
    chmodSync(unrunnable, 0o644)
    writeFileSync(join(runtimeDir, 'current-grid'), `${unrunnable}\n`)
    expect(gridBinaryPath({})).toBe('grid')
  })
})

describe('gridCliPresence', () => {
  it('is `managed` when the resolved grid is the runtime this daemon owns', async () => {
    const managed = fakeGrid(join(runtimeDir, 'grid-0.3.47-darwin-arm64'))
    writeFileSync(join(runtimeDir, 'current-grid'), `${managed}\n`)
    const { gridCliPresence } = await load()

    expect(gridCliPresence()).toBe('managed')
  })

  it('is `path` for a grid found on PATH, and for a developer override — neither is the pin', async () => {
    fakeGrid(join(root, 'path-bin'))
    process.env.PATH = join(root, 'path-bin')
    const { gridCliPresence } = await load()
    expect(gridCliPresence()).toBe('path')

    process.env.HARNESS_GRID_BIN = fakeGrid(join(root, 'elsewhere'))
    expect(gridCliPresence()).toBe('path')

    // Wherever the override lives — even under the runtime dir — it is the developer's, not the pin.
    process.env.HARNESS_GRID_BIN = fakeGrid(join(runtimeDir, 'grid-dev-build'))
    expect(gridCliPresence()).toBe('path')
  })

  it('is `missing` when there is nothing to run at all', async () => {
    const { gridCliPresence } = await load()

    expect(gridCliPresence()).toBe('missing')
  })
})

describe('gridChildEnv', () => {
  it('turns grid\'s own update check off on top of the environment it is given', async () => {
    const { gridChildEnv } = await load()

    expect(gridChildEnv({ GRID_HOME: '/x/.grid', PATH: '/bin' })).toEqual({ GRID_HOME: '/x/.grid', PATH: '/bin', GRID_NO_UPDATE_CHECK: '1' })
  })
})

describe('gridExec', () => {
  it('runs the resolved grid with its update check off, and hands back what it said', async () => {
    process.env.HARNESS_GRID_BIN = fakeGrid(join(root, 'elsewhere'))
    const { gridExec } = await load()

    const result = await gridExec(['--version'])

    expect(result.code).toBe('OK')
    expect(result.stdout).toBe('--version\nupdate-check=1\n')
  })

  it('answers GRID_CLI_MISSING, without spawning, when there is nothing to run', async () => {
    const { gridExec } = await load()

    const result = await gridExec(['--version'])

    expect(result).toMatchObject({ code: 'GRID_CLI_MISSING', exitCode: 1 })
    expect(result.message).toContain('grid')
  })
})
