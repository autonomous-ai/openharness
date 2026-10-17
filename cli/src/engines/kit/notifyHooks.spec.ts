import { describe, expect, it } from 'vitest'
import { command, hookArgv, isManagedHookCommand, quoteHookCommand } from './notifyHooks.js'
import { HookPreparationHeld } from './nativeHookFiles.js'

it.each([
  "node '/fixture/notify.mjs' --port 19473 --data-dir '/fixture/harness'",
  "'/fixture/node' '/fixture/has space/notify.mjs' --data-dir '/fixture/harness' --port 19473 --engine codex",
  "'/fixture/node' '/fixture/home/.harness/cli/hook/notify.mjs' 19473 codex",
  "node '/fixture/notify.mjs' --port 19473 --data-dir '/fixture/harness' --engine copilot --copilot-event sessionStart",
])('recognizes a literal managed hook protocol: %s', command => {
  expect(isManagedHookCommand(command)).toBe(true)
})

it.each([
  undefined, 42, '', 'node /project/notify.mjs',
  'node /project/notify.mjs --port 19473',
  'echo node /fixture/notify.mjs --port 19473 --data-dir /fixture/harness',
  'node /fixture/notify.mjs --port 19473 --data-dir /fixture/harness; echo foreign',
  'node /fixture/notify.mjs --port 19473 --data-dir /fixture/harness --data-dir /other',
  'node /fixture/notify.mjs --port 19473 --data-dir',
  'node /fixture/notify.mjs --port 19473 --data-dir relative',
  'node /fixture/notify.mjs --port 19473 --data-dir "$HOME"',
  "node '/unterminated/notify.mjs --port 19473 --data-dir /fixture/harness",
])('does not claim a foreign or nonliteral command: %s', command => {
  expect(isManagedHookCommand(command)).toBe(false)
})

describe('quoteHookCommand', () => {
  const argv = ['C:\\Program Files\\Harness\\node.exe', 'C:\\Users\\Thảo Nguyễn\\.harness\\cli\\notify.mjs',
    '--port', '18473', '--data-dir', 'C:\\Users\\Thảo Nguyễn\\.harness\\cli\\data', '--engine', 'codex']

  it('hands the list itself to a runner that starts the program (Claude Code exec form)', () => {
    expect(quoteHookCommand('argv', argv)).toEqual(argv)
  })

  it('quotes for bash as every POSIX release has: words bare, everything else single-quoted', () => {
    expect(quoteHookCommand('bash', ['/opt/n o/node', "/it's/notify.mjs", '--port', '19473', '--engine', 'codex']))
      .toBe("'/opt/n o/node' '/it'\\''s/notify.mjs' --port 19473 --engine codex")
  })

  it('quotes for cmd.exe with double quotes', () => {
    expect(quoteHookCommand('cmd', argv)).toBe('"C:\\Program Files\\Harness\\node.exe" "C:\\Users\\Thảo Nguyễn\\.harness\\cli\\notify.mjs"'
      + ' --port 18473 --data-dir "C:\\Users\\Thảo Nguyễn\\.harness\\cli\\data" --engine codex')
  })

  it('quotes for PowerShell with single quotes after the call operator', () => {
    expect(quoteHookCommand('powershell', ['C:\\a b\\node.exe', "C:\\O'Brien\\notify.mjs", '--port', '1']))
      .toBe("& 'C:\\a b\\node.exe' 'C:\\O''Brien\\notify.mjs' --port 1")
  })

  it.each([
    ['cmd', 'C:\\100%\\data'], ['cmd', 'C:\\wow!\\data'], ['cmd', 'C:\\a"b'], ['cmd', 'C:\\data\\'],
    ['powershell', 'C:\\a"b'], ['powershell', 'C:\\a\u2019b'],
    ['bash', 'line\nbreak'], ['argv', 'nul\0'],
  ] as const)('refuses what %s would read as something other than one argument: %j', (runner, value) => {
    expect(() => quoteHookCommand(runner, ['C:\\node.exe', value])).toThrow(HookPreparationHeld)
  })

  it('builds the POSIX command line from the same argument list as before', () => {
    expect(command(19473, 'codex')).toBe(quoteHookCommand('bash', hookArgv(19473, 'codex')))
    expect(hookArgv(19473, 'codex').slice(2, 4)).toEqual(['--port', '19473'])
    expect(hookArgv(19473, 'codex').slice(-2)).toEqual(['--engine', 'codex'])
  })
})

describe('quoteHookCommand injection', () => {
  it('keeps cmd metacharacters inert inside quotes and keeps PowerShell expansion characters literal', () => {
    expect(quoteHookCommand('cmd', ["C:\\node.exe", "C:\\a&b|c<d>e^f\\x"])).toBe("\"C:\\node.exe\" \"C:\\a&b|c<d>e^f\\x\"")
    expect(quoteHookCommand('powershell', ['C:\\node.exe', 'C:\\a$(calc);`b\\x'])).toBe("& 'C:\\node.exe' 'C:\\a$(calc);`b\\x'")
  })
  it('refuses a cmd or PowerShell argument that closes its quote, then runs a command', () => {
    expect(() => quoteHookCommand('cmd', ['C:\\node.exe', 'x" & calc & "'])).toThrow(HookPreparationHeld)
    expect(() => quoteHookCommand('powershell', ['C:\\node.exe', 'x" ; calc ; "'])).toThrow(HookPreparationHeld)
    expect(() => quoteHookCommand('cmd', [])).toThrow(HookPreparationHeld)
  })
})
