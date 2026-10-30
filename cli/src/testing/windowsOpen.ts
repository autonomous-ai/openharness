/**
 * Specs that read a state file as Windows would: its platform, and its open without O_NOFOLLOW (fs.constants
 * leaves it out there). A spec mocks node:fs with [windowsOpenFs] and wraps its Windows part in [asWindows]:
 *
 *   vi.mock('node:fs', async (importOriginal) =>
 *     (await import('../testing/windowsOpen.js')).windowsOpenFs(await importOriginal<typeof import('node:fs')>()))
 *
 * The factory imports this module itself because vi.mock is hoisted above the spec's imports. It is the same module
 * instance the spec imports [asWindows] from, so the two share [state]. This file imports nothing, node:fs least of all.
 */
const state = { windowsOpen: false }

/** node:fs, with O_NOFOLLOW undefined while [asWindows] runs. */
export function windowsOpenFs<T extends typeof import('node:fs')>(real: T): T {
  // A copy: fs.constants' own properties cannot be redefined.
  const constants = Object.defineProperty({ ...real.constants }, 'O_NOFOLLOW', {
    enumerable: true, get: () => (state.windowsOpen ? undefined : real.constants.O_NOFOLLOW),
  }) as typeof real.constants
  return { ...real, constants, default: { ...real, constants } } as T
}

/** Run [body] as Windows would: its platform, its open, and [dataDir] as the configured data folder. */
export function asWindows(dataDir: string, body: () => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const configured = process.env.ADAPTER_DATA_DIR
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    process.env.ADAPTER_DATA_DIR = dataDir
    state.windowsOpen = true
    body()
  } finally {
    state.windowsOpen = false
    Object.defineProperty(process, 'platform', platform)
    if (configured === undefined) delete process.env.ADAPTER_DATA_DIR
    else process.env.ADAPTER_DATA_DIR = configured
  }
}
