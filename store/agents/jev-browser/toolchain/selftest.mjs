#!/usr/bin/env node
// selftest.mjs — run the whole chain and say which link in it broke.
//
//   node toolchain/selftest.mjs            the practice site, no key needed
//   node toolchain/selftest.mjs <url>      that site instead
//   node toolchain/selftest.mjs --show     a visible window, like the pane uses
//
// Every step prints ok or fail with the reason, so a person can paste the output and be told what
// to do rather than "nothing happened".
import { findChrome, openChrome } from './chrome.mjs'
import { describeCredentials, resolveCredentials, evaluate, jev } from './jev.mjs'
import { readPage, wallReason } from '../viewer/page.mjs'
import { startDemoSite } from '../viewer/demosite.mjs'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const show = args.includes('--show')
const url = args.find((a) => !a.startsWith('--'))
let failed = 0
const ok = (what, detail = '') => console.log(`ok     ${what}${detail ? ' — ' + detail : ''}`)
const bad = (what, detail) => { failed++; console.log(`FAIL   ${what}\n       ${detail}`) }

console.log(`node ${process.version}`)
const chromePath = findChrome()
if (!chromePath) bad('Google Chrome', 'not found. Install Chrome, or set CHROME_PATH to where it is.')
else ok('Google Chrome', chromePath)

// A window left open on the harness's own profile is the usual reason nothing happens.
const workspace = process.env.HARNESS_WORKSPACE || process.cwd()
const profileDir = join(workspace, '.harness', 'chrome-profile')
if (existsSync(join(profileDir, 'SingletonLock'))) {
  console.log(`warn   a browser may still be open on this harness's profile (${profileDir}).`)
  console.log(`       If the next step fails, close that window and run this again.`)
}

const cred = resolveCredentials()
if (cred) ok('Jev key', describeCredentials())
else console.log(`warn   no Jev key: an offline stand-in will answer. Paste a key in the pane's "Jev · live mind" panel.`)

if (!chromePath) { console.log(`\n${failed} step failed.`); process.exit(1) }

const site = url ? null : await startDemoSite()
const target = url ?? site.url
let chrome = null
try {
  try {
    chrome = await openChrome({ profileDir: show ? profileDir : mkdtempSync(join(tmpdir(), 'jev-selftest-')), show, allowedHosts: [new URL(target).hostname] })
    ok(`opened a ${show ? 'visible' : 'headless'} browser`, `debugging on port ${chrome.port}`)
  } catch (e) { bad('opening the browser', e.message); throw e }

  try {
    const went = await chrome.go(target)
    ok('opened the page', went.url)
  } catch (e) { bad(`opening ${target}`, e.message); throw e }

  const page = await readPage(chrome)
  const wall = wallReason(page)
  if (wall) bad('reading the page', `${wall}. This site refuses an automated browser; try another.`)
  else ok('read the page', `${page.links.length} links, ${page.blocks.length} pieces of text`)

  try {
    const t0 = Date.now()
    const res = await evaluate({ state: { text: page.title || 'a web page' }, questions: { q: jev.noul('Is this text the title of a web page?') } })
    ok(`asked Jev`, `${res.client}, ${Date.now() - t0} ms, answer ${Number(res.answers.q.noul).toFixed(2)}`)
  } catch (e) { bad('asking Jev', e.message) }
} catch { /* already reported */ } finally {
  await chrome?.close()
  await site?.close()
}

const files = existsSync(workspace) ? readdirSync(workspace).filter((f) => !f.startsWith('.')) : []
console.log(`\nworkspace ${workspace}${files.length ? ` (${files.join(', ')})` : ' (empty)'}`)
console.log(failed ? `${failed} step failed — the first FAIL above is the one to fix.` : 'Everything works. If the pane still does nothing, say so and paste this output.')
process.exit(failed ? 1 : 0)
