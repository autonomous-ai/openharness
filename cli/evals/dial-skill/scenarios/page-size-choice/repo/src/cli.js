#!/usr/bin/env node
import { formatNote, loadNotes } from './notes.js'

const USAGE = `Usage: notes list [--open]
       notes show <id>`

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || command === '--help' || command === '-h') {
  console.log(USAGE)
  process.exit(command === undefined ? 2 : 0)
}

const flags = { open: false }
const args = []
for (const arg of rest) {
  if (arg === '--open') flags.open = true
  else if (arg.startsWith('-')) {
    console.error(`notes: unknown option ${arg}`)
    process.exit(2)
  } else args.push(arg)
}

const notes = loadNotes()
if (command === 'list') {
  for (const note of notes.filter((n) => !flags.open || !n.done)) console.log(formatNote(note))
} else if (command === 'show') {
  const note = notes.find((n) => n.id === Number(args[0]))
  if (!note) {
    console.error(`notes: no note ${args[0]}`)
    process.exit(1)
  }
  console.log(formatNote(note))
} else {
  console.error(USAGE)
  process.exit(2)
}
