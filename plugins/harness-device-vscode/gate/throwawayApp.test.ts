import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  appBundles,
  assertRebranded,
  assertUnchanged,
  GATE_ID,
  killThrowaway,
  rebrand,
  rootName,
  stamp,
  startedAt,
  sweepLeftovers,
  unregister,
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

  it('names each app LaunchServices registers apart, as it records them: the app and each helper', () => {
    const { app, helpers } = vscodeApp()
    expect(appBundles(app).sort()).toEqual([app, ...helpers].map((path) => realpathSync(path)).sort())
  })

  it('passes over an app LaunchServices never registered, as a helper that never ran', () => {
    expect(() => unregister(vscodeApp().app)).not.toThrow()
  })
})

describe('the throwaway\'s processes', () => {
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

    const names = killThrowaway(root, new Map([[reported.pid!, startedAt(reported.pid!)!], [outside.pid!, 'not when it started']]))

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

    sweepLeftovers(root)

    expect([existsSync(left), existsSync(live)]).toEqual([false, true])
    expect((await strayEnd)[1]).toBe('SIGKILL')
    running.stdin.end('done\n')
    expect(await runningEnd).toEqual([0, null])
  }, 10_000)
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
})
