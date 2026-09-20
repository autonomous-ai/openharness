// crawl.mjs — the loop. One Jev call per page does all of the thinking about that page.
//
// On a list page that one call is: "is this page a list or one item?", plus a separate yes/no for
// EVERY link on the page ("is this a link to a job posting?"), plus "which link is the next page?".
// A hundred and twenty typed questions come back together, each with its own probability, because
// asking Jev many questions about one state costs about the same as asking one.
//
// On an item page the same single call pulls every field: each field is a choice over the numbered
// text blocks the reader found, so the answer IS a piece of text from the page.
import { jev } from '../toolchain/jev.mjs'
import { readPage, pageState, blockOptions, blockText, canonical, wallReason, findSearchBox } from './page.mjs'

export const LIMITS = { fields: 12, maxPages: 500, maxItems: 2000, linksPerCall: 120 }

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : d)
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** Read the job, fill in what it does not say, and list what is wrong with it. */
export function normalizeJob(raw) {
  const errors = []
  const j = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const start = short(j.start, 500)
  if (!start) errors.push('no "start": give the web address of the page to begin on')
  const item = short(j.item, 160) || 'one of the things to collect'
  const fields = []
  const seen = new Set()
  for (const f of Array.isArray(j.fields) ? j.fields : []) {
    if (fields.length >= LIMITS.fields) { errors.push(`only the first ${LIMITS.fields} fields are used`); break }
    const ask = short(typeof f === 'string' ? f : f?.ask, 200)
    if (!ask) { errors.push('a field needs "ask": what to look for, in plain words'); continue }
    const id = (short(typeof f === 'object' ? f?.id : '', 40) || ask).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || `f${fields.length + 1}`
    if (seen.has(id)) { errors.push(`two fields are both called "${id}"`); continue }
    seen.add(id)
    const type = ['pick', 'yesno', 'score'].includes(f?.type) ? f.type : 'pick'
    const levels = Array.isArray(f?.levels) ? f.levels.map((l) => short(l, 40)).filter(Boolean).slice(0, 10) : []
    if (type === 'score' && levels.length < 2) { errors.push(`field "${id}" is a score, so it needs at least two levels`); continue }
    fields.push({ id, ask, type, levels, name: short(typeof f === 'object' ? f?.name : '', 40) || id })
  }
  if (!fields.length) errors.push('no "fields": say what to collect for each item, in plain words')
  let hosts = []
  try { hosts = [new URL(start).hostname.toLowerCase()] } catch { /* the start address is already reported */ }
  for (const h of Array.isArray(j.alsoVisit) ? j.alsoVisit : []) { const s = short(h, 200).toLowerCase().replace(/^https?:\/\//, '').split('/')[0]; if (s) hosts.push(s) }
  return {
    job: {
      task: short(j.task, 200) || `Collect ${item}`,
      start, item, fields,
      search: short(j.search, 120),
      keep: short(j.keep, 300),
      maxPages: clamp(j.maxPages, 1, LIMITS.maxPages, 25),
      maxItems: clamp(j.maxItems, 1, LIMITS.maxItems, 60),
      sameSiteOnly: j.sameSiteOnly !== false,
      show: j.show !== false,
      // A job that changes starts itself. Nobody should watch an idle screen waiting to press a button.
      autoStart: j.autoStart !== false,
      hosts: [...new Set(hosts)],
    },
    errors,
  }
}

// ---- the questions ------------------------------------------------------------------------------
const KIND = { list: 'a page that lists many of them, with a link to each', item: 'the page of ONE of them, with its details', other: 'neither: a home page, a login wall, a search box, an error, or something else' }

/** Everything worth asking about a list page, in one call. */
export function listQuestions(page, job, { wantLinks = true, wantNext = true } = {}) {
  const q = { kind: jev.choice(KIND, `The task is: ${job.task}. Each thing being collected is ${job.item}. What kind of page is this?`) }
  const links = page.links.slice(0, LIMITS.linksPerCall)
  if (wantLinks) for (const l of links) {
    q[`l${l.n}`] = jev.noul(`"${l.label}" is the text of a link on this page, pointing at ${l.path}. Is "${l.label}" the title of ${job.item}, rather than part of the site's own menu?`, { true: `"${l.label}" names ${job.item}`, false: "it is a menu item, a filter, a category, a page number, or one of the site's own pages" })
  }
  if (wantNext) {
    const options = { none: 'there is no next page link' }
    for (const l of links) options[`l${l.n}`] = `"${l.label}" → ${l.path}`
    q.nextpage = jev.choice(options, 'Which link goes to the NEXT PAGE of this same list (page 2, "next", "more results")? Not a link to one of the things themselves.')
  }
  return { questions: q, links }
}

/** Everything worth asking about one item's page, in one call. */
export function itemQuestions(page, job) {
  const options = blockOptions(page, { none: `this page does not say it` })
  const q = { kind: jev.choice(KIND, `The task is: ${job.task}. Each thing being collected is ${job.item}. What kind of page is this?`) }
  for (const f of job.fields) {
    if (f.type === 'yesno') q[`f_${f.id}`] = jev.noul(`About ${job.item} on this page: ${f.ask}`)
    else if (f.type === 'score') q[`f_${f.id}`] = jev.score(f.levels, `About ${job.item} on this page: ${f.ask}`)
    else q[`f_${f.id}`] = jev.choice(options, `On this page, which piece of text is ${f.ask}? Pick the exact words from the page.`)
  }
  if (job.keep) q.keep = jev.noul(`The person wants only the ones where: ${job.keep}. Does ${job.item} on this page fit that?`)
  return { questions: q, blocks: page.blocks.length }
}

/** Jev's answers about an item page, turned into one row. Every value came off the page. */
export function rowFrom(page, job, answers) {
  const row = { url: canonical(page.url), title: page.title, fields: {}, confidence: {} }
  for (const f of job.fields) {
    const a = answers[`f_${f.id}`]
    if (!a) { row.fields[f.id] = ''; row.confidence[f.id] = 0; continue }
    if (f.type === 'yesno') { row.fields[f.id] = a.noul >= 0.5 ? 'yes' : 'no'; row.confidence[f.id] = Math.max(a.noul, 1 - a.noul) }
    else if (f.type === 'score') { const i = Math.round(Number(a.score ?? 0)); row.fields[f.id] = f.levels[Math.max(0, Math.min(f.levels.length - 1, i))] ?? ''; row.confidence[f.id] = Number(a.confidence ?? 0) }
    else { row.fields[f.id] = blockText(page, a.choice); row.confidence[f.id] = a.choice === 'none' ? 0 : Number(a.confidence ?? 0) }
  }
  if (job.keep) { const k = answers.keep; row.keep = k ? k.noul >= 0.5 : true; row.keepConfidence = k ? Math.max(k.noul, 1 - k.noul) : 0 }
  return row
}

/** The links Jev said are items, surest first, and the next-page link if it named one. */
export function pickLinks(links, answers, { threshold = 0.5 } = {}) {
  const items = []
  for (const l of links) {
    const a = answers[`l${l.n}`]
    if (!a) continue
    if (a.noul >= threshold) items.push({ ...l, p: a.noul })
  }
  items.sort((a, b) => a.n - b.n)   // page order: a spreadsheet should read like the page did
  const pick = answers.nextpage?.choice
  const next = pick && pick !== 'none' ? links.find((l) => `l${l.n}` === pick) ?? null : null
  return { items, next, judged: links.length }
}

/**
 * Run a job. Every step is reported through `onEvent` so the pane can show it live.
 * @param {object} o
 * @param {object} o.chrome   from toolchain/chrome.mjs
 * @param {object} o.job      from normalizeJob
 * @param {function} o.ask    async ({ state, questions }) => { answers, latencyMs, usage, client }
 * @param {function} o.onEvent
 * @param {function} [o.stopped]  () => true to stop early
 */
export async function runJob({ chrome, job, ask, onEvent, stopped = () => false }) {
  const out = { rows: [], pagesRead: 0, linksJudged: 0, calls: 0, errors: [], startedAt: Date.now(), finishedAt: null, stoppedEarly: false }
  const visited = new Set()
  const queue = []          // item pages to open
  let listUrl = job.start
  let listPages = 0

  const say = (type, data) => { try { onEvent?.({ type, at: Date.now(), ...data }) } catch { /* the pane may be gone */ } }
  // maxItems bounds the things collected; maxPages bounds how far down the list it walks.
  const budgetLeft = () => out.rows.length < job.maxItems

  while (listUrl && budgetLeft() && listPages < job.maxPages && !stopped()) {
    listPages++
    say('going', { url: listUrl, what: listPages === 1 ? 'the page you gave' : `list page ${listPages}` })
    let page
    try {
      await chrome.go(listUrl)
      page = await readPage(chrome)
      // "amazon.com" plus "fencing gloves" is how a person says it. Type it into the site's own box.
      if (listPages === 1 && job.search) {
        const box = findSearchBox(page)
        if (!box) say('trouble', { url: page.url, message: `no search box was found on this page, so "${job.search}" was not searched for. Put the site's own search address in "start" instead.` })
        else {
          say('searching', { words: job.search })
          await chrome.search(box.css, job.search)
          page = await readPage(chrome)
        }
      }
    } catch (e) { out.errors.push({ url: listUrl, message: String(e.message ?? e) }); say('trouble', { url: listUrl, message: String(e.message ?? e) }); break }
    const wall = wallReason(page)
    if (wall) {
      out.walled = `${new URL(page.url).hostname}: ${wall}`
      out.errors.push({ url: page.url, message: out.walled })
      say('walled', { url: page.url, message: out.walled })
      break
    }
    out.pagesRead++
    visited.add(canonical(listUrl))
    say('read', { url: page.url, title: page.title, links: page.links.length, blocks: page.blocks.length })

    const { questions, links } = listQuestions(page, job, { wantNext: listPages < job.maxPages })
    const res = await ask({ state: pageState(page), questions })
    out.calls++
    const { items, next, judged } = pickLinks(links, res.answers)
    out.linksJudged += judged
    say('judged', { url: page.url, kind: res.answers.kind?.choice, judged, found: items.length, latencyMs: res.latencyMs, next: next?.label ?? null, links: links.map((l) => ({ n: l.n, label: l.label, p: res.answers[`l${l.n}`]?.noul ?? 0 })).sort((a, b) => b.p - a.p).slice(0, 40) })

    // The page the person pointed at may itself be the one thing they want.
    if (listPages === 1 && res.answers.kind?.choice === 'item') {
      const one = await collect(page)
      if (one) { say('row', { row: one, of: out.rows.length }) }
    }
    for (const l of items) { const c = canonical(l.url); if (!visited.has(c)) { visited.add(c); queue.push({ ...l, url: c }) } }

    // Open what was found before asking for another list page, so rows start landing at once.
    while (queue.length && budgetLeft() && !stopped()) {
      const link = queue.shift()
      say('going', { url: link.url, what: link.label })
      let itemPage
      try {
        await chrome.go(link.url)
        itemPage = await readPage(chrome)
      } catch (e) { out.errors.push({ url: link.url, message: String(e.message ?? e) }); say('trouble', { url: link.url, message: String(e.message ?? e) }); continue }
      out.pagesRead++
      say('read', { url: itemPage.url, title: itemPage.title, links: itemPage.links.length, blocks: itemPage.blocks.length })
      // A site can serve its list happily and then challenge every page under it. Without this the
      // challenge page's words become a blank row and the run looks like it worked.
      const itemWall = wallReason(itemPage)
      if (itemWall) {
        out.walled = `${new URL(itemPage.url).hostname}: ${itemWall}`
        out.errors.push({ url: itemPage.url, message: out.walled })
        say('walled', { url: itemPage.url, message: out.walled })
        break
      }
      const row = await collect(itemPage, link.label)
      if (row) say('row', { row, of: out.rows.length })
    }
    listUrl = next && budgetLeft() && !stopped() ? next.url : null
    if (!listUrl && next && budgetLeft()) out.stoppedEarly = true
  }

  async function collect(page, fromLabel = '') {
    const { questions } = itemQuestions(page, job)
    const res = await ask({ state: pageState(page), questions })
    out.calls++
    const row = rowFrom(page, job, res.answers)
    row.n = out.rows.length + 1
    row.fromLabel = fromLabel
    row.latencyMs = res.latencyMs
    row.kind = res.answers.kind?.choice ?? 'item'
    if (row.kind === 'other' && !Object.values(row.fields).some(Boolean)) { say('skipped', { url: page.url, why: 'nothing of the job was on this page' }); return null }
    out.rows.push(row)
    return row
  }

  out.stoppedEarly = stopped() || !budgetLeft()
  out.finishedAt = Date.now()
  say('done', { rows: out.rows.length, pages: out.pagesRead, links: out.linksJudged })
  return out
}
