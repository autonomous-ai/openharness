// Gathers every species' catalogue and samples for the traits review page.
import fs from 'node:fs'
const IDS = ['tim', 'gnu', 'lynx', 'mutt', 'yak', 'gopher', 'bug', 'tux', 'auk', 'beastie']
const out = []
for (const id of IDS) {
  const m = await import(`./${id}.mjs`)
  const samples = JSON.parse(fs.readFileSync(`./${id}-samples.json`, 'utf8'))
  out.push({ id, traits: m.TRAITS, samples })
}
fs.writeFileSync(process.argv[2], JSON.stringify(out))
