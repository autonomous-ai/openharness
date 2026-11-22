#!/usr/bin/env node
import { find, loadContacts } from './contacts.js'

const USAGE = `Usage: contacts find <text>
       contacts export [--format json]`

const [command, ...args] = process.argv.slice(2)
const contacts = loadContacts()

if (command === 'find' && args.length === 1) {
  for (const c of find(contacts, args[0])) console.log(`${c.name} <${c.email}>, ${c.city}`)
} else if (command === 'export') {
  const format = args[0] === '--format' ? args[1] : 'json'
  if (format !== 'json') {
    console.error(`contacts: unknown format ${format}`)
    process.exit(2)
  }
  console.log(JSON.stringify(contacts, null, 2))
} else {
  console.error(USAGE)
  process.exit(command === '--help' ? 0 : 2)
}
