import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { linkTeamNodeTools, type TeamNodeToolsDeps } from './nodeTools.js'

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A home with Harness's Node laid out as setup copies it: bin/node, and npm and npx as links into lib, as Node ships. */
function home(tools = true) {
  const dir = mkdtempSync(join(tmpdir(), 'team-node-'))
  cleanup.push(dir)
  const runtime = join(dir, '.harness', 'runtime', 'node-v22')
  mkdirSync(join(runtime, 'bin'), { recursive: true })
  mkdirSync(join(runtime, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 })
  if (tools) {
    for (const [tool, script] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']] as const) {
      writeFileSync(join(runtime, 'lib', 'node_modules', 'npm', 'bin', script), `#!/bin/sh\necho ${tool} "$@"\n`, { mode: 0o755 })
      symlinkSync(`../lib/node_modules/npm/bin/${script}`, join(runtime, 'bin', tool))
    }
  }
  const deps: TeamNodeToolsDeps = { team: () => true, node: () => join(runtime, 'bin', 'node'), binDir: join(dir, '.local', 'bin'), log: vi.fn() }
  return { dir, runtime, deps }
}

describe('npm and npx for the Harness Team account', () => {
  // 2026-10-28: setup linked only node, so a teammate's Builder in the team account had no npm.
  it('links them from its own Node where they are missing, and they run', () => {
    const { runtime, deps } = home()
    expect(linkTeamNodeTools(deps)).toEqual(['npm', 'npx'])
    expect(readlinkSync(join(deps.binDir, 'npm'))).toBe(join(runtime, 'bin', 'npm'))
    expect(execFileSync(join(deps.binDir, 'npx'), ['-v'], { encoding: 'utf8' })).toBe('npx -v\n')
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('linked npm and npx'))
    // Once there, nothing again.
    expect(linkTeamNodeTools(deps)).toEqual([])
  })

  it('leaves alone what is already there, an account that is not a team account, and a Node without them', () => {
    const { deps } = home()
    mkdirSync(deps.binDir, { recursive: true })
    symlinkSync('/somewhere/gone', join(deps.binDir, 'npm'))
    expect(linkTeamNodeTools(deps)).toEqual(['npx'])
    expect(readlinkSync(join(deps.binDir, 'npm'))).toBe('/somewhere/gone')
    expect(linkTeamNodeTools({ ...home().deps, team: () => false })).toEqual([])
    expect(linkTeamNodeTools(home(false).deps)).toEqual([])
  })

  it('says why, and does not throw, when it cannot link', () => {
    const { dir, deps } = home()
    writeFileSync(join(dir, '.local'), 'a file where the folder goes')
    expect(linkTeamNodeTools(deps)).toEqual([])
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('could not link npm'))
  })
})
