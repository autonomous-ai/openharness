/** The page's pure parts: a memory's text never becomes HTML, and the text helpers survive any shape. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { marked, renderBody } from '../viewer/self.js'
import { frontmatter, sections, entries, encodePath, clip } from '../lib/text.mjs'

/** Just enough of a document to watch what renderBody() builds: elements and text nodes, no HTML parser. */
function fakeDocument() {
  const node = (tag) => ({ tag, children: [], style: {}, dataset: {}, textContent: '', className: '', title: '', append(...items) { this.children.push(...items) } })
  return { createElement: node, createTextNode: (text) => ({ tag: '#text', text }) }
}
const texts = (tree) => tree.tag === '#text' ? [tree.text] : [tree.textContent, ...tree.children.flatMap(texts)]
const tags = (tree) => tree.tag === '#text' ? [] : [tree.tag, ...tree.children.flatMap(tags)]

test('a memory body: headings, bullets, code and bold, as elements the page makes', () => {
  const doc = fakeDocument()
  const root = renderBody(doc, doc.createElement('div'), '# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n```\nraw <b>\n```')
  assert.deepEqual(root.children.map((child) => child.tag), ['h4', 'p', 'div', 'div', 'pre'])
  assert.deepEqual(tags(root.children[1]), ['p', 'strong', 'code'])
  assert.equal(root.children[4].textContent, 'raw <b>\n')
})

test('hostile text is rendered as text: no element comes from the memory', () => {
  const doc = fakeDocument()
  const root = renderBody(doc, doc.createElement('div'), '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)> **<b>x</b>**')
  assert.deepEqual([...new Set(tags(root))].sort(), ['div', 'p', 'strong'])
  assert.ok(texts(root).join('').includes('<script>alert(1)</script>'))
  const snippet = marked(doc, doc.createElement('span'), 'say \u0002<img src=x onerror=alert(3)>\u0003 twice')
  assert.deepEqual(tags(snippet), ['span', 'mark'])
  assert.equal(snippet.children[1].textContent, '<img src=x onerror=alert(3)>')
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
