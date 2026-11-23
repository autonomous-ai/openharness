#!/usr/bin/env node
import { check } from './check.js'

const USAGE = 'Usage: uptime-check <url>...'

const urls = []
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else if (arg.startsWith('-')) {
    console.error(`uptime-check: unknown option ${arg}`)
    process.exit(2)
  } else urls.push(arg)
}

if (urls.length === 0) {
  console.error(USAGE)
  process.exit(2)
}

let down = false
for (const url of urls) {
  const result = await check(url)
  console.log(`${result.up ? 'UP' : 'DOWN'} ${result.status ?? result.error} ${url}`)
  down ||= !result.up
}
process.exit(down ? 1 : 0)
