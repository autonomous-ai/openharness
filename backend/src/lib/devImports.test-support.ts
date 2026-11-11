/**
 * What a shipped backend source file imports, for productionBuild.test.ts: every specifier it loads, in each form, `from 'x'`
 * (import or export), a bare `import 'x'`, `import('x')` (quotes or a plain template literal), `require('x')`, TypeScript's
 * `import x = require('x')` and `createRequire(...)('x')`. Type-only imports and exports, one line or several, are left
 * out first: the build erases them. A text scan, so a specifier written in a comment counts too; shipped files keep test-only
 * names out altogether.
 */
const TYPE_ONLY = /\b(?:import|export)\s+type\s*\{[^}]*\}\s*from\s*(['"])[^'"\n]+\1|\bimport\s+type\s+[\w$]+\s+from\s*(['"])[^'"\n]+\2/g
const LOADS = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bcreateRequire\s*\([^()]*\)\s*\(\s*)(['"`])([^'"`\n$]+)\1/g

export function importedSpecifiers(source: string): string[] {
  return [...source.replace(TYPE_ONLY, '').matchAll(LOADS)].map(match => match[2]!)
}

/** The devDependencies among them, each by its package name (a subpath counts as its package). */
export function devImports(source: string, devDependencies: readonly string[]): string[] {
  const packageOf = (specifier: string) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
  return [...new Set(importedSpecifiers(source).map(packageOf).filter(name => devDependencies.includes(name)))]
}

/** The test and test-support files among them, which build.mjs does not ship (*.test.ts, *.test-support.ts). */
export function testFileImports(source: string): string[] {
  return [...new Set(importedSpecifiers(source).filter(specifier => /\.test(?:-support)?(?:\.[jt]s)?$/.test(specifier)))]
}
