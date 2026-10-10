/**
 * Markdown to DOM, for memory files written by models and people.
 *
 * Nothing from a memory file ever becomes HTML: `parse` turns the text into plain blocks and inline
 * spans, and `render` builds elements with `textContent`. A memory that contains `<script>` or an
 * `onerror=` shows those characters, and nothing else. Links are shown as text: the pane is a viewer of
 * what agents remembered, not a browser, and a click must never navigate it away.
 */

const MAX_INLINE = 8_000
const MAX_QUOTE_DEPTH = 8

/** `## Title ##` → { level, text }, without a backtracking pattern (see lib/text.mjs headingText). */
function heading(line) {
  if (line.length > 2000 || line[0] !== '#') return null
  let level = 0
  while (line[level] === '#') level++
  if (level > 6 || (line[level] !== ' ' && line[level] !== '\t')) return null
  let text = line.slice(level).trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trim()
  return text ? { level, text } : null
}

/** Inline spans: code, bold, italic, links (as their text), plain text. */
export function inline(text) {
  const spans = []
  // Past this length a paragraph is shown as plain text: the span pattern is fast on prose but a
  // model can write anything, and the preview must never stall.
  if (String(text ?? '').length > MAX_INLINE) return [{ type: 'text', text: String(text) }]
  const source = String(text ?? '')
  const pattern = /(?<!`)(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<![\w_])_([^_\s][^_]*?)_(?!\w)|\[([^\][]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) spans.push({ type: 'text', text: source.slice(last, match.index) })
    if (match[2] !== undefined) spans.push({ type: 'code', text: match[2] })
    else if (match[3] !== undefined || match[4] !== undefined) spans.push({ type: 'strong', text: match[3] ?? match[4] })
    else if (match[5] !== undefined || match[6] !== undefined) spans.push({ type: 'em', text: match[5] ?? match[6] })
    else spans.push({ type: 'link', text: match[7], href: match[8] })
    last = match.index + match[0].length
  }
  if (last < source.length) spans.push({ type: 'text', text: source.slice(last) })
  return spans
}

/** Blocks: headings, paragraphs, lists, quotes, code, rules, tables (kept as monospace text). */
export function parse(text, depth = 0) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  const isBreak = (line) => /^\s*$/.test(line) || /^#{1,6}[ \t]/.test(line) || /^\s*```/.test(line) || /^\s*([-*+]|\d+[.)])\s+/.test(line) || /^\s*>/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|/.test(line)
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i++; continue }
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: body.join('\n'), lang: fence[1].trim() })
      continue
    }
    const title = heading(line)
    if (title) { blocks.push({ type: 'heading', level: title.level, spans: inline(title.text) }); i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue }
    if (/^\s*\|/.test(line)) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++])
      blocks.push({ type: 'table', text: rows.join('\n') })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      // Quotes nest by recursion; a file of thousands of `>` must not exhaust the stack.
      blocks.push({ type: 'quote', blocks: depth < MAX_QUOTE_DEPTH ? parse(body.join('\n'), depth + 1) : [{ type: 'paragraph', spans: inline(body.join(' ')) }] })
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2])
      const items = []
      while (i < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (next) {
          const check = /^\[([ xX])\]\s+(.*)$/.exec(next[3])
          items.push({ depth: Math.min(4, Math.floor(next[1].replace(/\t/g, '  ').length / 2)), checked: check ? check[1] !== ' ' : null, spans: inline(check ? check[2] : next[3]) })
          i++
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items.at(-1).spans.push({ type: 'text', text: ' ' }, ...inline(lines[i].trim()))
          i++
        } else break
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    const body = [line.trim()]
    i++
    while (i < lines.length && !isBreak(lines[i])) body.push(lines[i++].trim())
    blocks.push({ type: 'paragraph', spans: inline(body.join(' ')) })
  }
  return blocks
}

function spansTo(doc, parent, spans) {
  for (const span of spans) {
    if (span.type === 'text') { parent.append(doc.createTextNode(span.text)); continue }
    const tag = { code: 'code', strong: 'strong', em: 'em', link: 'span' }[span.type]
    const element = doc.createElement(tag)
    element.textContent = span.text
    if (span.type === 'link') { element.className = 'md-link'; element.title = span.href }
    parent.append(element)
  }
}

/** The blocks as elements, appended to `parent`. */
export function render(doc, parent, blocks) {
  for (const block of blocks) {
    let element
    if (block.type === 'heading') { element = doc.createElement(`h${Math.min(6, block.level + 2)}`); spansTo(doc, element, block.spans) }
    else if (block.type === 'paragraph') { element = doc.createElement('p'); spansTo(doc, element, block.spans) }
    else if (block.type === 'code' || block.type === 'table') { element = doc.createElement('pre'); element.textContent = block.text }
    else if (block.type === 'rule') element = doc.createElement('hr')
    else if (block.type === 'quote') { element = doc.createElement('blockquote'); render(doc, element, block.blocks) }
    else if (block.type === 'list') {
      element = doc.createElement(block.ordered ? 'ol' : 'ul')
      for (const item of block.items) {
        const li = doc.createElement('li')
        if (item.depth) li.style.marginLeft = `${item.depth * 1.4}em`
        if (item.checked !== null) li.dataset.checked = String(item.checked)
        spansTo(doc, li, item.spans)
        element.append(li)
      }
    }
    if (element) parent.append(element)
  }
  return parent
}
