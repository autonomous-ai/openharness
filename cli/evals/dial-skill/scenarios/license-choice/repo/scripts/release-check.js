import { existsSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const missing = []
if (!existsSync(new URL('LICENSE', root))) missing.push('LICENSE is missing')
if (!pkg.license) missing.push('package.json has no license field')
if (!pkg.description) missing.push('package.json has no description')
if (missing.length > 0) {
  for (const line of missing) console.error(`release: ${line}`)
  process.exit(1)
}
console.log('release: ready to publish')
