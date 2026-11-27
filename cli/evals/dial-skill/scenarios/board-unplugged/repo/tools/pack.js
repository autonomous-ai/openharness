// Packs the firmware sources into one image: a header with the version and length, then config.js and main.js in
// the order the board runs them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [srcDir, out] = process.argv.slice(2)
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const body = Buffer.from(['config.js', 'main.js'].map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n'))
const header = Buffer.from(`GHFW ${version} ${body.length}\n`)

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.concat([header, body]))
console.log(`packed ${out} (${header.length + body.length} bytes)`)
