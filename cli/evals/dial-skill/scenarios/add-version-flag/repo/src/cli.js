#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { countWords } from './count.js'

const USAGE = `Usage: tally [--help] <file>...
Counts the words in each file.`

const files = []
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  }
  if (arg.startsWith('-')) {
    console.error(`tally: unknown option ${arg}`)
    process.exit(2)
  }
  files.push(arg)
}

if (files.length === 0) {
  console.error(USAGE)
  process.exit(2)
}
for (const file of files) {
  console.log(`${countWords(readFileSync(file, 'utf8'))}\t${file}`)
}
