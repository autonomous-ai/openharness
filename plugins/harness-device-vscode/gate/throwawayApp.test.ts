import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  appBundles,
  assertRebranded,
  assertUnchanged,
  forgetPreferences,
  GATE_ID,
  killThrowaway,
  rebrand,
  removeOwnFolders,
  rootName,
  stamp,
  startedAt,
  sweepLeftovers,
  unregister,
  VSCODE_PREFERENCES,
  windowsThrowaway,
  type WindowsProcess,
} from './throwawayApp.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'throwaway-app-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const plistId = (bundle: string): string =>
  execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
const signedId = (bundle: string): string =>
  /^Identifier=(.+)$/m.exec(spawnSync('codesign', ['-dv', bundle], { encoding: 'utf8' }).stderr)?.[1] ?? ''

/** An app bundle as VS Code's is laid out, its executables a copy of `true`: what codesign needs to sign it. */
function bundle(path: string, executable: string, id: string): string {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  copyFileSync('/usr/bin/true', join(path, 'Contents', 'MacOS', executable))
  writeFileSync(join(path, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`)
  return path
}

function vscodeApp(): { app: string; helpers: string[] } {
  const app = bundle(join(root, 'Visual Studio Code.app'), 'Code', 'com.microsoft.VSCode')
  const helpers = ['Code Helper', 'Code Helper (Renderer)'].map((name) =>
    bundle(join(app, 'Contents', 'Frameworks', `${name}.app`), name, 'com.microsoft.VSCode.helper'))
  return { app, helpers }
}

describe.runIf(process.platform === 'darwin')('the throwaway VS Code app', () => {
  it('gives the app and each helper an id of its own, and signs each with it', () => {
    const { app, helpers } = vscodeApp()
    rebrand(app)
    expect([plistId(app), signedId(app)]).toEqual([GATE_ID, GATE_ID])
    for (const helper of helpers) expect([plistId(helper), signedId(helper)]).toEqual([`${GATE_ID}.helper`, `${GATE_ID}.helper`])
  })

  it('refuses a copy in which a helper still carries Microsoft\'s id', () => {
    const { app } = vscodeApp()
    execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', GATE_ID, join(app, 'Contents', 'Info.plist')])
    expect(() => assertRebranded(app)).toThrow(/Code Helper\.app.*com\.microsoft\.VSCode\.helper/)
  })

  it('refuses a copy whose signature still carries Microsoft\'s id', () => {
    const { app, helpers } = vscodeApp()
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' })
    for (const path of [app, ...helpers]) execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', GATE_ID, join(path, 'Contents', 'Info.plist')])
    expect(() => assertRebranded(app)).toThrow(/signed.*com\.microsoft\.VSCode/)
  })

  /** What VS Code's Info.plist claims, so macOS sends it `vscode:` links and the files it opens. */
  const claims = ['CFBundleURLTypes', 'CFBundleDocumentTypes', 'UTExportedTypeDeclarations', 'UTImportedTypeDeclarations']
  const claim = (app: string, key: string): void => {
    const value = key === 'CFBundleURLTypes' ? [{ CFBundleURLName: 'Visual Studio Code', CFBundleURLSchemes: ['vscode'] }] : [{}]
    execFileSync('plutil', ['-insert', key, '-json', JSON.stringify(value), join(app, 'Contents', 'Info.plist')])
  }
  const claimed = (app: string): string[] =>
    claims.filter((key) => spawnSync('plutil', ['-extract', key, 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]).status === 0)

  it('drops the copy\'s claims on links and files, so no vscode:// link goes to it', () => {
    const { app } = vscodeApp()
    for (const key of claims) claim(app, key)
    expect(claimed(app)).toEqual(claims)
    rebrand(app)
    expect(claimed(app)).toEqual([])
  })

  it('refuses a copy that still claims vscode:// links', () => {
    const { app } = vscodeApp()
    rebrand(app)
    claim(app, 'CFBundleURLTypes')
    expect(() => assertRebranded(app)).toThrow(/Visual Studio Code\.app.*CFBundleURLTypes/)
  })

  it('names each app LaunchServices registers apart, as it records them: the app and each helper', () => {
    const { app, helpers } = vscodeApp()
    expect(appBundles(app).sort()).toEqual([app, ...helpers].map((path) => realpathSync(path)).sort())
  })

  it('passes over an app LaunchServices never registered, as a helper that never ran', () => {
    expect(() => unregister(vscodeApp().app)).not.toThrow()
  })
})

// A shell of /bin/sh: Windows' clean-up is the table's below.
describe.skipIf(process.platform === 'win32')('the throwaway\'s processes', () => {
  /** A shell that ignores SIGTERM, as a VS Code that will not quit does, and ends when its input does, so a failed test
   *  leaves nothing running. */
  function stubborn(script: string, ...args: string[]) {
    const child = spawn('/bin/sh', ['-c', `trap "" TERM; ${script}`, ...args], { stdio: ['pipe', 'pipe', 'ignore'] })
    onTestFinished(() => {
      child.stdin.destroy()
    })
    return child
  }

  it('kills what carries the root\'s name, its child and a shell still the one reported, and nothing else', async () => {
    // Its child carries no name once it says it started, and holds the output pipe too: the pipe closes only when both
    // are gone.
    const inside = stubborn(`exec 3<&0; /bin/sh -c 'echo started; exec /bin/cat <&3' & wait`, basename(root))
    const insideStarted = once(inside.stdout, 'data')
    const insideGone = once(inside, 'close')
    const reported = stubborn('read line')
    const reportedEnd = once(reported, 'exit')
    // Reported too, by its pid but with another start: a process that took a shell's pid after it ended.
    const outside = stubborn('read line; echo "$line"', 'outside')
    await Promise.all([insideStarted, once(reported, 'spawn'), once(outside, 'spawn')])

    const names = await killThrowaway(root, new Map([[reported.pid!, (await startedAt(reported.pid!))!], [outside.pid!, 'not when it started']]))

    await insideGone
    expect((await reportedEnd)[1]).toBe('SIGKILL')
    const echo = once(outside.stdout, 'data')
    outside.stdin.end('alive\n')
    expect(String((await echo)[0])).toBe('alive\n')
    expect(names).toEqual(expect.arrayContaining(['cat', 'sh']))
  }, 10_000)

  it('sweeps the root of a run that has ended, and leaves a running run\'s', async () => {
    const ended = spawnSync('/usr/bin/true').pid
    const left = mkdtempSync(join(root, rootName(ended)))
    const live = mkdtempSync(join(root, rootName(process.pid)))
    const stray = stubborn('read line', basename(left))
    const strayEnd = once(stray, 'exit')
    const running = stubborn('read line', basename(live))
    const runningEnd = once(running, 'exit')
    await Promise.all([once(stray, 'spawn'), once(running, 'spawn')])

    await sweepLeftovers(root)

    expect([existsSync(left), existsSync(live)]).toEqual([false, true])
    expect((await strayEnd)[1]).toBe('SIGKILL')
    running.stdin.end('done\n')
    expect(await runningEnd).toEqual([0, null])
  }, 10_000)
})

describe('the throwaway\'s processes on Windows, from the process table', () => {
  const root = 'C:\\Users\\Nguyễn Văn A\\AppData\\Local\\Temp\\harness-vscode-gate-4242-Ab12Cd'
  // FILETIMEs: the later a process started, the larger.
  const at = (n: number): string => String(134_000_000_000_000_000n + BigInt(n))
  const row = (pid: number, ppid: number, started: number, command: string): WindowsProcess =>
    ({ pid, ppid, name: `p${pid}.exe`, command, started: at(started) })
  const selected = (table: WindowsProcess[], shells?: Map<number, string>): number[] =>
    windowsThrowaway(table, root, shells).map(({ pid }) => pid).sort((a, b) => a - b)

  it('selects what runs from the root, in any case, and its descendants, and nothing outside', () => {
    const table = [
      row(10, 4, 1, `${root}\\vscode\\vscode-win32-arm64-archive-1.147.0\\Code.exe "${root}\\vscode\\…\\Code.exe" --user-data-dir ${root}\\user-data`),
      // The pty host, started by VS Code; the shell it started, from System32; conhost under that.
      row(11, 10, 2, 'C:\\Windows\\System32\\cmd.exe cmd /c ptyhost'),
      row(12, 11, 3, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe powershell.exe'),
      row(13, 12, 4, 'C:\\Windows\\System32\\conhost.exe conhost.exe 0xffffffff'),
      // Named by its argument alone, in another case.
      row(20, 4, 5, `C:\\Program Files\\nodejs\\node.exe node.exe ${root.toUpperCase()}\\app.bin`),
      // The developer's own: Explorer, a VS Code, a shell.
      row(4, 1, 0, 'C:\\Windows\\explorer.exe C:\\Windows\\Explorer.EXE'),
      row(30, 4, 6, 'C:\\Users\\Nguyễn Văn A\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe "Code.exe"'),
      row(31, 30, 7, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe powershell.exe'),
      // Another run's root whose name starts with this one's, and one beside it with a longer name.
      row(40, 4, 8, `${root}0\\Code.exe Code.exe`),
      row(41, 4, 9, `${root}-x\\Code.exe Code.exe`),
      // Another account's process: Windows gives no path or command line.
      row(50, 4, 10, ' '),
    ]
    expect(selected(table)).toEqual([10, 11, 12, 13, 20])
  })

  it('takes no child of a pid Windows gave the throwaway after the child\'s parent ended', () => {
    // Process 10 started at 5; 60 started at 2, under an earlier process that had pid 10.
    const table = [
      row(10, 4, 5, `${root}\\Code.exe Code.exe`),
      row(60, 10, 2, 'C:\\Windows\\System32\\svchost.exe svchost.exe'),
      row(61, 60, 3, 'C:\\Windows\\System32\\conhost.exe conhost.exe'),
    ]
    expect(selected(table)).toEqual([10])
  })

  it('selects a reported shell, and its children, only while it is the process reported', () => {
    const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe powershell.exe'
    const table = [row(70, 4, 1, shell), row(71, 70, 2, 'C:\\Windows\\System32\\conhost.exe conhost.exe'), row(72, 4, 3, shell)]
    // 70 as reported; 72 reported, but it is a later process given that pid.
    expect(selected(table, new Map([[70, at(1)], [72, at(0)]]))).toEqual([70, 71])
  })
})

describe('the throwaway\'s own preferences, caches and HTTP storage', () => {
  const plist = (): string => join(root, 'Preferences', `${GATE_ID}.plist`)
  beforeEach(() => {
    mkdirSync(join(root, 'Preferences'))
    writeFileSync(plist(), '')
  })
  const deleted = { status: 0, stderr: '' }

  it('deletes the gate\'s own domain through defaults, and no other, then the empty file defaults leaves', () => {
    const calls: [string, readonly string[]][] = []
    forgetPreferences(root, (file, args) => {
      calls.push([file, args])
      return deleted
    })
    expect(calls).toEqual([['/usr/bin/defaults', ['delete', GATE_ID]]])
    expect(JSON.stringify(calls)).not.toContain('com.microsoft')
    expect(existsSync(plist())).toBe(false)
  })

  it('passes a domain already gone, removing the empty file it leaves, and fails on any other failure', () => {
    // What defaults says of a domain an earlier delete emptied, whose file cfprefsd kept.
    const notFound = { status: 1, stderr: `defaults[1:2] \nDomain (${GATE_ID}) not found.\nDefaults have not been changed.\n` }
    expect(() => forgetPreferences(root, () => notFound)).not.toThrow()
    expect(existsSync(plist())).toBe(false)
    expect(() => forgetPreferences(root, () => ({ status: 1, stderr: 'Could not write domain' }))).toThrow(/defaults delete/)
  })

  it('removes each folder named the id, or the id and a dot, and none other', () => {
    const others = [`${GATE_ID}x`, `${GATE_ID}-other`, 'com.microsoft.VSCode', 'com.microsoft.VSCode.ShipIt']
    for (const folder of ['Caches', 'HTTPStorages']) {
      for (const name of [GATE_ID, `${GATE_ID}.ShipIt`, ...others]) mkdirSync(join(root, folder, name), { recursive: true })
    }
    removeOwnFolders(root)
    for (const folder of ['Caches', 'HTTPStorages']) expect(readdirSync(join(root, folder)).sort()).toEqual([...others].sort())
  })
})

describe('the developer\'s VS Code preferences, before and after', () => {
  const contents = 'a secret the gate never prints'

  it('passes a file left as it was, and one absent before and after', () => {
    const file = join(root, 'com.microsoft.VSCode.plist')
    expect(stamp(file)).toBeNull()
    expect(() => assertUnchanged(file, null)).not.toThrow()
    writeFileSync(file, contents)
    const before = stamp(file)
    expect(() => assertUnchanged(file, before)).not.toThrow()
  })

  it('fails on a file rewritten, touched, made or removed, and never shows what it holds', () => {
    const file = join(root, 'com.microsoft.VSCode.plist')
    writeFileSync(file, contents)
    const before = stamp(file)
    const { atime, mtime } = statSync(file)

    writeFileSync(file, `${contents}!`)
    utimesSync(file, atime, mtime)
    expect(() => assertUnchanged(file, before)).toThrow(/VS Code's preferences changed/)
    try {
      assertUnchanged(file, before)
    } catch (error) {
      expect((error as Error).message).not.toContain(contents)
    }

    writeFileSync(file, contents)
    utimesSync(file, atime, new Date(mtime.getTime() + 1000))
    expect(() => assertUnchanged(file, before)).toThrow(/VS Code's preferences changed/)

    unlinkSync(file)
    expect(() => assertUnchanged(file, before)).toThrow(/VS Code's preferences changed/)
    writeFileSync(file, contents)
    expect(() => assertUnchanged(file, null)).toThrow(/VS Code's preferences changed/)
  })

  // The preferences are a Mac's.
  it.skipIf(process.platform === 'win32')('names the developer\'s preferences from ~, never by the account\'s home', () => {
    // It only reads the file, and fails on a stamp no file has.
    expect(() => assertUnchanged(VSCODE_PREFERENCES, { mtimeMs: -1, sha256: '' })).toThrow(/~\/Library\/Preferences\/com\.microsoft\.VSCode\.plist/)
    try {
      assertUnchanged(VSCODE_PREFERENCES, { mtimeMs: -1, sha256: '' })
    } catch (error) {
      expect((error as Error).message).not.toContain(userInfo().homedir)
    }
  })
})
