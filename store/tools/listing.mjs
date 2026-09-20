#!/usr/bin/env node
// List or unlist a built-in package without touching its code.
//
//   node store/tools/listing.mjs                     show every package and whether it is listed
//   node store/tools/listing.mjs unlist <name> ...   take packages off the shelf  ("listed": false in store.json)
//   node store/tools/listing.mjs list <name> ...     put them back                (the flag is removed)
//
// An unlisted package keeps its folder under store/ and keeps passing every check. It is left out
// of the registry the CLI bakes in and of the catalog the Store publishes, so nobody is offered it.
// The change goes live the usual way: merge to main and the catalog is published again.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STORE = dirname(dirname(fileURLToPath(import.meta.url)))

export function packages(store = STORE) {
  const out = []
  for (const plural of ['agents', 'viewers']) {
    let names = []
    try { names = readdirSync(join(store, plural)).sort() } catch { continue }
    for (const name of names) {
      const dir = join(store, plural, name)
      if (name.startsWith('.') || !statSync(dir).isDirectory() || !existsSync(join(dir, 'harness.json'))) continue
      let facts = {}
      try { facts = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) } catch { /* no facts yet */ }
      out.push({ name, plural, dir, listed: facts.listed !== false })
    }
  }
  return out
}

/** Set or clear the flag on one package. Returns 'changed', 'same' or 'missing'. */
export function setListed(name, listed, store = STORE) {
  const pkg = packages(store).find((p) => p.name === name)
  if (!pkg) return 'missing'
  if (pkg.listed === listed) return 'same'
  const file = join(pkg.dir, 'store.json')
  let facts = {}
  try { facts = JSON.parse(readFileSync(file, 'utf8')) } catch { /* a package with no facts yet gets a file */ }
  if (listed) delete facts.listed
  else facts.listed = false
  writeFileSync(file, JSON.stringify(facts, null, 2) + '\n')
  return 'changed'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [verb, ...names] = process.argv.slice(2)
  if (!verb) {
    const all = packages()
    for (const p of all) console.log(`${p.listed ? 'listed  ' : 'UNLISTED'}  ${p.plural}/${p.name}`)
    console.log(`${all.filter((p) => p.listed).length} listed, ${all.filter((p) => !p.listed).length} unlisted`)
  } else if ((verb === 'list' || verb === 'unlist') && names.length) {
    let bad = 0
    for (const name of names) {
      const got = setListed(name, verb === 'list')
      if (got === 'missing') bad++
      console.log(`${got === 'missing' ? 'no such package' : got === 'same' ? `already ${verb}ed` : `${verb}ed`}  ${name}`)
    }
    process.exit(bad ? 1 : 0)
  } else {
    console.error('usage: node store/tools/listing.mjs [list|unlist <name> ...]')
    process.exit(2)
  }
}
