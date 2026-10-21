// Engine recognition on Windows, from real `harness-pty ps --json` rows: Windows 11 ARM64 (10.0.26100), 2026-10-15,
// Claude Code's native exe (2.1.300), Codex and OpenCode through their npm global shims, each the root of a Harness PTY
// pane (`C:\…\claude.exe`, `C:\…\npm\codex.cmd`, `C:\…\npm\opencode.cmd serve`). Only pid, parent, image name and
// command line are kept. OpenCode's TUI does not start on that machine (its arm64 build has no bun:ffi), so its rows are
// `opencode serve`'s, which is launched the same way.
import { describe, expect, it } from 'vitest'
import { engineProcessMatch, programName, selectEngineProcess, type ProcessRow } from '../processTable.js'

const row = (pid: number, parentPid: number, executable: string, args: string, nativeArgv?: string[]): ProcessRow =>
  ({ pid, parentPid, executable, args, startMarker: `w:1343651749${pid}`, ...(nativeArgv ? { nativeArgv } : {}) })

const NPM = 'C:\\Users\\admin\\AppData\\Roaming\\npm'

const claude = [row(5160, 12200, 'claude.exe', 'C:\\Users\\admin\\.local\\bin\\claude.exe', ['C:\\Users\\admin\\.local\\bin\\claude.exe'])]

const codex = [
  row(6348, 12200, 'cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /c ${NPM}\\codex.cmd`, ['C:\\WINDOWS\\system32\\cmd.exe', '/c', `${NPM}\\codex.cmd`]),
  row(5988, 6348, 'node.exe', `"node"   "${NPM}\\\\node_modules\\@openai\\codex\\bin\\codex.js" `,
    ['node', `${NPM}\\\\node_modules\\@openai\\codex\\bin\\codex.js`]),
  row(6524, 5988, 'codex.exe', `${NPM}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe`),
  row(8660, 6524, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" ./mcp/server.bundle.mjs', ['C:\\Program Files\\nodejs\\node.exe', './mcp/server.bundle.mjs']),
  row(10760, 8660, 'conhost.exe', '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4', ['\\??\\C:\\WINDOWS\\system32\\conhost.exe', '0x4']),
]

const opencode = [
  row(3780, 1336, 'cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /c ${NPM}\\opencode.cmd serve`, ['C:\\WINDOWS\\system32\\cmd.exe', '/c', `${NPM}\\opencode.cmd`, 'serve']),
  row(11272, 3780, 'opencode.exe', `"${NPM}\\\\node_modules\\opencode-ai\\bin\\opencode.exe"    serve`, [`${NPM}\\\\node_modules\\opencode-ai\\bin\\opencode.exe`, 'serve']),
]

// The same OpenCode typed into a PowerShell pane: PowerShell wraps the .cmd in cmd.exe itself.
const opencodeFromPowerShell = [
  row(6896, 1336, 'powershell.exe', 'powershell.exe -NoLogo -NoProfile -NoExit -Command opencode.cmd serve --port 4099'),
  row(10336, 6896, 'cmd.exe', `C:\\WINDOWS\\system32\\cmd.exe /c ""${NPM}\\opencode.cmd" serve --port 4099"`, ['C:\\WINDOWS\\system32\\cmd.exe', '/c', `${NPM}\\opencode.cmd serve --port 4099`]),
  row(1972, 10336, 'opencode.exe', `"${NPM}\\\\node_modules\\opencode-ai\\bin\\opencode.exe"    serve --port 4099`, [`${NPM}\\\\node_modules\\opencode-ai\\bin\\opencode.exe`, 'serve', '--port', '4099']),
]

describe('programName', () => {
  it('drops a Windows program image\'s extension, in any case, after either separator', () => {
    expect(programName('C:\\Users\\admin\\.local\\bin\\claude.exe')).toBe('claude')
    expect(programName('C:/tools/KILO.EXE')).toBe('kilo')
    expect(programName('C:\\bin\\amp.com')).toBe('amp')
    expect(programName('"C:\\Program Files\\nodejs\\node.exe"'.slice(1, -1))).toBe('node')
  })

  it('keeps a script\'s extension: cmd.exe or PowerShell runs it, so it is never an engine\'s process', () => {
    expect(programName('C:\\Users\\admin\\AppData\\Roaming\\npm\\codex.CMD')).toBe('codex.cmd')
    expect(programName('C:/tools/kilo.bat')).toBe('kilo.bat')
    expect(programName('C:\\npm\\opencode.ps1')).toBe('opencode.ps1')
  })

  it('keeps the command processor apart from Command Code', () => {
    expect(programName('C:\\WINDOWS\\system32\\cmd.exe')).toBe('cmd.exe')
    expect(programName('CMD.EXE')).toBe('cmd.exe')
  })

  it('reads a Unix name as its basename', () => {
    expect(programName('/usr/local/bin/claude')).toBe('claude')
    expect(programName('/opt/homebrew/bin/node')).toBe('node')
    expect(programName('cmd')).toBe('cmd')
    expect(programName('/home/u/.local/share/claude/versions/2.1.246')).toBe('2.1.246')
    expect(programName('/usr/bin/python3.12')).toBe('python3.12')
    expect(programName('/opt/x/')).toBe('x')
    expect(programName('')).toBe('')
  })
})

describe('engine recognition on Windows', () => {
  it('knows Claude Code\'s native exe', () => {
    expect(engineProcessMatch(claude[0], 'claude')).toMatchObject({ score: 3, evidence: 'native-or-process-name' })
    expect(selectEngineProcess(claude, 5160, 'claude')?.pid).toBe(5160)
    expect(engineProcessMatch(claude[0], 'codex').score).toBe(0)
  })

  it('finds Codex under its npm shim: the launcher first, as on Unix, and the native exe by its name', () => {
    expect(engineProcessMatch(codex[0], 'codex').score).toBe(0)
    expect(engineProcessMatch(codex[1], 'codex')).toMatchObject({ score: 2, evidence: 'package-entrypoint' })
    expect(engineProcessMatch(codex[2], 'codex')).toMatchObject({ score: 3, evidence: 'native-or-process-name' })
    expect(selectEngineProcess(codex, 6348, 'codex')?.pid).toBe(5988)
    // Codex's own MCP server is node running a relative script: no engine.
    expect(engineProcessMatch(codex[3], 'codex').score).toBe(0)
  })

  it('finds OpenCode under its npm shim, from a pane and from PowerShell', () => {
    expect(selectEngineProcess(opencode, 3780, 'opencode')?.pid).toBe(11272)
    expect(selectEngineProcess(opencodeFromPowerShell, 6896, 'opencode')?.pid).toBe(1972)
  })

  it('never takes the command processor, PowerShell or conhost for an engine', () => {
    const shells = [codex[0], codex[4], opencode[0], opencodeFromPowerShell[0], opencodeFromPowerShell[1]]
    for (const shell of shells) {
      for (const engine of ['claude', 'codex', 'opencode', 'commandcode', 'cursor'] as const) {
        expect(engineProcessMatch(shell, engine).score, `${shell.executable} as ${engine}`).toBe(0)
      }
    }
  })

  it('takes no script in an unrelated folder for an engine', () => {
    const scripts = [
      row(9100, 1, 'powershell.exe', 'C:\\Users\\admin\\scripts\\claude.ps1 --resume'),
      row(9101, 1, 'cmd.exe', 'C:\\tools\\codex.bat'),
      row(9102, 1, 'claude.ps1', 'C:\\Users\\admin\\scripts\\claude.ps1'),
      row(9103, 1, 'codex.bat', 'D:\\work\\codex.bat exec'),
      row(9104, 1, 'node.exe', 'node C:\\Users\\admin\\scripts\\claude.ps1'),
      row(9105, 1, 'opencode.cmd', `${NPM}\\opencode.cmd`),
    ]
    for (const script of scripts) {
      for (const engine of ['claude', 'codex', 'opencode'] as const) {
        expect(engineProcessMatch(script, engine).score, `${script.args} as ${engine}`).toBe(0)
      }
    }
  })

  it('knows Claude Code\'s npm package run by node.exe', () => {
    const npmClaude = row(9000, 1, 'node.exe', `"C:\\Program Files\\nodejs\\node.exe" ${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`)
    expect(engineProcessMatch(npmClaude, 'claude')).toMatchObject({ score: 2, evidence: 'package-entrypoint' })
  })
})
