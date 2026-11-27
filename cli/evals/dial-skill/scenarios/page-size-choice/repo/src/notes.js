import { readFileSync } from 'node:fs'

const FILE = new URL('../data/notes.json', import.meta.url)

export function loadNotes() {
  return JSON.parse(readFileSync(FILE, 'utf8'))
}

export function formatNote(note) {
  return `#${note.id}  [${note.done ? 'x' : ' '}] ${note.title}`
}
