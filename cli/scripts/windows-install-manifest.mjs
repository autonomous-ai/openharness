#!/usr/bin/env node
/**
 * An install manifest for `install.ps1 -Manifest`, made from a local build. Its inputs:
 * - the CLI bundle (dist/cli.js, dist/notify.mjs);
 * - a pty payload folder (harness-pty.exe, harness-launch.exe, harness.exe, conpty.dll, OpenConsole.exe, harness-serial.exe);
 * - nodejs.org's Windows zip, as downloaded.
 * It writes <out>/install-manifest.json and puts every file it names beside it, by relative name, so the folder can
 * be copied to a Windows computer as it is. It is used by the VM checks and by the Windows workflow's install job
 * (B5). It publishes nothing.
 *
 *   node scripts/windows-install-manifest.mjs --out <dir> --cli-dir dist --pty-dir <dir> \
 *     --node-zip node-v22.23.2-win-arm64.zip --version 0.3.120 [--pty-version 0.3.120]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, win32 } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

/** The payload's files, as install.ps1 ($HarnessPtyFiles) and publish-pty-payload.sh (FILES) name them. */
export const PTY_FILES = ['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe']
const NODE_ZIP = /^node-(v\d+\.\d+\.\d+)-win-(x64|arm64)\.zip$/
/** What ptyHost/launch.ts currentPtyVersion accepts as a version folder. */
const PTY_VERSION = /^\d+(\.\d+)*$/

const fileRef = (name, bytes) => ({ url: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })

/** The document install.ps1 -Manifest reads: the cli, node and pty keys, each shaped as its published manifest's. */
export function installManifest({ version, cli, notify, nodeZipName, nodeZip, ptyVersion, ptyZipName, ptyZip }) {
  const match = NODE_ZIP.exec(nodeZipName)
  if (!match) throw new Error(`${nodeZipName} is not nodejs.org's Windows zip (node-vX.Y.Z-win-<x64|arm64>.zip)`)
  if (!PTY_VERSION.test(ptyVersion)) throw new Error(`pty version ${ptyVersion} is not a version folder name (digits and dots)`)
  const [, nodeVersion, arch] = match
  const platform = `win32-${arch}`
  return {
    cli: { version, cli: fileRef('cli.js', cli), notify: fileRef('notify.mjs', notify) },
    node: { [platform]: { version: nodeVersion, ...fileRef(nodeZipName, nodeZip), archiveRoot: nodeZipName.slice(0, -'.zip'.length) } },
    pty: { [platform]: { version: ptyVersion, ...fileRef(ptyZipName, ptyZip) } },
  }
}

/**
 * How the payload folder becomes a zip with its files at the root. Windows and macOS use bsdtar, which writes zip
 * (`-a` picks the format from the name). Linux uses Python's zipfile, because GNU tar cannot write zip.
 */
export function zipCommand(zip, dir, platform = process.platform, systemRoot = process.env.SystemRoot) {
  if (platform === 'win32') return { file: win32.join(systemRoot || 'C:\\Windows', 'System32', 'tar.exe'), args: ['-a', '-cf', zip, '-C', dir, ...PTY_FILES] }
  if (platform === 'darwin') return { file: '/usr/bin/tar', args: ['-a', '-cf', zip, '-C', dir, ...PTY_FILES] }
  return { file: 'python3', args: ['-m', 'zipfile', '-c', zip, ...PTY_FILES], cwd: dir }
}

function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' }, 'cli-dir': { type: 'string' }, 'pty-dir': { type: 'string' },
      'node-zip': { type: 'string' }, version: { type: 'string' }, 'pty-version': { type: 'string' },
    },
  })
  for (const name of ['out', 'cli-dir', 'pty-dir', 'node-zip', 'version']) {
    if (!values[name]) throw new Error(`--${name} is required`)
  }
  const { out, version } = values
  const ptyVersion = values['pty-version'] ?? /^\d+\.\d+\.\d+/.exec(version)?.[0] ?? version
  const nodeZipName = basename(values['node-zip'])
  const arch = NODE_ZIP.exec(nodeZipName)?.[2]
  if (!arch) throw new Error(`${nodeZipName} is not nodejs.org's Windows zip (node-vX.Y.Z-win-<x64|arm64>.zip)`)
  const ptyZipName = `harness-pty-${ptyVersion}-win32-${arch}.zip`
  mkdirSync(out, { recursive: true })
  copyFileSync(join(values['cli-dir'], 'cli.js'), join(out, 'cli.js'))
  copyFileSync(join(values['cli-dir'], 'notify.mjs'), join(out, 'notify.mjs'))
  copyFileSync(values['node-zip'], join(out, nodeZipName))
  const zip = zipCommand(join(out, ptyZipName), values['pty-dir'])
  execFileSync(zip.file, zip.args, { cwd: zip.cwd, stdio: 'inherit' })
  const doc = installManifest({
    version,
    cli: readFileSync(join(out, 'cli.js')), notify: readFileSync(join(out, 'notify.mjs')),
    nodeZipName, nodeZip: readFileSync(join(out, nodeZipName)),
    ptyVersion, ptyZipName, ptyZip: readFileSync(join(out, ptyZipName)),
  })
  writeFileSync(join(out, 'install-manifest.json'), JSON.stringify(doc, null, 2) + '\n')
  console.log(join(out, 'install-manifest.json'))
}

/** Whether this file is the script node was started with: argv[1] through its links, as import.meta.url is the real path. */
function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href } catch { return false }
}

if (isMain()) {
  try { main() } catch (error) { console.error(`error: ${error.message}`); process.exit(1) }
}
