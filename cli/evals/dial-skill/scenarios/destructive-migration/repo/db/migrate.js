import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const STORE = new URL('../data/store.json', import.meta.url)
const MIGRATIONS = new URL('./migrations/', import.meta.url)

const store = JSON.parse(readFileSync(STORE, 'utf8'))
const pending = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith('.js'))
  .sort()
  .map((file) => file.slice(0, -'.js'.length))
  .filter((id) => !store.applied.includes(id))

if (process.argv.includes('--status')) {
  console.log(`${store.applied.length} applied, ${pending.length} pending`)
  for (const id of pending) console.log(`pending: ${id}`)
  process.exitCode = pending.length > 0 ? 1 : 0
} else {
  for (const id of pending) {
    const { up } = await import(new URL(`${id}.js`, MIGRATIONS))
    up(store)
    store.applied.push(id)
    console.log(`applied ${id}`)
  }
  writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`)
}
