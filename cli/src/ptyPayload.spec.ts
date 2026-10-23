import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// What build-bundle.mjs copies beside a Windows bundle (scripts/lib/ptyPayload.mjs).
// @ts-expect-error — plain ESM with no declaration file
const { copyPtyPayload } = await import('../scripts/lib/ptyPayload.mjs') as {
  copyPtyPayload: (options: { ptyDir: string; outDir: string; platform?: NodeJS.Platform; arch?: string }) => string[]
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function repository(files: string[]): { ptyDir: string; outDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pty-payload-'))
  dirs.push(root)
  const ptyDir = join(root, 'pty')
  for (const file of files) {
    mkdirSync(join(ptyDir, file, '..'), { recursive: true })
    writeFileSync(join(ptyDir, file), file)
  }
  return { ptyDir, outDir: join(root, 'dist') }
}

const HOST = 'target/release/harness-pty.exe'
const LAUNCHER = 'target/release/harness-launch.exe'
const COMMAND = 'target/release/harness.exe'

describe('the pty host beside a Windows bundle', () => {
  it('copies the host, the windowless launcher, the harness command and the ConPTY payload for the build\'s architecture into dist/pty', () => {
    const repo = repository([HOST, LAUNCHER, COMMAND, 'vendor/conpty/arm64/conpty.dll', 'vendor/conpty/arm64/OpenConsole.exe', 'vendor/conpty/x64/conpty.dll'])
    expect(copyPtyPayload({ ...repo, platform: 'win32', arch: 'arm64' })).toEqual(['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe'])
    expect(readdirSync(join(repo.outDir, 'pty')).sort()).toEqual(['OpenConsole.exe', 'conpty.dll', 'harness-launch.exe', 'harness-pty.exe', 'harness.exe'])
  })

  it('copies harness-serial from serial/ beside pty/ when it was built', () => {
    const repo = repository([HOST, LAUNCHER, COMMAND, 'vendor/conpty/x64/conpty.dll', 'vendor/conpty/x64/OpenConsole.exe', '../serial/target/release/harness-serial.exe'])
    expect(copyPtyPayload({ ...repo, platform: 'win32', arch: 'x64' })).toEqual(['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe'])
  })

  it('copies only what is there: the host without a launcher or payload, nothing without the host', () => {
    const hostOnly = repository([HOST])
    expect(copyPtyPayload({ ...hostOnly, platform: 'win32', arch: 'x64' })).toEqual(['harness-pty.exe'])
    const payloadOnly = repository([LAUNCHER, COMMAND, 'vendor/conpty/x64/conpty.dll', 'vendor/conpty/x64/OpenConsole.exe'])
    expect(copyPtyPayload({ ...payloadOnly, platform: 'win32', arch: 'x64' })).toEqual([])
    expect(existsSync(join(payloadOnly.outDir, 'pty'))).toBe(false)
  })

  it('leaves a Unix bundle as it was', () => {
    const repo = repository([HOST, 'vendor/conpty/x64/conpty.dll'])
    for (const platform of ['darwin', 'linux'] as const) expect(copyPtyPayload({ ...repo, platform, arch: 'x64' })).toEqual([])
    expect(existsSync(join(repo.outDir, 'pty'))).toBe(false)
  })
})
