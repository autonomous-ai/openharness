// page.mjs — turn a live web page into something Jev can answer about.
//
// Jev never writes text. So every value this harness can ever put in a cell is a piece of text that
// is really on the page: the reader numbers the page's links and its short text blocks, and Jev
// picks one by number. A made-up value is not possible, because there is nothing to make it out of.
//
// The reader runs inside the page. It marks what it found with data-jev-n, so a later click or read
// points at exactly the element that was offered.

/** The reader, as source, so it can be handed to Runtime.evaluate. */
export const READER = `(() => {
  const MAX_LINKS = 220, MAX_BLOCKS = 90, MAX_LABEL = 110, MAX_BLOCK = 180
  for (const e of document.querySelectorAll('[data-jev-n]')) e.removeAttribute('data-jev-n')
  const seen = document.documentElement.getBoundingClientRect()
  const vis = (e) => {
    const r = e.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return null
    if (r.bottom < -400 || r.top > seen.height + 400) return null
    const s = getComputedStyle(e)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return null
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const tidy = (s, max) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, max)
  const labelOf = (e) => {
    const own = tidy(e.innerText || e.textContent, MAX_LABEL)
    if (own) return own
    const img = e.querySelector('img[alt]')
    return tidy(e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('value') || e.getAttribute('placeholder') || (img && img.getAttribute('alt')) || '', MAX_LABEL)
  }
  let n = 0
  const mark = (e) => { const id = ++n; e.setAttribute('data-jev-n', String(id)); return id }

  // ---- links: where the page can go next -------------------------------------------------------
  const links = [], byHref = new Map()
  for (const a of document.querySelectorAll('a[href]')) {
    if (links.length >= MAX_LINKS) break
    let href
    try { href = new URL(a.getAttribute('href'), location.href) } catch { continue }
    if (href.protocol !== 'http:' && href.protocol !== 'https:') continue
    href.hash = ''
    const url = href.toString()
    if (url === location.href.split('#')[0]) continue
    const box = vis(a)
    if (!box) continue
    const label = labelOf(a)
    if (!label) continue
    const had = byHref.get(url)
    if (had) { if (label.length > had.label.length) had.label = label; continue }   // one row per address
    const row = { n: mark(a), label, url, path: href.pathname + (href.search || ''), box }
    byHref.set(url, row)
    links.push(row)
  }

  // ---- controls: what a person could press ------------------------------------------------------
  const controls = []
  for (const e of document.querySelectorAll('button, input, select, textarea, [role="button"], [role="tab"], [role="checkbox"]')) {
    if (controls.length >= 60) break
    const box = vis(e)
    if (!box) continue
    const tag = e.tagName.toLowerCase()
    const type = (e.getAttribute('type') || '').toLowerCase()
    const label = labelOf(e) || tidy(e.name || e.id, MAX_LABEL)
    if (!label) continue
    controls.push({ n: mark(e), label, tag, type, inForm: !!e.closest('form'), box })
  }

  // ---- blocks: the text a value could be --------------------------------------------------------
  // Leaf-ish elements only, so "£45,000" is offered and not the whole page wrapped around it.
  // Whatever is in the page's own furniture is not one of its values, so headers, navigation and
  // footers are left out. A line that mashes values together ("Acme Ltd · London · £45,000") is
  // also offered in parts, because a person wants the company in the company column.
  const FURNITURE = 'header, footer, nav, aside, [role="banner"], [role="contentinfo"], [role="navigation"], [role="search"]'
  const SPLIT = /\\s+[·|•\\u2014\\u2013\\u2022]\\s+/
  const blocks = [], sawText = new Set()
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
  for (let e = walker.currentNode; e && blocks.length < MAX_BLOCKS; e = walker.nextNode()) {
    if (/^(script|style|noscript|svg|head|meta|link)$/i.test(e.tagName)) continue
    const own = Array.from(e.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ')
    const text = tidy(own, MAX_BLOCK)
    if (text.length < 2) continue
    if (!vis(e)) continue
    if (e.closest(FURNITURE)) continue
    const key = text.toLowerCase()
    if (sawText.has(key)) continue
    sawText.add(key)
    const parts = SPLIT.test(text) ? text.split(SPLIT).map((p) => p.trim()).filter((p) => p.length > 1 && p.length < 80).slice(0, 5) : []
    blocks.push({ n: mark(e), text, tag: e.tagName.toLowerCase(), parts: parts.length > 1 ? parts : [] })
  }

  const heads = Array.from(document.querySelectorAll('h1, h2')).map((h) => tidy(h.innerText, 120)).filter(Boolean).slice(0, 6)
  return {
    url: location.href, title: tidy(document.title, 160), heads,
    text: tidy(document.body ? document.body.innerText : '', 4000),
    links, controls, blocks,
    counts: { links: document.querySelectorAll('a[href]').length, blocks: blocks.length },
  }
})()`

/** Read the live page. Returns the shape above, with `path` selectors ready for a click. */
export async function readPage(chrome) {
  const page = await chrome.evaluate(READER)
  if (!page) throw new Error('the page could not be read')
  for (const list of [page.links, page.controls, page.blocks]) for (const row of list) row.css = `[data-jev-n="${row.n}"]`
  return page
}

/** What Jev is shown about the page: short, and the same text a person would see. */
export function pageState(page, extra = {}) {
  return {
    page_title: page.title,
    page_address: page.url,
    headings: page.heads.join(' | '),
    page_text: page.text.slice(0, 2500),
    ...extra,
  }
}

/** The numbered text blocks, as choice options: the key is the number, the meaning is the text. */
export function blockOptions(page, { none = 'nothing on this page says it' } = {}) {
  const options = { none }
  for (const b of page.blocks) {
    options[`b${b.n}`] = b.text
    // A mashed line is offered whole and in parts, so a column can hold just the part it wants.
    b.parts?.forEach((p, i) => { options[`b${b.n}p${i}`] = p })
  }
  return options
}

/** Turn Jev's pick back into the text that was on the page. */
export function blockText(page, pick) {
  if (!pick || pick === 'none') return ''
  const m = String(pick).match(/^b(\d+)(?:p(\d+))?$/)
  if (!m) return ''
  const block = page.blocks.find((b) => b.n === Number(m[1]))
  if (!block) return ''
  return m[2] === undefined ? block.text : block.parts?.[Number(m[2])] ?? block.text
}

const CLEAN = /(^|[?&])(utm_[^=]+|fbclid|gclid|ref|source)=[^&]*/gi
/** One address, tidied, so the same page is not visited twice under two names. */
export function canonical(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    u.search = u.search.replace(CLEAN, '$1').replace(/[?&]+$/, '').replace(/&&+/g, '&').replace(/\?&/, '?')
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
    return u.toString()
  } catch { return String(url) }
}
