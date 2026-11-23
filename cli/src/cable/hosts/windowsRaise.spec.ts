import { describe, expect, it } from 'vitest'
import { APP_BUNDLES } from './hostDetect.js'
import { RUN_TIMEOUT_MS } from './orca.js'
import { createWindowsRaise, harnessDesktopLauncher, WINDOWS_APPS, type RaiseOutcome, type WindowsRaiseDeps } from './windowsRaise.js'

const PTY = 'C:\\Users\\a\\.harness\\runtime\\pty\\1.0.0\\harness-pty.exe'
const CURSOR_CLI = 'C:\\Users\\a\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd'
const LAUNCHER = 'C:\\Users\\a\\AppData\\Local\\Programs\\Harness\\Harness.exe'

type Answer = { code: number | null; stdout: string }
type Call = { file: string; args: string[]; timeoutMs: number }

/** A raise whose helper, CLI and launcher answer [answer] for each run, with the runs and the counts it saw. */
function raiseWith(answer: (call: Call) => Answer | Promise<Answer>, overrides: Partial<WindowsRaiseDeps> = {}) {
  const runs: Call[] = []
  const counts: RaiseOutcome[] = []
  const raise = createWindowsRaise({
    binary: () => PTY,
    run: async (file, args, timeoutMs) => {
      const call = { file, args, timeoutMs }
      runs.push(call)
      return answer(call)
    },
    cursorCli: () => CURSOR_CLI,
    desktopLauncher: () => LAUNCHER,
    count: (outcome) => counts.push(outcome),
    ...overrides,
  })
  return { raise, runs, counts }
}

const says = (stdout: string, code: number | null = 0) => () => ({ code, stdout })

describe('WINDOWS_APPS', () => {
  it('names each app a tap raises by the program that owns its window, and no other', () => {
    expect(WINDOWS_APPS).toEqual({
      [APP_BUNDLES.vscode]: 'Code.exe',
      [APP_BUNDLES.cursor]: 'Cursor.exe',
      [APP_BUNDLES.orca]: 'Orca.exe',
      [APP_BUNDLES.wezterm]: 'wezterm-gui.exe',
      [APP_BUNDLES.warp]: 'warp.exe',
      'org.alacritty': 'alacritty.exe',
      [APP_BUNDLES.claude]: 'Claude.exe',
      [APP_BUNDLES.codex]: 'ChatGPT.exe',
    })
  })
})

describe('createWindowsRaise app', () => {
  it.each([
    [APP_BUNDLES.vscode, 'Code.exe'],
    [APP_BUNDLES.wezterm, 'wezterm-gui.exe'],
    [APP_BUNDLES.warp, 'warp.exe'],
    ['org.alacritty', 'alacritty.exe'],
  ])('raises %s by its program %s through the helper', async (bundle, exe) => {
    const { raise, runs } = raiseWith(says('raised\n'))
    expect(await raise.app(bundle)).toBe(true)
    expect(runs).toEqual([{ file: PTY, args: ['raise', '--exe', exe], timeoutMs: RUN_TIMEOUT_MS }])
  })

  it.each(['raised', 'refused'] as const)('takes %s as a tap done, and counts it as itself', async (word) => {
    const { raise, counts } = raiseWith(says(`${word}\n`))
    expect(await raise.app(APP_BUNDLES.vscode)).toBe(true)
    expect(counts).toEqual([word])
  })

  it.each([
    ['the helper finds no window', says('none\n')],
    ['an older helper does not know the command', says('', 2)],
    ['the helper is unsupported here', says('{"unsupported":true}\n', 3)],
    ['the helper does not answer in time', says('', null)],
    ['the helper answers another word', says('raisedx\n')],
    ['a refused word comes with a failed exit', says('refused\n', 1)],
    ['the run fails to start', () => Promise.reject(new Error('spawn EACCES'))],
  ])('fails the tap and counts none when %s', async (_, answer) => {
    const { raise, counts } = raiseWith(answer)
    expect(await raise.app(APP_BUNDLES.vscode)).toBe(false)
    expect(counts).toEqual(['none'])
  })

  it('fails the tap with no helper, running nothing', async () => {
    const { raise, runs, counts } = raiseWith(says('raised\n'), { binary: () => null })
    expect(await raise.app(APP_BUNDLES.vscode)).toBe(false)
    expect(runs).toEqual([])
    expect(counts).toEqual(['none'])
  })

  it.each(['com.googlecode.iterm2', 'ai.autonomous.harness', 'Code.exe', ''])('fails a tap on %j, which has no program, running nothing', async (bundle) => {
    const { raise, runs, counts } = raiseWith(says('raised\n'))
    expect(await raise.app(bundle)).toBe(false)
    expect(runs).toEqual([])
    expect(counts).toEqual(['none'])
  })
})

describe('createWindowsRaise link', () => {
  const URL = 'vscode://anthropic.claude-code/open?session=0c5f3e9a-7f7b-4f1c-9a52-2f8d3a1b6c4e'

  it.each(['http://x', 'file:///c:/x', 'vscode:x', 'VSCODE://x', 'ms-settings://x'])('opens no %s, running nothing', async (url) => {
    const { raise, runs, counts } = raiseWith(says('opened\n'))
    expect(await raise.link(url, APP_BUNDLES.vscode)).toBe(false)
    expect(runs).toEqual([])
    expect(counts).toEqual([])
  })

  it('opens the link through the helper, then raises its app', async () => {
    const { raise, runs, counts } = raiseWith(({ args }) => ({ code: 0, stdout: args[0] === 'open-link' ? 'opened\n' : 'refused\n' }))
    expect(await raise.link(URL, APP_BUNDLES.vscode)).toBe(true)
    expect(runs).toEqual([
      { file: PTY, args: ['open-link', URL], timeoutMs: RUN_TIMEOUT_MS },
      { file: PTY, args: ['raise', '--exe', 'Code.exe'], timeoutMs: RUN_TIMEOUT_MS },
    ])
    expect(counts).toEqual(['refused'])
  })

  it('opens a link with no app named and raises nothing', async () => {
    const { raise, runs, counts } = raiseWith(says('opened\n'))
    expect(await raise.link('claude://claude.ai/claude-code/abc')).toBe(true)
    expect(runs.map((run) => run.args[0])).toEqual(['open-link'])
    expect(counts).toEqual([])
  })

  it.each([
    ['the scheme has no handler', says('refused\n')],
    ['an older helper does not know the command', says('', 2)],
    ['the helper does not answer in time', says('', null)],
    ['the run fails to start', () => Promise.reject(new Error('spawn EACCES'))],
  ])('is false when %s, and raises nothing', async (_, answer) => {
    const { raise, runs, counts } = raiseWith(answer)
    expect(await raise.link(URL, APP_BUNDLES.vscode)).toBe(false)
    expect(runs.map((run) => run.args[0])).toEqual(['open-link'])
    expect(counts).toEqual([])
  })

  it('is false with no helper, running nothing', async () => {
    const { raise, runs } = raiseWith(says('opened\n'), { binary: () => null })
    expect(await raise.link(URL, APP_BUNDLES.vscode)).toBe(false)
    expect(runs).toEqual([])
  })
})

describe('createWindowsRaise cursorFolder', () => {
  const FOLDER = "C:\\Users\\Nguyễn Văn A' & 100%\\src\\my app"

  it('runs Cursor\'s CLI with the folder as one argument, then raises Cursor', async () => {
    const { raise, runs, counts } = raiseWith(({ file }) => ({ code: 0, stdout: file === PTY ? 'raised\n' : '' }))
    expect(await raise.cursorFolder(FOLDER)).toBe(true)
    expect(runs).toEqual([
      { file: CURSOR_CLI, args: [FOLDER], timeoutMs: RUN_TIMEOUT_MS },
      { file: PTY, args: ['raise', '--exe', 'Cursor.exe'], timeoutMs: RUN_TIMEOUT_MS },
    ])
    expect(counts).toEqual(['raised'])
  })

  it.each([
    ['exits 1', says('', 1)],
    ['does not answer in time', says('', null)],
    ['fails to start', () => Promise.reject(new Error('spawn ENOENT'))],
  ])('is false when the CLI %s, and raises nothing', async (_, answer) => {
    const { raise, runs, counts } = raiseWith(answer)
    expect(await raise.cursorFolder(FOLDER)).toBe(false)
    expect(runs.map((run) => run.file)).toEqual([CURSOR_CLI])
    expect(counts).toEqual([])
  })

  it('is false with no CLI, running nothing', async () => {
    const { raise, runs } = raiseWith(says(''), { cursorCli: () => null })
    expect(await raise.cursorFolder(FOLDER)).toBe(false)
    expect(runs).toEqual([])
  })
})

describe('createWindowsRaise desktop', () => {
  it('starts Harness Desktop through its launcher with no argument, counting nothing', async () => {
    const { raise, runs, counts } = raiseWith(says(''))
    expect(await raise.desktop()).toBe(true)
    expect(runs).toEqual([{ file: LAUNCHER, args: [], timeoutMs: RUN_TIMEOUT_MS }])
    expect(counts).toEqual([])
  })

  it.each([
    ['exits 1', says('', 1)],
    ['does not answer in time', says('', null)],
    ['fails to start', () => Promise.reject(new Error('spawn ENOENT'))],
  ])('is false when the launcher %s', async (_, answer) => {
    const { raise, counts } = raiseWith(answer)
    expect(await raise.desktop()).toBe(false)
    expect(counts).toEqual([])
  })

  it('is false with no launcher, running nothing', async () => {
    const { raise, runs } = raiseWith(says(''), { desktopLauncher: () => null })
    expect(await raise.desktop()).toBe(false)
    expect(runs).toEqual([])
  })
})

describe('createWindowsRaise counts', () => {
  it('counts only the helper\'s three words, never an app', async () => {
    const { raise, counts } = raiseWith(({ args }) => ({ code: 0, stdout: args[0] === 'open-link' ? 'opened\n' : 'raised\n' }))
    for (const bundle of [...Object.keys(WINDOWS_APPS), 'com.googlecode.iterm2']) await raise.app(bundle)
    await raise.link('codex://threads/abc', APP_BUNDLES.codex)
    await raise.cursorFolder('C:\\src')
    await raise.desktop()
    expect(counts.length).toBe(Object.keys(WINDOWS_APPS).length + 3)
    for (const outcome of counts) expect(['raised', 'refused', 'none']).toContain(outcome)
  })
})

describe('harnessDesktopLauncher', () => {
  const LOCAL = "C:\\Users\\Nguyễn Văn A' & 100%\\AppData\\Local"
  const AT = `${LOCAL}\\Programs\\Harness\\Harness.exe`

  it('is the launcher in this account\'s programs folder when it is there', () => {
    const asked: string[] = []
    expect(harnessDesktopLauncher({ LOCALAPPDATA: LOCAL }, (file) => (asked.push(file), true))).toBe(AT)
    expect(asked).toEqual([AT])
  })

  it('is null when the launcher is not there', () => {
    expect(harnessDesktopLauncher({ LOCALAPPDATA: LOCAL }, () => false)).toBeNull()
  })

  it.each([
    ['no LOCALAPPDATA', {}],
    ['an empty LOCALAPPDATA', { LOCALAPPDATA: '' }],
    ['a relative LOCALAPPDATA', { LOCALAPPDATA: 'AppData\\Local' }],
    ['a drive-relative LOCALAPPDATA', { LOCALAPPDATA: 'C:AppData\\Local' }],
  ])('is null for %s, looking at nothing', (_, env) => {
    const asked: string[] = []
    expect(harnessDesktopLauncher(env, (file) => (asked.push(file), true))).toBeNull()
    expect(asked).toEqual([])
  })
})
