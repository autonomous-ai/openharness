/**
 * The devDependencies a source file imports (productionBuild.test.ts): `from 'x'` (import or export), a bare `import 'x'`, and
 * `import('x')`, each with any subpath. `import type` is skipped: the build erases it. A text scan, so an import written in a
 * comment counts too: shipped files keep test-only package names out altogether.
 */
export function devImports(source: string, devDependencies: readonly string[]): string[] {
  const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\1/g)]
    .filter(match => !/\bimport\s+type\b[^;\n]*$/.test(source.slice(source.lastIndexOf('\n', match.index) + 1, match.index)))
    .map(match => match[2]!)
  const packageOf = (specifier: string) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
  return [...new Set(specifiers.map(packageOf).filter(name => devDependencies.includes(name)))]
}
