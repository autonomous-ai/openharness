#!/usr/bin/env node
// check.mjs — validate a browse.json for the Jev Browser harness. The viewer and this script read
// the job through the same code, so what passes here is what the pane will run.
//   node toolchain/check.mjs            checks $HARNESS_WORKSPACE/browse.json (or ./browse.json)
//   node toolchain/check.mjs path.json  checks that file
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeJob, LIMITS } from '../viewer/crawl.mjs'
import { checkUrl, findChrome } from './chrome.mjs'

const file = process.argv[2] || join(process.env.HARNESS_WORKSPACE || '.', 'browse.json')
let errors = 0, warnings = 0
const error = (m) => { errors++; console.log(`error  ${m}`) }
const warn = (m) => { warnings++; console.log(`warn   ${m}`) }

let raw
try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { console.log(`error  cannot read browse.json: ${e.message}`); process.exit(1) }
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { console.log('error  browse.json must be a JSON object'); process.exit(1) }

const { job, errors: problems } = normalizeJob(raw)
for (const p of problems) error(p)

// "demo" is the little made-up job board the viewer serves itself.
if (job.start && !/^demo$/i.test(job.start)) {
  try { checkUrl(job.start, []) } catch (e) { error(`"start": ${e.message}`) }
  if (/^http:\/\//i.test(job.start) && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(job.start)) warn('"start" is plain http, not https')
}
for (const f of job.fields) {
  if (f.type === 'pick' && f.ask.length < 4) warn(`field "${f.id}": say what to look for in a few more words`)
  if (f.type === 'pick' && /^(is|are|does|do|can|has|have|will|should)\b/i.test(f.ask)) warn(`field "${f.id}" reads as a yes or no question. Add "type": "yesno", or it will pick a piece of text instead`)
}
if (job.fields.length && !job.fields.some((f) => f.type === 'pick')) warn('no field takes its value off the page, so the spreadsheet will hold only judgements')
if (job.maxItems > 200) warn(`maxItems is ${job.maxItems}: that is ${job.maxItems} page loads, so it will take a while`)
if (!job.sameSiteOnly) warn('"sameSiteOnly": false lets it follow links off the site it started on')
if (!findChrome()) warn('Google Chrome was not found on this machine. Install it, or set CHROME_PATH')

if (errors) { console.log(`fail   invalid browse.json (${errors} error${errors > 1 ? 's' : ''}, ${warnings} warning${warnings === 1 ? '' : 's'})`); process.exit(1) }
console.log(`ok     browse.json is valid: ${job.fields.length} field${job.fields.length === 1 ? '' : 's'}, up to ${job.maxItems} things from ${job.maxPages} pages${warnings ? `, ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`)
console.log(`info   limits: ${LIMITS.fields} fields, ${LIMITS.linksPerCall} links judged per call`)
