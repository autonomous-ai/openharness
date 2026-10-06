/**
 * Shared code does not name an engine (docs/design/2026-10-05-engine-interface.md, section 7). What an
 * engine does differently belongs in its folder, `src/engines/<engine>/`, behind the Engine interface;
 * shared code asks the registry (`src/engines/registry.ts`) instead of branching on the name. Every branch
 * on a name is a place the next engine has to be added by hand, and a place an engine nobody named gets
 * another engine's behaviour by default.
 *
 * Shared code still names engines in most of its files, so this lands as a ratchet: each file may name
 * engines at most as often as `engineNames.baseline.json` says, and a file not in it may not name one at
 * all. The migration's steps lower the counts; they do not edit the baseline, so steps on parallel
 * branches never conflict in it. Regenerate it after a batch of steps has merged:
 *
 *     ENGINE_NAMES_BASELINE=write npx vitest run src/engineNames.spec.ts
 *
 * When every count is zero the baseline goes and this becomes the plain rule.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PROCESS_ENGINES } from './engines/types.js'

const SRC = __dirname
const BASELINE = join(SRC, 'engineNames.baseline.json')
/** The shared code the rule covers. The rest of the shared folders join it when the migration ends. */
const SCOPE = ['core', 'lib', 'cli.ts', 'backendSocket.ts']

/** Engine names that are also ordinary words in this code (a terminal cursor, a page cursor), so as an
 *  identifier or a lone object key they are not taken for the engine. */
const ORDINARY_WORDS = new Set(['cursor', 'pi', 'amp'])
const NAMES = new Set<string>(PROCESS_ENGINES)
const DISTINCT = PROCESS_ENGINES.filter((name) => !ORDINARY_WORDS.has(name))
const capitalized = (name: string): string => name[0].toUpperCase() + name.slice(1)
const ENGINE_IDENTIFIER = new RegExp([
  `^(${DISTINCT.join('|')})(?=[A-Z_0-9])`, // codexHome, claudeTrusts
  `(${[...DISTINCT.map(capitalized), 'OpenCode', 'CommandCode'].join('|')})(?=[A-Z_0-9]|$)`, // preTrustCodexProject, readClaude
  `^(${PROCESS_ENGINES.map((name) => name.toUpperCase()).join('|')})_`, // CODEX_HOME, CLAUDE_PROJECTS_DIR
].join('|'))
const ENGINE_FOLDER = new RegExp(`(^|/)engines/(${PROCESS_ENGINES.join('|')})/`)

export interface EngineNames { literals: number; keys: number; imports: number; identifiers: number }

/** Every way a file names an engine: string literals, object keys and property reads, imports from an
 *  engine's folder, and engine-named identifiers (each distinct name once). */
export function engineNamesIn(fileName: string, source: string): EngineNames {
  const found: EngineNames = { literals: 0, keys: 0, imports: 0, identifiers: 0 }
  const identifiers = new Set<string>()
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (ENGINE_FOLDER.test(node.moduleSpecifier.text)) found.imports++
      return
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier && ts.isStringLiteral(specifier) && ENGINE_FOLDER.test(specifier.text)) found.imports++
      return
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && NAMES.has(node.text)) found.literals++
    if (ts.isObjectLiteralExpression(node)) {
      const keys = node.properties.flatMap((property) =>
        property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && NAMES.has(property.name.text) ? [property.name.text] : [])
      // A key written as a string is a literal already; count the bare ones, and `cursor`, `pi` and `amp`
      // only beside another engine's key.
      const bare = node.properties.filter((property) => property.name && ts.isIdentifier(property.name) && NAMES.has(property.name.text)).length
      if (keys.some((key) => !ORDINARY_WORDS.has(key))) found.keys += bare
    }
    if (ts.isPropertyAccessExpression(node) && NAMES.has(node.name.text) && !ORDINARY_WORDS.has(node.name.text)) found.keys++
    if (ts.isIdentifier(node) && ENGINE_IDENTIFIER.test(node.text)) identifiers.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true))
  found.identifiers = identifiers.size
  return found
}

const total = (names: EngineNames): number => names.literals + names.keys + names.imports + names.identifiers

function sharedFiles(): string[] {
  const files: string[] = []
  const walk = (path: string): void => {
    if (!existsSync(path)) return
    if (!path.endsWith('.ts')) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name === '__fixtures__' || entry.name === 'fixtures')) continue
        if (entry.isDirectory() || entry.name.endsWith('.ts')) walk(join(path, entry.name))
      }
      return
    }
    if (!/\.(spec|test)\.ts$/.test(path) && !path.endsWith('.d.ts')) files.push(path)
  }
  for (const entry of SCOPE) walk(join(SRC, entry))
  return files.sort()
}

/** Each shared file's count, for every file that names an engine at all. */
function counts(): Map<string, EngineNames> {
  const out = new Map<string, EngineNames>()
  for (const path of sharedFiles()) {
    const names = engineNamesIn(path, readFileSync(path, 'utf8'))
    if (total(names)) out.set(relative(SRC, path), names)
  }
  return out
}

describe('shared code does not name an engine', () => {
  const found = counts()
  if (process.env.ENGINE_NAMES_BASELINE === 'write') {
    writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries([...found].map(([file, names]) => [file, total(names)])), null, 2)}\n`)
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>

  it('no shared file names an engine more often than it did', () => {
    const over = [...found].flatMap(([file, names]) => total(names) > (baseline[file] ?? 0)
      ? [`${file} names an engine ${total(names)} times (literals ${names.literals}, keys ${names.keys}, imports ${names.imports}, identifiers ${names.identifiers}), over its ${baseline[file] ?? 0}`]
      : [])
    expect(over, 'What an engine does differently belongs in src/engines/<engine>/ behind the Engine interface; shared code asks the registry (docs/design/2026-10-05-engine-interface.md).').toEqual([])
  })

  it('the baseline names only files that exist', () => {
    const gone = Object.keys(baseline).filter((file) => !existsSync(join(SRC, file)))
    expect(gone, 'Remove these from engineNames.baseline.json (or regenerate it).').toEqual([])
  })

  it('finds what it checks: every kind of name, and none of the ordinary words', () => {
    expect(engineNamesIn('x.ts', [
      "import { x } from '../engines/kilo/reader.js'",
      "import type { Engine } from '../engines/engine.js'",
      "const lazy = () => import('./engines/grok/index.js')",
      "if (engine === 'codex' || engine === 'cursor') {}",
      'const FLAGS = { claude: 1, codex: 2, cursor: 3 }',
      'const page = { cursor: null, before: 1 }',
      'read(dbs.opencode, dbs.cursor)',
      'preTrustCodexProject(); readClaude(); const CODEX_HOME = 1; const codexHome = CODEX_HOME',
      'const cursorX = 1; const oldestCursor = 2; const piFooter = 3',
    ].join('\n'))).toEqual({ literals: 2, keys: 4, imports: 2, identifiers: 4 })
    expect(found.size, 'the scan reads the shared folders').toBeGreaterThan(0)
  })
})
