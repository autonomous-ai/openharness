// Counts the core's files and lines as architecture.spec.ts's closureOf does: each listed file's text.split('\n').length.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const src = process.argv[2]
const files = readFileSync(join(src, 'architecture.coreFiles.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
let lines = 0
for (const f of files) lines += readFileSync(join(src, f), 'utf8').split('\n').length
console.log(`${files.length} files, ${lines} lines`)
