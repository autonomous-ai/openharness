import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformService, launchdPlist, systemdUnit, type PlatformDeps, type ServiceDefinition } from '../harnessd/platform.js'

let root = ''
let runtimeDir = ''
let binDir = ''
let cliDir = ''

async function load() {
  vi.resetModules()
  process.env.ADAPTER_RUNTIME_DIR = runtimeDir
  process.env.HARNESS_BIN_DIR = binDir
  process.env.ADAPTER_CLI_DIR = cliDir
  return import('./nodeReferences.js')
}

/** The launchd agent or systemd unit on an in-memory disk, and every write and command made to it. */
function platform(name: 'launchd' | 'systemd', written: ServiceDefinition) {
  const files: Record<string, string> = {}
  const writes: string[] = []
  const calls: string[] = []
  const deps: PlatformDeps = {
    run: (command, args) => { calls.push([command, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' } },
    readFile: (path) => files[path] ?? null,
    writeFile: (path, content) => { writes.push(path); files[path] = content },
    removeFile: (path) => { delete files[path] },
    uid: 501,
    home: root,
  }
  const service = new PlatformService(name, deps)
  files[service.file] = name === 'launchd' ? launchdPlist(written) : systemdUnit(written)
  return { service, files, writes, calls }
}

describe('refreshNodeReferences', () => {
  const node = (version: string) => join(runtimeDir, `node-v${version}-darwin-arm64`, 'bin', 'node')
  const launcher = () => join(binDir, 'harness')
  const cli = () => join(cliDir, 'cli.js')
  const definition = (nodePath: string): ServiceDefinition => ({ nodePath, scriptPath: cli(), logFile: join(root, 'harness.log'), home: root, env: {} })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'node-references-'))
    runtimeDir = join(root, '.harness', 'runtime')
    binDir = join(root, '.local', 'bin')
    cliDir = join(root, '.harness', 'cli')
    for (const dir of [runtimeDir, binDir, cliDir]) mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    for (const key of ['ADAPTER_RUNTIME_DIR', 'HARNESS_BIN_DIR', 'ADAPTER_CLI_DIR']) delete process.env[key]
  })

  it('rewrites a launcher that names node 22', async () => {
    writeFileSync(launcher(), `#!/bin/sh\nexec '${node('22.23.2')}' '${cli()}' "$@"\n`, { mode: 0o755 })
    const { refreshNodeReferences } = await load()
    const lines: string[] = []
    expect(refreshNodeReferences(node('24.22.2'), (line) => lines.push(line), { service: null, logFile: join(root, 'harness.log') }))
      .toEqual({ launcher: true, service: false })
    expect(readFileSync(launcher(), 'utf8')).toBe(`#!/bin/sh\nexec '${node('24.22.2')}' '${cli()}' "$@"\n`)
    expect(lines).toEqual([`  ✓ repointed ${launcher()} at ${node('24.22.2')}`])
  })

  it('rewrites the launchd plist and systemd unit whose node is 22', async () => {
    const { refreshNodeReferences } = await load()
    for (const name of ['launchd', 'systemd'] as const) {
      const disk = platform(name, definition(node('22.23.2')))
      const lines: string[] = []
      expect(refreshNodeReferences(node('24.22.2'), (line) => lines.push(line), { service: disk.service, logFile: join(root, 'harness.log') }))
        .toEqual({ launcher: false, service: true })
      expect(disk.files[disk.service.file]).toBe(disk.service.render(definition(node('24.22.2'))))
      expect(lines).toEqual([`  ✓ repointed ${disk.service.file} at ${node('24.22.2')}`])
      // The running job is the platform's: nothing is reloaded or restarted under the daemon.
      expect(disk.calls).toEqual([])
    }
  })

  it('leaves everything alone when it already names node 24', async () => {
    const current = `#!/bin/sh\nexec '${node('24.22.2')}' '${cli()}' "$@"\n`
    writeFileSync(launcher(), current, { mode: 0o755 })
    const { refreshNodeReferences } = await load()
    for (const name of ['launchd', 'systemd'] as const) {
      const disk = platform(name, definition(node('24.22.2')))
      const lines: string[] = []
      expect(refreshNodeReferences(node('24.22.2'), (line) => lines.push(line), { service: disk.service, logFile: join(root, 'harness.log') }))
        .toEqual({ launcher: false, service: false })
      expect({ writes: disk.writes, calls: disk.calls, lines }).toEqual({ writes: [], calls: [], lines: [] })
    }
    expect(readFileSync(launcher(), 'utf8')).toBe(current)
  })

  it('never points them at a Node outside the runtime folder, the one managedNodePath falls back to', async () => {
    const before = `#!/bin/sh\nexec '${node('22.23.2')}' '${cli()}' "$@"\n`
    writeFileSync(launcher(), before, { mode: 0o755 })
    const { refreshNodeReferences } = await load()
    const disk = platform('launchd', definition(node('22.23.2')))
    expect(refreshNodeReferences('/opt/homebrew/bin/node', () => {}, { service: disk.service, logFile: join(root, 'harness.log') }))
      .toEqual({ launcher: false, service: false })
    expect({ launcher: readFileSync(launcher(), 'utf8'), writes: disk.writes }).toEqual({ launcher: before, writes: [] })
  })

  it('says when a definition still names another Node', async () => {
    const { refreshNodeReferences } = await load()
    const disk = platform('systemd', definition(node('22.23.2')))
    disk.files[disk.service.file] = disk.files[disk.service.file].replace(/^ExecStart=/m, 'ExecStart=/usr/bin/env ')
    const lines: string[] = []
    expect(refreshNodeReferences(node('24.22.2'), (line) => lines.push(line), { service: disk.service, logFile: join(root, 'harness.log') }))
      .toEqual({ launcher: false, service: false })
    expect(lines).toEqual([`  ✗ ${disk.service.file} was left on its Node: ${disk.service.file} does not run its Node where harness service install writes it`])
  })
})
