// demosite.mjs — a small made-up job board, served on the loopback so the harness has something
// real to browse the moment it opens: real HTTP, real links, real pagination, a real Chrome.
// Only the content is invented. Point `start` at a real address and nothing else changes.
import { createServer } from 'node:http'

const COMPANIES = ['Fernhill Cloud', 'Brightpath Labs', 'Marlow & Dean', 'Kestrel Analytics', 'Northwind Health', 'Tidepool Games', 'Aster Robotics', 'Glasshouse Media']
const TITLES = ['Senior Python Engineer', 'Data Analyst', 'Frontend Developer', 'Site Reliability Engineer', 'Product Designer', 'Machine Learning Engineer', 'Support Engineer', 'Technical Writer', 'Platform Engineer', 'QA Engineer', 'Mobile Developer', 'Security Analyst']
const PLACES = ['London', 'Manchester', 'Remote (UK)', 'Bristol', 'Edinburgh', 'Remote (Europe)', 'Leeds', 'Cambridge']
const TYPES = ['Permanent', 'Contract', 'Part time']

const rand = (seed) => { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

export function makeJobs(count = 36, seed = 20260920) {
  const r = rand(seed)
  const pick = (l) => l[Math.floor(r() * l.length)]
  return Array.from({ length: count }, (_, i) => {
    const low = 30 + Math.floor(r() * 9) * 5
    const place = pick(PLACES)
    return {
      id: 1000 + i, title: pick(TITLES), company: pick(COMPANIES), place,
      salary: `£${low},000 - £${low + 10 + Math.floor(r() * 4) * 5},000`,
      type: pick(TYPES), remote: place.startsWith('Remote'),
      python: r() < 0.45, posted: `${1 + Math.floor(r() * 27)} September 2026`,
    }
  })
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const CSS = `body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1c2330}
header{background:#12243a;color:#fff;padding:14px 28px;display:flex;gap:22px;align-items:center}
header a{color:#cfe0f5;text-decoration:none;font-size:14px} header b{font-size:17px}
main{max-width:860px;margin:0 auto;padding:24px 28px 60px}
.card{background:#fff;border:1px solid #e2e6ec;border-radius:10px;padding:16px 18px;margin-bottom:12px}
.card h2{margin:0 0 4px;font-size:17px}.card h2 a{color:#12243a;text-decoration:none}
.meta{color:#5b6676;font-size:13.5px}
.pager{display:flex;gap:12px;margin-top:22px;align-items:center}
.pager a{background:#12243a;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:14px}
.detail dt{color:#5b6676;font-size:13px;margin-top:12px}.detail dd{margin:2px 0 0;font-size:16px;font-weight:600}
footer{color:#8a94a2;font-size:12.5px;padding:24px 28px;text-align:center}`
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><b>Fernhill Jobs</b><a href="/">All roles</a><a href="/about">About</a><a href="/contact">Contact us</a><a href="/login">Sign in</a></header>
<main>${body}</main><footer>A made-up job board, served on this machine for the Jev Browser harness. None of these roles exist.</footer></body></html>`

/** Start the made-up site. Returns { url, close }. */
export async function startDemoSite({ port = 0, perPage = 12, jobs = makeJobs() } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (html, code = 200) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html) }
    const m = url.pathname.match(/^\/job\/(\d+)$/)
    if (m) {
      const job = jobs.find((j) => String(j.id) === m[1])
      if (!job) return send(page('Not found', '<h1>No such role</h1>'), 404)
      return send(page(`${job.title} · ${job.company}`, `<div class="card detail">
        <h2>${esc(job.title)}</h2>
        <p class="meta">${esc(job.company)} · ${esc(job.place)}</p>
        <dl><dt>Salary</dt><dd>${esc(job.salary)}</dd>
        <dt>Contract</dt><dd>${esc(job.type)}</dd>
        <dt>Posted</dt><dd>${esc(job.posted)}</dd></dl>
        <p>We are looking for ${esc(job.title.toLowerCase())} to join ${esc(job.company)}${job.remote ? '. This role is fully remote' : ` in our ${esc(job.place)} office`}.
        ${job.python ? 'Day to day you will write Python and review other people\'s Python.' : 'Our stack is TypeScript end to end.'}</p>
        <p><a href="/">Back to all roles</a></p></div>`))
    }
    if (url.pathname === '/about') return send(page('About', '<div class="card"><h2>About Fernhill Jobs</h2><p>A made-up job board. It exists so a browser harness has somewhere honest to practise.</p></div>'))
    if (url.pathname === '/contact') return send(page('Contact us', '<div class="card"><h2>Contact us</h2><p>Nobody is here.</p></div>'))
    if (url.pathname === '/login') return send(page('Sign in', '<div class="card"><h2>Sign in</h2><form><p><input name="email" placeholder="Email"></p><p><input type="password" name="password" placeholder="Password"></p><p><button type="submit">Sign in</button></p></form></div>'))
    if (url.pathname !== '/') return send(page('Not found', '<h1>Not found</h1>'), 404)
    const p = Math.max(1, Number(url.searchParams.get('page') || 1))
    const slice = jobs.slice((p - 1) * perPage, p * perPage)
    const cards = slice.map((j) => `<div class="card"><h2><a href="/job/${j.id}">${esc(j.title)}</a></h2>
      <p class="meta">${esc(j.company)} · ${esc(j.place)} · ${esc(j.salary)}</p></div>`).join('')
    const last = Math.ceil(jobs.length / perPage)
    const pager = `<div class="pager">${p > 1 ? `<a href="/?page=${p - 1}">Previous page</a>` : ''}<span class="meta">Page ${p} of ${last}</span>${p < last ? `<a href="/?page=${p + 1}">Next page</a>` : ''}</div>`
    send(page(`Fernhill Jobs · page ${p}`, `<h1>Open roles</h1><p class="meta">${jobs.length} made-up roles</p>${cards}${pager}`))
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/`, port: server.address().port, jobs, async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) } }
}
