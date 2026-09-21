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
    const attr = (k) => tidy(e.getAttribute(k) || '', 60)
    controls.push({ n: mark(e), label, tag, type, name: attr('name'), placeholder: attr('placeholder'), aria: attr('aria-label'), id: attr('id'), inForm: !!e.closest('form'), box })
  }

  // ---- blocks: the text a value could be --------------------------------------------------------
  // Leaf-ish elements only, so "£45,000" is offered and not the whole page wrapped around it.
  // Whatever is in the page's own furniture is not one of its values, so headers, navigation and
  // footers are left out. A line that mashes values together ("Acme Ltd · London · £45,000") is
  // also offered in parts, because a person wants the company in the company column.
  const FURNITURE = 'header, footer, nav, aside, [role="banner"], [role="contentinfo"], [role="navigation"], [role="search"]'
  const LABELLED = /^(dt|th)$/i          // a label whose value sits in the element next to it
  const SPLIT = /\\s+[·|•\\u2014\\u2013\\u2022]\\s+/
  const MAIN = 'main, article, [role="main"], #main, #content, .content'
  const found = [], sawText = new Set(), consumed = new Set()
  const ownText = (e) => tidy(Array.from(e.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' '), MAX_BLOCK)
  const allText = (e) => tidy(e.innerText || e.textContent, MAX_BLOCK + 1)
  /** Does a child element carry text of its own? Then that child is the block, not this one. */
  const hasTextChild = (e) => { for (const kid of e.children) if (allText(kid).length >= 2) return true; return false }
  // Numbers a person would want on their own: "In stock (19 available)" also offers "19".
  const numbersIn = (t) => (t.match(/\\d[\\d,.]*/g) || []).map((x) => x.replace(/[.,]$/, '')).filter((x) => x.length && x !== t).slice(0, 2)
  const main = document.querySelector(MAIN)
  let scanned = 0
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
  for (let e = walker.currentNode; e && scanned < 6000; e = walker.nextNode()) {
    scanned++
    if (/^(script|style|noscript|svg|head|meta|link|template)$/i.test(e.tagName)) continue
    if (consumed.has(e)) continue
    if (e.closest(FURNITURE)) continue
    let text = '', label = ''
    // A label and its value belong together, or the value gets dropped as a repeat of one further
    // up and the label is left looking like an empty promise.
    if (LABELLED.test(e.tagName)) {
      const next = e.nextElementSibling
      const mine = allText(e), value = next && /^(dd|td)$/i.test(next.tagName) ? allText(next) : ''
      if (mine && value) { consumed.add(next); label = mine; text = tidy(mine.replace(/:\\s*$/, '') + ': ' + value, MAX_BLOCK) }
    }
    // Otherwise: the innermost element that carries text. A modern page wraps its words several
    // elements deep, so this is the only place the value really is.
    if (!text) {
      if (hasTextChild(e)) continue
      text = ownText(e) || allText(e)
    }
    if (text.length < 2 || text.length > MAX_BLOCK) continue
    if (!vis(e)) continue
    const key = text.toLowerCase()
    if (sawText.has(key)) continue
    sawText.add(key)
    let parts = SPLIT.test(text) ? text.split(SPLIT).map((p) => p.trim()) : []
    if (label) parts = [text.slice(label.replace(/:\\s*$/, '').length + 2)]
    parts = parts.map((p) => p.trim()).filter((p) => p.length > 1 && p.length < 80)
    for (const p of [...parts, text]) for (const num of numbersIn(p)) if (!parts.includes(num)) parts.push(num)
    found.push({ e, text, tag: e.tagName.toLowerCase(), parts: parts.slice(0, 5), inMain: !!main && main.contains(e) })
  }
  // What the page is about comes before the furniture the site puts round it.
  found.sort((a, b) => (b.inMain ? 1 : 0) - (a.inMain ? 1 : 0))
  const blocks = found.slice(0, MAX_BLOCKS).map((b) => ({ n: mark(b.e), text: b.text, tag: b.tag, parts: b.parts }))
  blocks.sort((a, b) => a.n - b.n)


  const heads = Array.from(document.querySelectorAll('h1, h2')).map((h) => tidy(h.innerText, 120)).filter(Boolean).slice(0, 6)
  return {
    url: location.href, title: tidy(document.title, 160), heads,
    text: tidy(document.body ? document.body.innerText : '', 4000),
    links, controls, blocks,
    counts: { links: document.querySelectorAll('a[href]').length, blocks: blocks.length },
  }
})()`

/**
 * Read the live page. A page that builds itself in the browser can look finished while it is still
 * filling in, and a read a moment too early comes back nearly empty. So a thin first read is given
 * one more second and tried again, which is the difference between a column and a blank column.
 */
export async function readPage(chrome, { retry = true } = {}) {
  let page = await chrome.evaluate(READER)
  if (!page) throw new Error('the page could not be read')
  if (retry && page.blocks.length < 8 && page.links.length < 8) {
    await chrome.settle(4000)
    const again = await chrome.evaluate(READER)
    if (again && again.blocks.length + again.links.length > page.blocks.length + page.links.length) page = again
  }
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
export const MAX_OPTIONS = 250   // a choice takes at most 255
export function blockOptions(page, { none = 'nothing on this page says it' } = {}) {
  const options = { none }
  let n = 1
  for (const b of page.blocks) {
    if (n >= MAX_OPTIONS) break
    options[`b${b.n}`] = b.text
    n++
    // A line that holds more than one value is offered whole and in parts, so a column can take the
    // part it wants: the company out of "Acme · Leeds", the 19 out of "In stock (19 available)".
    b.parts?.forEach((p, i) => { if (n < MAX_OPTIONS) { options[`b${b.n}p${i}`] = p; n++ } })
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

const WALL = /sorry[!,. ]{0,3}something went wrong|are you a (robot|human)|unusual traffic|access denied|permission denied|request blocked|captcha|verify (you are|your) human|enable javascript|checking your browser|rate limit|too many requests|40[139] (forbidden|error)|pardon our interruption|robots?\.txt|robot policy|automated (access|traffic|requests?)|bot (detection|protection)|client challenge|just a moment|attention required|ddos protection|please enable cookies|unsupported browser|your (request|activity) (has been|was) (blocked|flagged)/i
/**
 * Did the site serve its page, or a wall? A bot wall has almost nothing on it, or says so outright.
 * Worth naming: a run that quietly collects nothing looks like a broken tool, and it is not.
 * @returns {string|null} what to tell the person, or null when the page looks real
 */
export function wallReason(page) {
  const hit = `${page.title} ${page.text.slice(0, 600)}`.match(WALL)
  if (hit) return `the site answered with a block page ("${hit[0].trim()}") instead of its own`
  // An error page carries plenty of text, so the emptiness test below never catches it, and its
  // words would otherwise be collected as if they were values.
  if (/^(error|wikimedia error|access denied|forbidden|blocked|not acceptable|service unavailable|too many requests)\b/i.test(page.title.trim())) {
    return `the site answered with an error page ("${page.title.trim().slice(0, 40)}") instead of its own`
  }
  if (page.links.length < 3 && page.blocks.length < 4) return 'the page came back nearly empty, which usually means the site refused an automated browser or needs a sign-in'
  return null
}

/** The search box a site puts on its pages, or null. */
export function findSearchBox(page) {
  const fields = page.controls.filter((c) => c.tag === 'input' || c.tag === 'textarea')
  const about = (c) => `${c.type} ${c.name} ${c.id} ${c.placeholder} ${c.aria} ${c.label}`
  return fields.find((c) => c.type === 'search')
    ?? fields.find((c) => /search|query|keyword|find/i.test(about(c)) && !/pass|card|email|postcode|zip/i.test(about(c)))
    ?? fields.find((c) => /^q$|^s$|^query$/i.test(c.name))
    ?? null
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
