import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertRebranded, assertUnchanged, GATE_ID, rebrand, stamp } from './throwawayApp.js'

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
