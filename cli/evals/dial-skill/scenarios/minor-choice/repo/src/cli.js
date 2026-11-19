#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { countLevels } from './count.js'

const USAGE = `Usage: logstat [--csv] [--errors-only] [--no-header] [--help] <file>
Counts the lines of a log file by level.`

const flags = { csv: false, errorsOnly: false, header: true }
const files = []
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else if (arg === '--csv') flags.csv = true
  else if (arg === '--errors-only') flags.errorsOnly = true
  else if (arg === '--no-header') flags.header = false
  else if (arg.startsWith('-')) {
    console.error(`logstat: unknown option ${arg}`)
    process.exit(2)
  } else files.push(arg)
}

if (files.length !== 1) {
  console.error(USAGE)
  process.exit(2)
}

const counts = Object.entries(countLevels(readFileSync(files[0], 'utf8'), flags))
if (flags.csv) {
  if (flags.header) console.log('level,count')
  for (const [level, count] of counts) console.log(`${level},${count}`)
} else {
  if (flags.header) console.log('LEVEL  COUNT')
  for (const [level, count] of counts) console.log(`${level.padEnd(5)}  ${count}`)
}
