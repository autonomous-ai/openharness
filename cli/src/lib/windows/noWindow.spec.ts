import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ownProcessGroup } from './noWindow.js'

const SOURCE = fileURLToPath(new URL('../..', import.meta.url))

/** The only places a process may still start detached on Windows, and why that opens no window (docs/windows-rules.md, rule 1). */
const ALLOWED: Record<string, string> = {
  'lib/ptyHost/launch.ts': 'the pty host must outlive the daemon, and what it starts runs in its own pseudo console',
  'engines/kit/windowsInstall.ts': 'a runner that must outlive the daemon, and starts the installer itself with windowsHide',
  'engines/kit/nativeInstall.ts': 'macOS and Linux only: Windows takes createWindowsInstallations (core/main.ts)',
  'services/osDevice.ts': 'nmcli and the like, on Harness OS: never on Windows',
  'lib/appModels.ts': 'a model server must outlive the daemon, and starts no console program',
  'lib/connectors/command.ts': 'the Connectors page must outlive this command, and starts no console program',
  'core/main.ts': 'a core an older release started with no master: Windows always has one (harness-launch.exe)',
  'cli.ts': 'a build run from a checkout: an installed copy starts through harness-launch.exe',
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'testing' || entry.name === 'e2e' || entry.name === '__fixtures__' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.(spec|test|d)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Each `detached:` in a file's code that is not plainly false. Read from its syntax, so a comment or a string names nothing. */
function detachedOptions(file: string): number {
  const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false)
  let found = 0
  const visit = (node: ts.Node): void => {
    const named = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isIdentifier(node.name) && node.name.text === 'detached'
    if (named && !(ts.isPropertyAssignment(node) && node.initializer.kind === ts.SyntaxKind.FalseKeyword)) found++
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

describe('no window flashes on Windows', () => {
  it('starts in its own group on macOS and Linux, and hidden, never detached, on Windows', () => {
    expect(ownProcessGroup('darwin')).toEqual({ detached: true })
    expect(ownProcessGroup('linux')).toEqual({ detached: true })
    expect(ownProcessGroup('win32')).toEqual({ windowsHide: true })
  })

  it('has no `detached` outside ownProcessGroup but the places listed with their reason', () => {
    const helper = join('lib', 'windows', 'noWindow.ts')
    const found = sources(SOURCE).map(file => relative(SOURCE, file)).filter(file => file !== helper && detachedOptions(join(SOURCE, file)) > 0)
      .map(file => file.split(sep).join('/'))
    // A new one? Use ownProcessGroup(). See docs/windows-rules.md for why windowsHide beside detached does not work.
    expect(found.filter(file => !(file in ALLOWED))).toEqual([])
    // And a reason nothing needs any more goes.
    expect(Object.keys(ALLOWED).filter(file => !found.includes(file))).toEqual([])
  })
})
