import { describe, expect, it } from 'vitest'
import { command, hookArgv, isManagedHook, isManagedHookCommand, isOurs, quoteHookCommand } from './notifyHooks.js'
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
    ['cmd', 'C:\\100%\\data'], ['cmd', 'C:\\wow!\\data'], ['cmd', 'C:\\a"b'], ['cmd', 'C:\\'], ['cmd', 'data\\'],
    ['cmd', 'a&b'], ['cmd', 'a|b'], ['cmd', 'a<b'], ['cmd', 'a>b'], ['cmd', 'a^b'], ['cmd', 'a(b'], ['cmd', 'a)b'],
    ['powershell', 'C:\\a"b'], ['powershell', 'C:\\'], ['powershell', '\\\\server\\share\\'], ['powershell', ''],
    ['powershell', 'C:\\a\u2018b'], ['powershell', 'C:\\a\u2019b'], ['powershell', 'C:\\a\u201ab'], ['powershell', 'C:\\a\u201bb'],
    ['bash', 'a\rb'],
    ['bash', 'line\nbreak'], ['argv', 'nul\0'],
  ] as const)('refuses what %s would read as something other than one argument: %j', (runner, value) => {
    expect(() => quoteHookCommand(runner, ['C:\\node.exe', value])).toThrow(HookPreparationHeld)
  })

  // Final review R2-3: CODEX_HOME=C:\codex\, as the Windows environment dialog takes a folder, turned the Codex, Copilot
  // and Command Code hooks off ("ends in a backslash"). A folder's trailing separators name the same folder; a drive
  // root has nothing to drop and is still refused.
  it('drops the trailing backslashes of a Windows folder for cmd.exe and PowerShell, and keeps them for the others', () => {
    expect(quoteHookCommand('cmd', ['C:\\node.exe', '--codex-home', 'C:\\codex\\'])).toBe('"C:\\node.exe" --codex-home "C:\\codex"')
    expect(quoteHookCommand('powershell', ['C:\\node.exe', '--codex-home', 'C:\\My Codex\\\\'])).toBe("& 'C:\\node.exe' --codex-home 'C:\\My Codex'")
    expect(quoteHookCommand('argv', ['C:\\node.exe', 'C:\\codex\\'])).toEqual(['C:\\node.exe', 'C:\\codex\\'])
  })

  it('builds the POSIX command line from the same argument list as before', () => {
    expect(command(19473, 'codex')).toBe(quoteHookCommand('bash', hookArgv(19473, 'codex')))
    expect(hookArgv(19473, 'codex').slice(2, 4)).toEqual(['--port', '19473'])
    expect(hookArgv(19473, 'codex').slice(-2)).toEqual(['--engine', 'codex'])
  })
})

describe('quoteHookCommand injection', () => {
  it('refuses cmd metacharacters, names a non-text argument, and keeps PowerShell expansion characters literal', () => {
    expect(() => quoteHookCommand('cmd', ['C:\\node.exe', 'C:\\a&b|c<d>e^f\\x'])).toThrow(HookPreparationHeld)
    expect(() => quoteHookCommand('bash', ['x', 5 as unknown as string])).toThrow(/is not text/)
    expect(quoteHookCommand('powershell', ['C:\\node.exe', 'C:\\a$(calc);`b\\x'])).toBe("& 'C:\\node.exe' 'C:\\a$(calc);`b\\x'")
  })
  it('refuses a cmd or PowerShell argument that closes its quote, then runs a command', () => {
    expect(() => quoteHookCommand('cmd', ['C:\\node.exe', 'x" & calc & "'])).toThrow(HookPreparationHeld)
    expect(() => quoteHookCommand('powershell', ['C:\\node.exe', 'x" ; calc ; "'])).toThrow(HookPreparationHeld)
    expect(() => quoteHookCommand('cmd', [])).toThrow(HookPreparationHeld)
  })
})

describe('the hooks Harness writes on Windows', () => {
  const cmdLine = '"C:\\Program Files\\Harness\\node.exe" "C:\\Users\\u\\.harness\\cli\\notify.mjs" --port 18473'
    + ' --data-dir "C:\\Users\\u\\.harness\\cli\\data" --engine codex'
  const psLine = "& 'C:\\Users\\u\\.harness\\runtime\\node\\node.exe' 'C:\\Users\\u\\.harness\\cli\\notify.mjs' --port 18473"
    + " --data-dir 'C:\\Users\\u\\.harness\\cli\\data' --engine copilot --copilot-event sessionStart"

  it('recognizes its cmd.exe and PowerShell lines on Windows only', () => {
    expect(isManagedHookCommand(cmdLine, 'win32')).toBe(true)
    expect(isManagedHookCommand(psLine, 'win32')).toBe(true)
    expect(isManagedHookCommand(cmdLine, 'darwin')).toBe(false)
    expect(isManagedHookCommand(psLine, 'linux')).toBe(false)
  })

  it('recognizes every line quoteHookCommand writes', () => {
    const argv = ["C:\\O'Brien co\\node.exe", 'C:\\h x\\notify.mjs', '--port', '1', '--data-dir', 'C:\\h\\data', '--engine', 'commandcode']
    expect(isManagedHookCommand(quoteHookCommand('cmd', argv), 'win32')).toBe(true)
    expect(isManagedHookCommand(quoteHookCommand('powershell', argv), 'win32')).toBe(true)
  })

  it.each([
    cmdLine + ' & calc',
    cmdLine.replace('--port 18473', '--port %PORT%'),
    '"C:\\tools\\other.exe" "C:\\Users\\u\\notify.mjs" --port 1 --data-dir "C:\\d"',
    '"C:\\node.exe" "relative\\notify.mjs" --port 1 --data-dir "C:\\d"',
    psLine + '; Remove-Item C:\\',
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir $env:TEMP",
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d' --data-dir 'C:\\e'",
  ])('claims no other Windows line: %s', (line) => {
    expect(isManagedHookCommand(line, 'win32')).toBe(false)
  })

  it('recognizes Claude Code exec form (command and args) on Windows only', () => {
    const hook = { type: 'command', command: 'C:\\h\\node.exe', args: ['C:\\h\\notify.mjs', '--port', '18473', '--data-dir', 'C:\\h\\data'] }
    expect(isManagedHook(hook, 'win32')).toBe(true)
    expect(isManagedHook({ ...hook, args: [...hook.args, '--evil'] }, 'win32')).toBe(false)
    expect(isManagedHook({ ...hook, args: 'C:\\h\\notify.mjs' }, 'win32')).toBe(false)
    expect(isManagedHook(hook, 'darwin')).toBe(false)
    expect(isOurs({ hooks: [hook] })).toBe(process.platform === 'win32')
  })

  it('answers a POSIX hook as before, on every platform', () => {
    const line = "'/fixture/node' '/fixture/notify.mjs' --data-dir '/fixture/harness' --port 19473 --engine codex"
    expect(isManagedHookCommand(line, 'darwin')).toBe(true)
    expect(isManagedHook({ type: 'command', command: line }, 'linux')).toBe(true)
    // An `args` beside a POSIX line is ignored off Windows, as it always was.
    expect(isManagedHook({ type: 'command', command: line, args: ['x'] }, 'darwin')).toBe(true)
  })

  it.each([
    // a user's own notify.mjs hook: other flags, another path, trailing commands, a trailing backslash, an empty argument
    '"C:\\node.exe" "C:\\notify.mjs" --port 1 --data-dir "C:\\d" --verbose',
    '"C:\\node.exe" "C:\\notify.mjs" --port 1 --data-dir "C:\\d" && echo hi',
    '"C:\\node.exe" "C:\\notify.mjs" --port 1 --data-dir "C:\\d\\"',
    '"C:\\node.exe" "C:\\notify.mjs" --port 1 --data-dir "C:\\d^&x"',
    '"C:\\node.exe" "C:\\notify.mjs" --port 1 --data-dir "C:\\d"  --engine codex',
    '"C:\\node.exe" "C:\\notify.mjs" --port 1 --data-dir "C:\\d" "',
    '"C:\\python.exe" "C:\\notify.mjs" --port 1 --data-dir "C:\\d"',
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d' --verbose",
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d\\'",
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir ''",
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d' | tee x",
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d' $(calc)",
    "& 'C:\\node.exe' 'C:\\other\\script.mjs' --port 1 --data-dir 'C:\\d'",
    "& 'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d' --engine \u2018x\u2019",
  ])('does not claim a look-alike user hook on Windows: %s', (line) => {
    expect(isManagedHookCommand(line, 'win32')).toBe(false)
    expect(isManagedHook({ type: 'command', command: line }, 'win32')).toBe(false)
  })

  // Carried B4.2 / final review R2-1: on a Windows host the POSIX branch used the win32 path module, so a person's
  // POSIX-quoted line with drive paths counted as Harness's, and could be replaced or removed, though cmd would run what
  // follows its `&`. Harness never writes such a line: no engine runs its hooks through bash on Windows (Claude Code
  // takes exec form). POSIX lines are judged by POSIX path rules on every host; a line synced from a Mac still counts.
  it('reads a single-quoted line as the POSIX line it is, by POSIX path rules on every host', () => {
    for (const line of [
      "'C:\\node.exe' 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d'",
      "node 'C:\\notify.mjs' --port 1 --data-dir 'C:\\d & calc'",
    ]) {
      expect(isManagedHookCommand(line, 'win32')).toBe(false)
      expect(isManagedHook({ type: 'command', command: line }, 'win32')).toBe(false)
    }
    const synced = "'/Users/a/.harness/runtime/node' '/Users/a/.harness/cli/notify.mjs' --port 1 --data-dir '/Users/a/.harness/cli/data'"
    expect(isManagedHookCommand(synced, 'win32')).toBe(true)
  })

  it('does not claim a look-alike exec form', () => {
    const hook = { type: 'command', command: 'C:\\h\\node.exe', args: ['C:\\h\\notify.mjs', '--port', '1', '--data-dir', 'C:\\h\\data'] }
    expect(isManagedHook({ ...hook, command: 'C:\\h\\python.exe' }, 'win32')).toBe(false)
    expect(isManagedHook({ ...hook, args: ['notify.mjs', '--port', '1', '--data-dir', 'C:\\h'] }, 'win32')).toBe(false)
    expect(isManagedHook({ ...hook, args: [...hook.args, '--port', '2'] }, 'win32')).toBe(false)
    expect(isManagedHook({ ...hook, args: ['C:\\h\\notify.mjs', '--port', '1', '--data-dir', 'C:\\h', 7] }, 'win32')).toBe(false)
    expect(isManagedHook({ command: 5, args: [] }, 'win32')).toBe(false)
    expect(isManagedHook(null, 'win32')).toBe(false)
  })
})
