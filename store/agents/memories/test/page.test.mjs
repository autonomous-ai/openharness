/** The page's pure parts: Markdown never becomes HTML, matching ranks like fzf, the calendar is right. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inline, parse, render } from '../viewer/markdown.js'
import { scoreFields, scoreTerm } from '../viewer/fuzzy.js'
import { buildGrid, dayKey } from '../viewer/heatmap.js'
import { frontmatter, sections, entries, encodePath, clip } from '../lib/text.mjs'

/** Just enough of a document to watch what render() builds: elements and text nodes, no HTML parser. */
function fakeDocument() {
  const node = (tag) => ({ tag, children: [], style: {}, dataset: {}, textContent: '', className: '', title: '', append(...items) { this.children.push(...items) } })
  return { createElement: node, createTextNode: (text) => ({ tag: '#text', text }) }
}
const texts = (tree) => tree.tag === '#text' ? [tree.text] : [tree.textContent, ...tree.children.flatMap(texts)]
const tags = (tree) => tree.tag === '#text' ? [] : [tree.tag, ...tree.children.flatMap(tags)]

test('markdown blocks and spans', () => {
  const blocks = parse('# Title\n\nSome **bold** and `code`.\n\n- one\n  continued\n- [x] done\n\n```\nraw <b>\n```\n> quoted')
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'code', 'quote'])
  assert.equal(blocks[2].items[0].spans.map((span) => span.text).join(''), 'one continued')
  assert.equal(blocks[2].items[1].checked, true)
  assert.equal(blocks[3].text, 'raw <b>')
  assert.deepEqual(inline('[docs](https://x.y) and _it_'), [{ type: 'link', text: 'docs', href: 'https://x.y' }, { type: 'text', text: ' and ' }, { type: 'em', text: 'it' }])
})

test('hostile text is rendered as text: no element comes from the memory', () => {
  const doc = fakeDocument()
  const root = render(doc, doc.createElement('div'), parse('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)> **<b>x</b>**'))
  assert.deepEqual([...new Set(tags(root))].sort(), ['div', 'p', 'strong'])
  assert.ok(texts(root).join('').includes('<script>alert(1)</script>'))
})

test('fzf-style ranking: word starts and runs first; long text matches only as typed', () => {
  assert.ok(scoreTerm('sa', 'Short answers') > scoreTerm('sa', 'xsxxxxxxxa'), 'word starts beat a scattered match')
  assert.ok(scoreTerm('ans', 'Short answers') > scoreTerm('sa', 'Short answers'), 'a run beats word starts')
  assert.equal(scoreTerm('xyz', 'Short answers'), 0)
  assert.ok(scoreTerm('rel', 'No weekend releases') > 0)
  assert.equal(scoreTerm('release', 'r e l e a s e scattered', true), 0)
  assert.equal(scoreFields('short five', [['Short answers', 3], ['wants replies under five lines', 1, true]]) > 0, true)
  assert.equal(scoreFields('short nothing', [['Short answers', 3]]), 0)
})

test('the calendar: weeks end today, Monday first, levels by quartile', () => {
  const now = new Date('2026-10-09T15:00:00').getTime() // a Friday
  const day = (offset) => dayKey(now - offset * 86_400_000)
  const grid = buildGrid([
    { day: day(0), engine: 'codex', asks: 40 }, { day: day(0), engine: 'claude', asks: 10 },
    { day: day(1), engine: 'claude', asks: 2 }, { day: day(2), engine: 'claude', asks: 5 },
  ], { now, weeks: 4 })
  assert.equal(grid.columns.length, 4)
  const last = grid.columns.at(-1)
  assert.equal(last[4].day, day(0), 'Friday is the fifth row')
  assert.equal(last[5], null, 'the days after today are empty')
  assert.equal(last[4].top, 'codex')
  assert.equal(last[4].level, 4)
  assert.equal(grid.max.total, 50)
  assert.equal(grid.streak, 3)
  assert.equal(grid.activeDays, 3)
})

test('text helpers survive any shape', () => {
  assert.deepEqual(frontmatter('---\nname: "A"\nmetadata:\n  type: user\n---\nbody').data, { name: 'A', metadata: { type: 'user' } })
  assert.deepEqual(frontmatter('---\nunterminated').data, {})
  assert.deepEqual(frontmatter('plain').body, 'plain')
  assert.deepEqual(sections('intro too short\n## A\none\n## B\ntwo').map((part) => part.title), ['A', 'B'])
  assert.deepEqual(entries('a\n§\n\n§\nb'), ['a', 'b'])
  assert.equal(encodePath('/Users/a.b/x_y'), '-Users-a-b-x-y')
  assert.ok(clip('a\n'.repeat(100), 50).endsWith('…'))
})
