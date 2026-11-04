/**
 * The grid pin on Windows, where there is no managed grid build: grid's own installer lays the pinned release down.
 */
import { describe, expect, it, vi } from 'vitest'
import { followWindowsGridPin, GRID_WINDOWS_VERSION_FLOOR, type WindowsGridPinDeps } from './gridWindowsPin.js'

const PIN = '0.3.62'

function manifest(entry: unknown): unknown {
  return { grid: { 'darwin-arm64': { version: '0.3.59', url: 'https://example.test/grid.tar.gz' }, 'win32-x64': entry } }
}

function deps(overrides: Partial<WindowsGridPinDeps> = {}): WindowsGridPinDeps & { install: ReturnType<typeof vi.fn>; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    key: 'win32-x64',
    manifest: async () => manifest({ version: PIN }),
    installedVersion: async () => '0.3.61',
    install: vi.fn(async () => ({ status: 'installed' as const, message: 'installed' })),
    log: (line: string) => { lines.push(line) },
    ...overrides,
  } as WindowsGridPinDeps & { install: ReturnType<typeof vi.fn>; lines: string[] }
}

describe('followWindowsGridPin', () => {
  it('installs the pinned version when the installed grid is another', async () => {
    const d = deps()
    await followWindowsGridPin(d)
    expect(d.install.mock.calls).toEqual([[PIN]])
    expect(d.lines.join('\n')).toContain(PIN)
  })

  it('does nothing when the installed grid is the pin', async () => {
    const d = deps({ installedVersion: async () => PIN })
    await followWindowsGridPin(d)
    expect(d.install).not.toHaveBeenCalled()
    expect(d.lines).toEqual([])
  })

  it('installs the pin on a machine with no grid', async () => {
    const d = deps({ installedVersion: async () => null })
    await followWindowsGridPin(d)
    expect(d.install.mock.calls).toEqual([[PIN]])
  })

  it(`never follows a pin below ${GRID_WINDOWS_VERSION_FLOOR}, the first grid that runs on Windows as Harness drives it`, async () => {
    const d = deps({ manifest: async () => manifest({ version: '0.3.59' }) })
    await followWindowsGridPin(d)
    expect(d.install).not.toHaveBeenCalled()
  })

  it('does nothing without an entry for this computer, or with a version that is not a plain release number', async () => {
    for (const entry of [undefined, {}, { version: 7 }, { version: "0.3.62'; Remove-Item -Recurse ~; '" }, { version: '0.3.62-rc1' }]) {
      const d = deps({ manifest: async () => manifest(entry) })
      await followWindowsGridPin(d)
      expect(d.install).not.toHaveBeenCalled()
    }
  })

  it('does nothing on an unknown architecture, or when the manifest cannot be read', async () => {
    const noKey = deps({ key: null })
    await followWindowsGridPin(noKey)
    const unreadable = deps({ manifest: async () => { throw new Error('offline') } })
    await followWindowsGridPin(unreadable)
    expect(noKey.install).not.toHaveBeenCalled()
    expect(unreadable.install).not.toHaveBeenCalled()
  })

  it("logs the installer's own sentence when the install fails", async () => {
    const d = deps({ install: vi.fn(async () => ({ status: 'failed' as const, message: 'grid installer exited 1 · grid is running' })) })
    await followWindowsGridPin(d)
    expect(d.lines.at(-1)).toBe('grid installer exited 1 · grid is running')
  })
})
