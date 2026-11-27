import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

rmSync('build', { recursive: true, force: true })
mkdirSync('build')
cpSync('src', 'build', { recursive: true })
const index = readFileSync('build/index.html', 'utf8').replace('__VERSION__', version)
writeFileSync('build/index.html', index)
console.log(`built storefront-web ${version} into build/`)
