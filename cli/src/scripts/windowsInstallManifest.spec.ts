import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error — plain ESM with no declaration file
const { PTY_FILES, installManifest, zipCommand } = await import('../../scripts/windows-install-manifest.mjs') as {
  PTY_FILES: string[]
  installManifest: (input: Record<string, unknown>) => Record<string, any>
  zipCommand: (zip: string, dir: string, platform?: NodeJS.Platform, systemRoot?: string) => { file: string; args: string[]; cwd?: string }
}

const script = join(process.cwd(), 'scripts', 'windows-install-manifest.mjs')
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the install manifest of a local build', () => {
  it('has the three keys install.ps1 -Manifest reads, each shaped as its published manifest, naming files beside it', () => {
    const doc = installManifest({
      version: '0.3.120-dev.abc123', cli: Buffer.from('cli'), notify: Buffer.from('notify'),
      nodeZipName: 'node-v22.23.2-win-arm64.zip', nodeZip: Buffer.from('node'),
      ptyVersion: '0.3.120', ptyZipName: 'harness-pty-0.3.120-win32-arm64.zip', ptyZip: Buffer.from('pty'),
    })
    expect(doc).toEqual({
      cli: { version: '0.3.120-dev.abc123', cli: { url: 'cli.js', sha256: sha('cli'), size: 3 }, notify: { url: 'notify.mjs', sha256: sha('notify'), size: 6 } },
      node: { 'win32-arm64': { version: 'v22.23.2', url: 'node-v22.23.2-win-arm64.zip', sha256: sha('node'), size: 4, archiveRoot: 'node-v22.23.2-win-arm64' } },
      pty: { 'win32-arm64': { version: '0.3.120', url: 'harness-pty-0.3.120-win32-arm64.zip', sha256: sha('pty'), size: 3 } },
    })
  })

  it('refuses a Node archive that is not nodejs.org\'s Windows zip, and a pty version the host reader would ignore', () => {
    const base = { version: '1.2.3', cli: Buffer.from(''), notify: Buffer.from(''), nodeZip: Buffer.from(''), ptyZipName: 'p.zip', ptyZip: Buffer.from(''), ptyVersion: '1.2.3' }
    expect(() => installManifest({ ...base, nodeZipName: 'node-v22.23.2-darwin-arm64.tar.gz' })).toThrow('nodejs.org')
    expect(() => installManifest({ ...base, nodeZipName: 'node-v22.23.2-win-x64.zip', ptyVersion: '1.2.3-dev.x' })).toThrow('pty version')
  })

  it('zips with the bsdtar Windows and macOS ship, and with Python on Linux, whose GNU tar cannot', () => {
    expect(zipCommand('C:\\o\\p.zip', 'C:\\p', 'win32', 'C:\\Windows')).toEqual({ file: 'C:\\Windows\\System32\\tar.exe', args: ['-a', '-cf', 'C:\\o\\p.zip', '-C', 'C:\\p', ...PTY_FILES] })
    expect(zipCommand('/o/p.zip', '/p', 'darwin')).toEqual({ file: '/usr/bin/tar', args: ['-a', '-cf', '/o/p.zip', '-C', '/p', ...PTY_FILES] })
    expect(zipCommand('/o/p.zip', '/p', 'linux')).toEqual({ file: 'python3', args: ['-m', 'zipfile', '-c', '/o/p.zip', ...PTY_FILES], cwd: '/p' })
    expect(PTY_FILES).toEqual(['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe'])
  })

  it.skipIf(process.platform === 'linux' && spawnSync('python3', ['--version']).status !== 0)('writes the manifest and every file it names, with the digests of the bytes on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-win-manifest-'))
    dirs.push(root)
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'cli.js'), 'cli')
    writeFileSync(join(root, 'dist', 'notify.mjs'), 'notify')
    mkdirSync(join(root, 'payload'))
    for (const name of PTY_FILES) writeFileSync(join(root, 'payload', name), name)
    writeFileSync(join(root, 'node-v22.23.2-win-x64.zip'), 'node')
    const out = join(root, 'out')
    const run = spawnSync(process.execPath, [script, '--out', out, '--cli-dir', join(root, 'dist'), '--pty-dir', join(root, 'payload'), '--node-zip', join(root, 'node-v22.23.2-win-x64.zip'), '--version', '1.2.3'], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const doc = JSON.parse(readFileSync(join(out, 'install-manifest.json'), 'utf8'))
    for (const ref of [doc.cli.cli, doc.cli.notify, doc.node['win32-x64'], doc.pty['win32-x64']]) {
      const bytes = readFileSync(join(out, ref.url))
      expect(ref.sha256).toBe(sha(bytes))
      expect(ref.size).toBe(bytes.length)
    }
    expect(doc.pty['win32-x64'].version).toBe('1.2.3')
  })
})
