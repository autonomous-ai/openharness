import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('.', import.meta.url))
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}
function imports(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.map(specifier => relative(sourceRoot, resolve(dirname(path), specifier)).replaceAll('\\', '/'))
}

it('keeps knowledge independent of the character and application implementations', () => {
  const violations = files(join(sourceRoot, 'memory')).flatMap(path => imports(path)
    .filter(target => /^(companion|application)\//.test(target)).map(target => `${relative(sourceRoot, path)} -> ${target}`))
  expect(violations).toEqual([])
})

it('lets characters use only the public Memory contract', () => {
  const violations = files(join(sourceRoot, 'companion')).flatMap(path => imports(path)
    .filter(target => target.startsWith('application/') || target.startsWith('memory/') && target !== 'memory/api.js')
    .map(target => `${relative(sourceRoot, path)} -> ${target}`))
  expect(violations).toEqual([])
})
