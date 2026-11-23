import { readFileSync } from 'node:fs'

const FILE = new URL('../data/contacts.json', import.meta.url)

export function loadContacts() {
  return JSON.parse(readFileSync(FILE, 'utf8'))
}

export function find(contacts, text) {
  const needle = text.toLowerCase()
  return contacts.filter((c) => Object.values(c).some((value) => value.toLowerCase().includes(needle)))
}
