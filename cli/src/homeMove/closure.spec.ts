/**
 * What the move loads (docs/plans/2026-11-18-linux-xdg-paths-plan.md, Global Constraints and Layers). It runs at a start
 * before config/env.ts loads, so nothing it reaches may resolve a path as it loads; the start commands alone load it,
 * before anything of the daemon; neither the core nor the master ever does.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')

/**
 * The modules beyond Node and its own folder the move may import. config/envFields.ts is there for homePath, the one
 * rule for a relative Harness folder or file: it imports only node:os and node:path and resolves nothing as it loads
 * (homedir() runs only on a call). lib/log.ts is there for errorKind: a log line names a failure by its kind (the
 * lock's watch, secureState.ts's set-aside); it imports only node:crypto and node:fs.
 */
const DOORS = ['config/harnessHome.ts', 'lib/harnessSessionLabel.ts', 'engines/kit/homeAdoption.ts', 'config/envFields.ts', 'lib/log.ts']
/** What homeAdoption.ts reaches: Node, and modules that import Node or each other and resolve no path as they load. */
const BEHIND_ADOPTION = [
  'engines/kit/homeCatalog.ts', 'engines/kit/identityScan.ts', 'engines/kit/nativeEvidence.ts', 'engines/kit/windowsFiles.ts',
  'engines/kit/hookHeld.ts', 'lib/childLocale.ts', 'lib/secureState.ts',
]

const sources = (folder: string): string[] => readdirSync(join(SRC, folder), { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(name))
  .map((name) => `${folder}/${name}`)

const OWN = sources('homeMove')

interface Named { from: string; dynamic: boolean; node: ts.Node }

/** Every module a source names: imported, re-exported, for its types only, or with import(). */
function named(file: string): Named[] {
  const found: Named[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ from: node.moduleSpecifier.text, dynamic: false, node })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.push({ from: node.arguments[0].text, dynamic: true, node })
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, readFileSync(join(SRC, file), 'utf8'), ts.ScriptTarget.Latest, true))
  return found
}

/** A relative import's file under src, as `folder/name.ts`; any other as it is written. */
const target = (file: string, from: string): string => from.startsWith('.') ? relative(SRC, resolve(SRC, dirname(file), from)).replace(/\.js$/, '.ts') : from

describe('what the move loads', () => {
  it('its files import only Node, the five modules it may, and its own folder', () => {
    for (const file of OWN) {
      for (const { from } of named(file)) {
        const to = target(file, from)
        expect(from.startsWith('node:') || DOORS.includes(to) || to.startsWith('homeMove/'), `${file} imports ${from}`).toBe(true)
      }
    }
  })

  it('every file it reaches is its own, those five, or the seven behind homeAdoption.ts, and they import only Node', () => {
    const reached = new Set<string>(), packages = new Set<string>()
    const pending = [...OWN]
    while (pending.length > 0) {
      const file = pending.pop()!
      if (reached.has(file)) continue
      reached.add(file)
      for (const { from } of named(file)) {
        if (from.startsWith('.')) pending.push(target(file, from))
        else packages.add(from)
      }
    }
    expect([...reached].sort()).toEqual([...OWN, ...DOORS, ...BEHIND_ADOPTION].sort())
    expect(reached.has('config/env.ts')).toBe(false)
    expect([...packages].filter((from) => !from.startsWith('node:'))).toEqual([])
  })

  it('neither the core nor the master loads it', () => {
    const core = readFileSync(join(SRC, 'architecture.coreFiles.txt'), 'utf8').split('\n')
    expect(core.filter((line) => line.includes('homeMove/'))).toEqual([])
    const master = readdirSync(join(SRC, 'harnessd'), { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts')).map((name) => `harnessd/${name}`)
    for (const file of master) expect(named(file).filter(({ from }) => target(file, from).startsWith('homeMove/')).map(({ from }) => from), file).toEqual([])
  })

  it('entry.ts loads it with import() for start and __harnessd on Linux alone, before anything of the daemon', () => {
    const imports = named('entry.ts')
    const move = imports.filter(({ from }) => target('entry.ts', from).startsWith('homeMove/'))
    expect(move.map(({ from, dynamic }) => ({ from, dynamic }))).toEqual([{ from: './homeMove/start.js', dynamic: true }])
    for (const later of ['./cli.js', './masterProcess.js', './serviceProcess.js', './coreProcess.js']) {
      const at = imports.find(({ from }) => from === later)
      expect(at && at.node.getStart() > move[0].node.getStart(), later).toBe(true)
    }
    let guard: ts.Node | undefined = move[0].node
    while (guard && !ts.isIfStatement(guard)) guard = guard.parent
    const words: string[] = []
    const collect = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) words.push(node.text)
      else if (ts.isPropertyAccessExpression(node)) words.push(node.getText())
      ts.forEachChild(node, collect)
    }
    if (guard && ts.isIfStatement(guard)) collect(guard.expression)
    // macOS and Windows never move: they load none of it.
    expect(words.sort()).toEqual(['__harnessd', 'linux', 'process.platform', 'start'])
  })
})
