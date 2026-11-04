import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { PROCESS_ENGINES } from '../engines/types.js'
import { ENGINE_INSTALL, ENGINE_WINDOWS_INSTALL, engineInstallLine, engineInstallPaths } from './engineInstall.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'
import { launchScriptOf } from '../testing/launchScript.js'

const OFFICIAL_COMMANDS = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  cursor: 'curl https://cursor.com/install -fsS | bash',
  opencode: 'curl -fsSL https://opencode.ai/install | bash',
  pi: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
  omp: 'curl -fsSL https://omp.sh/install | sh',
  hermes: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
  commandcode: 'npm i -g command-code',
  devin: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
  muse: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
  amp: 'curl -fsSL https://ampcode.com/install.sh | bash',
  kilo: 'npm install -g @kilocode/cli',
  grok: 'curl -fsSL https://x.ai/cli/install.sh | bash',
  agy: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  copilot: 'npm install -g @github/copilot',
} as const

describe('ENGINE_INSTALL', () => {
  it('has one first-party recipe for every supported engine', () => {
    expect(Object.keys(ENGINE_INSTALL)).toEqual(PROCESS_ENGINES)
    expect(Object.fromEntries(
      Object.entries(ENGINE_INSTALL).map(([engine, recipe]) => [engine, recipe.command]),
    )).toEqual(OFFICIAL_COMMANDS)
    for (const recipe of Object.values(ENGINE_INSTALL)) {
      expect(recipe.source).toMatch(/^https:\/\//)
      expect(recipe.executable.names.length).toBeGreaterThan(0)
    }
  })

  it('uses Cursor’s unambiguous documented command and OpenCode stable', () => {
    expect(ENGINE_INSTALL.cursor.executable.names[0]).toBe('cursor-agent')
    expect(ENGINE_INSTALL.opencode.command).not.toContain('opencode2')
    expect(ENGINE_INSTALL.opencode.command).not.toContain('@beta')
  })

  it('falls back to OpenCode’s npm package, whose binaries need no GitHub download', () => {
    expect(ENGINE_INSTALL.opencode.fallback).toBe('npm install -g opencode-ai')
    expect(ENGINE_INSTALL.opencode.executable.npmGlobal).toBe(true)
  })

  it('generates valid POSIX pane scripts for every recipe', () => {
    for (const engine of PROCESS_ENGINES) {
      const script = launchScriptOf(buildEngineLaunchArgv(
        engine,
        { installIfMissing: ENGINE_INSTALL[engine] },
        '/bin/sh',
      ))
      expect(script).toContain('harness_find_engine')
      expect(() => execFileSync('/bin/sh', ['-n', '-c', script])).not.toThrow()
    }
  })
})

describe('ENGINE_WINDOWS_INSTALL', () => {
  const home = 'C:\\Users\\a b', local = 'C:\\Users\\a b\\AppData\\Local'

  it('has an install for every engine, each with somewhere to find it', () => {
    for (const engine of PROCESS_ENGINES) {
      expect(ENGINE_WINDOWS_INSTALL[engine], engine).toBeDefined()
      expect(engineInstallPaths(ENGINE_INSTALL[engine], home, 'win32', local).length, engine).toBeGreaterThan(0)
    }
  })

  it('finds an npm engine where npm leaves it, and never `cmd`, the command processor', () => {
    expect(engineInstallPaths(ENGINE_INSTALL.commandcode, home, 'win32', local)[0]).toBe('C:\\Users\\a b\\.local\\command-code')
    expect(engineInstallPaths(ENGINE_INSTALL.commandcode, home, 'win32', local).some((path) => path.endsWith('\\.local\\cmd'))).toBe(false)
  })

  it('finds a vendor\'s engine under %LOCALAPPDATA% or the profile', () => {
    expect(engineInstallPaths(ENGINE_INSTALL.agy, home, 'win32', local)[0]).toBe('C:\\Users\\a b\\AppData\\Local\\agy\\bin\\agy')
    expect(engineInstallPaths(ENGINE_INSTALL.amp, home, 'win32', local)[0]).toBe('C:\\Users\\a b\\.amp\\bin\\amp')
  })

  it('shows a person the line that really runs there', () => {
    expect(engineInstallLine(ENGINE_INSTALL.kilo, 'win32', 'x64')).toBe('npm install -g @kilocode/cli')
    expect(engineInstallLine(ENGINE_INSTALL.omp, 'win32', 'x64')).toBe('irm https://omp.sh/install.ps1 | iex')
    expect(engineInstallLine(ENGINE_INSTALL.opencode, 'win32', 'arm64')).toBe('npm install -g --cpu=x64 opencode-ai')
    expect(engineInstallLine(ENGINE_INSTALL.omp, 'darwin', 'arm64')).toBe(ENGINE_INSTALL.omp.command)
  })

  it('leaves a Mac\'s and a Linux computer\'s paths as they were', () => {
    expect(engineInstallPaths(ENGINE_INSTALL.kilo, '/h', 'darwin')).toEqual(['/h/.kilo/bin/kilo', '/h/.local/bin/kilo', '/h/.local/bin/kilocode'])
  })
})
