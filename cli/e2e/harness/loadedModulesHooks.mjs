// The module hooks loadedModules.mjs registers: each module resolved to load is written down as it resolves, after
// whatever resolver came before (tsx, from the sources), so a TypeScript source is written as the file it is.
import { appendFileSync } from 'node:fs'

let file = ''
export function initialize(data) { file = data.file }
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context)
  if (file && resolved.url.startsWith('file:')) appendFileSync(file, `${resolved.url}\n`)
  return resolved
}
