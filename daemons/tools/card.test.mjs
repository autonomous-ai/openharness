// node --test daemons/tools/card.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cardLines, cardNumber, dropState, shelfLines, cardSvg, shelfSvg, silhouette, flagLines, oneInText } from './card.mjs'
import { rollTraits, individualFlags, oneIn } from './render.mjs'

const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'))
const plates = JSON.parse(readFileSync(new URL('../plates.json', import.meta.url), 'utf8'))
const printable = s => /^[\x20-\x7e]*$/.test(s)
// A filled daemon's card shows its portrait plate, idle, first frame.
const plate = (d, version = '2.0') => d.plate ? plates.daemons[d.id].portrait[version].idle[0].split('\n') : null

test('every card, every version, is 42 printable columns', () => {
  for (const d of roster.daemons) {
    for (const version of roster.rules.versions) {
      const p = plate(d, version)
      for (const lines of [cardLines(roster, d, { version, plate: p }), cardLines(roster, d, { version, plate: p, shiny: true, serial: 9999, nickname: 'pip', hatched: '2026-09-26', egg: 'first' })]) {
        for (const l of lines) {
          assert.equal(l.length, 42, `${d.id} ${version}: "${l}"`)
          assert.ok(printable(l), `${d.id} ${version}: not ASCII`)
        }
      }
    }
  }
})

test('secrets sit outside the numbered set, and every drop numbers its own', () => {
  for (const drop of roster.drops) {
    const set = roster.daemons.filter(d => d.drop === drop.id)
    const regular = set.filter(d => d.rarity !== 'secret')
    const of = String(regular.length).padStart(2, '0')
    assert.deepEqual(regular.map(d => cardNumber(roster, d)), regular.map((_, i) => `#${String(i + 1).padStart(2, '0')}/${of}`), drop.id)
    for (const secret of set.filter(d => d.rarity === 'secret')) assert.equal(cardNumber(roster, secret), `#S/${of}`, secret.id)
  }
  const tty = roster.daemons.find(d => d.id === 'tty')
  assert.ok(cardLines(roster, tty, { version: '2.0' })[1].startsWith('| #09/09  DROP 3: TTY'))
  const auk = roster.daemons.find(d => d.id === 'auk')
  assert.ok(cardLines(roster, auk, { version: '2.0', plate: plate(auk) })[1].startsWith('| #09/09  DROP 1: INIT'))
  const beastie = roster.daemons.find(d => d.id === 'beastie')
  assert.equal(cardNumber(roster, beastie), '#S/09')
})

test('a filled daemon\'s card shows its portrait plate, and asks for it', () => {
  const tim = roster.daemons.find(d => d.id === 'tim')
  const lines = cardLines(roster, tim, { version: '2.0', plate: plate(tim) })
  for (const row of plate(tim)) assert.ok(lines.some(l => l.includes(row.trim())), row)
  assert.throws(() => cardLines(roster, tim, { version: '2.0' }), /pass its portrait plate/)
  const svg = cardSvg(roster, tim, { version: '2.0', plate: plate(tim) })
  assert.ok(svg.includes(`fill="${tim.gradient.top.hex}"`) && svg.includes(`fill="${tim.gradient.bottom.hex}"`))
})

test('drop 1 (init) is out on 2026-09-27; unix and tty are on hold and show nowhere, ever', () => {
  const at = day => new Date(`${day}T12:00:00.000Z`)
  const init = roster.drops.find(d => d.id === 'init')
  assert.deepEqual(['2026-09-12', '2026-09-13', '2026-09-26', '2026-09-27'].map(d => dropState(init, at(d))), ['hidden', 'announced', 'announced', 'released'])
  for (const id of ['unix', 'tty']) {
    const drop = roster.drops.find(d => d.id === id)
    assert.equal(drop.hold, true)
    for (const day of ['2026-09-27', '2027-09-27', '2036-01-01']) assert.equal(dropState(drop, at(day)), 'hidden', `${id} ${day}`)
    assert.deepEqual(shelfLines(roster, [], { drop: id, now: at('2030-01-01') }), [])
  }
})

test('a shelf shows owned sprites and numbered empty slots', () => {
  const lines = shelfLines(roster, ['tim'])
  assert.match(lines[0], /^zoo: drop 1 init {2}1\/\d+$/)
  assert.ok(lines.some(l => l.includes('[ ? ]')))
  assert.ok(lines.some(l => l.includes('[ ! ]')))
  for (const l of lines) assert.ok(printable(l))
})

test('the svg escapes markup and colours owned cells', () => {
  const svg = cardSvg(roster, roster.daemons[0], { version: '2.0', plate: plate(roster.daemons[0]) })
  assert.ok(svg.startsWith('<svg') && svg.trim().endsWith('</svg>'))
  assert.ok(!/<text[^>]*>[^<]*[<>][^<]*<\/text>/.test(svg.replace(/&lt;|&gt;/g, '')))
  const shelf = shelfSvg(roster, ['tim'])
  assert.ok(shelf.includes(roster.daemons.find(d => d.id === 'tim').color.hex))
})

test('a card shows its serial as #0042, and a guest\'s daemon shows none', () => {
  const tim = roster.daemons.find(d => d.id === 'tim')
  const p = plate(tim)
  assert.ok(cardLines(roster, tim, { version: '2.0', plate: p, serial: 42 }).some(l => l.includes('tim 2.0  #0042')))
  assert.ok(cardLines(roster, tim, { version: '2.0', plate: p, serial: 12345 }).some(l => l.includes('#12345')))
  assert.ok(!cardLines(roster, tim, { version: '2.0', plate: p }).some(l => /#\d{4}/.test(l)))
})

test('every daemon has a shiny colour of its own, and a shiny card wears it', () => {
  for (const d of roster.daemons) {
    assert.ok(d.shiny && /^#[0-9a-f]{6}$/.test(d.shiny.hex), `${d.id}: shiny colour`)
    assert.notEqual(d.shiny.hex, d.color.hex, `${d.id}: shiny must differ`)
    const shiny = cardSvg(roster, d, { version: '2.0', plate: plate(d), shiny: true })
    const plain = cardSvg(roster, d, { version: '2.0', plate: plate(d) })
    assert.ok(shiny.includes(`fill="${d.shiny.hex}"`), `${d.id}: shiny card colour`)
    assert.ok(!plain.includes(`fill="${d.shiny.hex}"`) || d.shiny.hex === '#d0d0d0', `${d.id}: plain card`)
    assert.ok(cardLines(roster, d, { plate: plate(d, '0.1'), shiny: true })[1].includes('SHINY'))
  }
})

test('a shelf counts duplicates beside a daemon, and colours a shiny one in its shiny colour', () => {
  const lines = shelfLines(roster, [{ id: 'tim', shiny: true, dupes: 1 }, 'yak'])
  assert.match(lines[0], /^zoo: drop 1 init {2}2\/9$/)
  assert.ok(lines.some(l => l.startsWith('tim x2 ')))
  assert.ok(lines.some(l => /(^| )yak$/.test(l)))
  assert.deepEqual(shelfLines(roster, ['tim', 'yak']), shelfLines(roster, [{ id: 'tim' }, { id: 'yak' }]))
  const tim = roster.daemons.find(d => d.id === 'tim')
  assert.ok(shelfSvg(roster, [{ id: 'tim', shiny: true }]).includes(tim.shiny.hex))
  assert.ok(!shelfSvg(roster, ['tim']).includes(tim.shiny.hex))
})

test('an announced drop shows as silhouettes until its release, and an unannounced one not at all', () => {
  const next = { id: 'plan9', n: 2, name: 'plan9', announce: '2026-10-01', release: '2026-10-15' }
  const rio = { ...roster.daemons.find(d => d.id === 'tim'), id: 'rio', n: 1, drop: 'plan9' }
  const ghost = { ...roster.daemons.find(d => d.id === 'grue'), id: 'ghost', n: 2, drop: 'plan9' }
  const r2 = { ...roster, drops: [...roster.drops, next], daemons: [...roster.daemons, rio, ghost] }
  const at = day => new Date(`${day}T12:00:00.000Z`)
  assert.equal(dropState(roster.drops[0], at('2026-09-27')), 'released')
  assert.deepEqual(['2026-09-30', '2026-10-01', '2026-10-15'].map(d => dropState(next, at(d))), ['hidden', 'announced', 'released'])
  assert.deepEqual(shelfLines(r2, [], { drop: 'plan9', now: at('2026-09-30') }), [])
  const soon = shelfLines(r2, ['rio'], { drop: 'plan9', now: at('2026-10-05') })
  assert.equal(soon[0], 'zoo: drop 2 plan9  out 2026-10-15')
  assert.ok(soon[2].startsWith(silhouette('(o o)')))                         // rio's 0.1 sprite, as # only
  assert.ok(soon[2].includes('[ ! ]'))                                      // a secret gives nothing away
  assert.ok(!soon.join('\n').includes('rio'))
  const out = shelfLines(r2, ['rio'], { drop: 'plan9', now: at('2026-10-15') })
  assert.match(out[0], /1\/1$/)
  assert.ok(out.some(l => l.startsWith('rio')))
  for (const l of [...soon, ...out]) assert.ok(printable(l))
})

test('an individual\'s card shows its name, its flags and how rare it is, in 42 printable columns', () => {
  for (const d of roster.daemons.filter(d => d.traits)) {
    for (let seed = 0; seed < 400; seed++) {
      const traits = rollTraits(roster, d.id, seed)
      for (const version of roster.rules.versions) {
        const lines = cardLines(roster, d, { version, plate: plate(d, version), traits, name: 'pip', serial: 42, hatched: '2026-09-27', egg: 'turn' })
        for (const l of lines) {
          assert.equal(l.length, 42, `${d.id} ${seed} ${version}: "${l}"`)
          assert.ok(printable(l), `${d.id} ${seed}: not ASCII`)
        }
        const body = lines.map(l => l.slice(2, -2).trimEnd())
        assert.ok(body.includes(`  pip the ${d.id} ${version}  #0042`), `${d.id} ${seed}: name line`)
        // The flags read back whole: continued lines joined, as a shell would.
        const at = body.findIndex(l => l.startsWith(`  ${d.id} -c `))
        const until = body.findIndex((l, i) => i > at && !l.endsWith(' \\') && !body[i - 1].endsWith(' \\'))
        const flags = body.slice(at, until).map(l => l.trim().replace(/ \\$/, '')).join(' ')
        assert.equal(flags, individualFlags(roster, d.id, traits), `${d.id} ${seed}: flags`)
        assert.equal(body[until], `  ${oneInText(oneIn(roster, d.id, traits))}`, `${d.id} ${seed}: 1 in N`)
      }
    }
  }
})

test('flags wrap as a long command does, and a rarity has its commas', () => {
  assert.deepEqual(flagLines('tim -c coral --spots --glasses --fidgety', 36), ['tim -c coral --spots --glasses \\', '  --fidgety'])
  assert.deepEqual(flagLines('tim -c sunset --patches --big-head --long-arms --wide-eyes --fidgety', 36), ['tim -c sunset --patches --big-head \\', '  --long-arms --wide-eyes --fidgety'])
  assert.deepEqual(flagLines('tim -c magenta', 36), ['tim -c magenta'])
  assert.deepEqual([11, 242, 2130, 17857, 1234567].map(oneInText), ['1 in 11', '1 in 242', '1 in 2,130', '1 in 17,857', '1 in 1,234,567'])
})

test('a card without traits is the species card, and an individual\'s svg runs down its own colours', () => {
  const tim = roster.daemons.find(d => d.id === 'tim')
  const plain = cardLines(roster, tim, { version: '2.0', plate: plate(tim), nickname: 'pip' })
  assert.ok(plain.some(l => l.includes('pip the tim 2.0')))
  assert.ok(!plain.some(l => / -c |1 in /.test(l)))
  const seed = Array.from({ length: 500 }, (_, i) => i + 1).find(s => rollTraits(roster, 'tim', s).colour === 'coral')
  const traits = rollTraits(roster, 'tim', seed)
  const coral = tim.traits.colours.find(c => c[0] === 'coral')
  const svg = cardSvg(roster, tim, { version: '2.0', plate: plate(tim), traits })
  assert.ok(svg.includes(`fill="${coral[2]}"`) && svg.includes(`fill="${coral[3]}"`))
  assert.ok(!svg.includes(`fill="${tim.gradient.top.hex}"`))
  assert.ok(cardSvg(roster, tim, { version: '2.0', plate: plate(tim), traits, shiny: true }).includes(`fill="${tim.shinyGradient.top.hex}"`))
})
