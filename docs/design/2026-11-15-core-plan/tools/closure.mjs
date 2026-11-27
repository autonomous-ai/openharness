// Computes the core's closure with and without the other-engines door, like architecture.spec.ts closureOf.
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
const SRC = process.argv[2]
const require = createRequire(join(SRC, '..', 'package.json'))
const ts = require('typescript')
const IN_PROCESS_ONLY = 'services/inline.ts'
const LAZY = new Set((process.argv[3] ?? 'engines/inProcess.ts').split(',').filter(Boolean))
function importsFor(path, text) {
  const found = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      let typeOnly
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null
        typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)))
      } else typeOnly = node.isTypeOnly
      if (!typeOnly) found.push({ from: node.moduleSpecifier.text, dynamic: false })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.push({ from: node.arguments[0].text, dynamic: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))
  return found.filter(({ from }) => from.startsWith('.'))
}
const isFile = (c) => { try { return statSync(c).isFile() } catch { return false } }
const cache = new Map()
function parsed(path, open) {
  const key = path + '|' + open
  if (cache.has(key)) return cache.get(key)
  const text = readFileSync(path, 'utf8')
  const imports = []
  for (const { from, dynamic } of importsFor(path, text)) {
    const base = resolve(dirname(path), from)
    const target = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')].find(isFile)
    if (!target || !target.startsWith(SRC + '/') || !target.endsWith('.ts') || /\.(spec|test|e2e)\.ts$/.test(target)) continue
    const importer = relative(SRC, path), t = relative(SRC, target)
    if (dynamic && (t === IN_PROCESS_ONLY || (!open && LAZY.has(importer)))) continue
    imports.push(target)
  }
  const result = { lines: text.split('\n').length, imports }
  cache.set(key, result)
  return result
}
function closureOf(entry, open) {
  const lines = new Map(); const pending = [join(SRC, entry)]
  while (pending.length) { const p = pending.pop(); const f = relative(SRC, p); if (lines.has(f)) continue; const r = parsed(p, open); lines.set(f, r.lines); pending.push(...r.imports) }
  return lines
}
const entry = process.argv[4] ?? 'core/main.ts'
const shut = closureOf(entry, false), open = closureOf(entry, true)
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0)
console.log(`shut: ${shut.size} files ${sum(shut)} lines; open: ${open.size} files ${sum(open)} lines; door adds ${open.size - shut.size} files ${sum(open) - sum(shut)} lines`)
if (process.argv[5] === 'list') for (const [f, n] of [...open].filter(([f]) => !shut.has(f)).sort()) console.log(n, f)
