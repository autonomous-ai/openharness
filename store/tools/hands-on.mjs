#!/usr/bin/env node
// Build the readable and interactive field guides from the same reviewed content.
// Local files only: no installation, runtime execution, publication or network access.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const docs = resolve(root, 'docs')
const check = process.argv.includes('--check')
const experiences = JSON.parse(
  readFileSync(resolve(root, 'store/hands-on.json'), 'utf8')
)
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]
  )
const seen = new Set()
for (const item of experiences) {
  if (!/^[a-z0-9-]+$/.test(item.id) || seen.has(item.id))
    throw Error(`Invalid experience: ${item.id}`)
  seen.add(item.id)
  for (const field of [
    'name',
    'craft',
    'title',
    'intro',
    'poster',
    'alt',
    'scene',
    'prompt',
    'keeps',
    'followup',
    'note',
    'guide'
  ]) {
    if (typeof item[field] !== 'string' || !item[field].trim())
      throw Error(`${item.id}: missing ${field}`)
  }
  if (
    item.steps?.length !== 3 ||
    item.steps.some((step) => !step.title || !step.text)
  )
    throw Error(`${item.id}: expected three steps`)
  for (const path of [item.poster, item.guide, item.video].filter(Boolean)) {
    const full = resolve(docs, path)
    if (
      !full.startsWith(root + sep) ||
      !existsSync(full) ||
      /[?#\\]/.test(path)
    )
      throw Error(`${item.id}: missing or invalid local asset ${path}`)
  }
  const facts = JSON.parse(
    readFileSync(resolve(root, `store/agents/${item.id}/store.json`), 'utf8')
  )
  if (!facts.examples.some((example) => example.prompt === item.prompt))
    throw Error(`${item.id}: add the guide's starting prompt to store.json too`)
}
if (!experiences.length) throw Error('The field guide is empty')

const nav = experiences
  .map(
    (item, i) =>
      `<a href="#${item.id}" data-experience="${item.id}"><span class="craft-number">${String(i + 1).padStart(2, '0')}</span><span><strong>${esc(item.craft)}</strong><small>${esc(item.name)}</small></span></a>`
  )
  .join('\n')
const articles = experiences
  .map((item, i) => {
    const next = experiences[(i + 1) % experiences.length]
    return `<article id="${item.id}" class="experience" aria-labelledby="${item.id}-title">
  <div class="overview">
    <div class="invitation"><p class="eyebrow">${esc(item.name)} / ${esc(item.craft)}</p><h2 id="${item.id}-title">${esc(item.title)}</h2><p class="intro">${esc(item.intro)}</p><div class="keeps"><span class="eyebrow">Yours to keep</span><p>${esc(item.keeps)}</p></div><a class="guide-link" href="${esc(item.guide)}">Open the harness guide <span aria-hidden="true">↗</span></a></div>
    <figure>
      <div class="media-stage"><img class="poster" src="${esc(item.poster)}" alt="${esc(item.alt)}" loading="lazy" decoding="async">${item.video ? `<video hidden controls playsinline preload="none" data-src="${esc(item.video)}" poster="${esc(item.poster)}" aria-label="${esc(item.name)} recorded walkthrough" aria-describedby="${item.id}-scene"></video>` : ''}</div>
      <div class="media-actions">${item.video ? `<button type="button" class="watch" data-watch><span aria-hidden="true">▶</span> Watch real session${item.audio ? ' · with music' : ''}</button>` : '<span class="still-label">Real simulation · captured view</span>'}<a href="${esc(item.poster)}" target="_blank" rel="noopener">Full image <span aria-hidden="true">↗</span></a>${item.video ? `<a class="video-file" href="${esc(item.video)}">Video file</a>` : ''}</div>
      <figcaption id="${item.id}-scene">${item.badge ? `<strong class="practice-badge">${esc(item.badge)}</strong> ` : ''}${esc(item.scene)}</figcaption>
    </figure>
  </div>
  <div class="practice">
    <section class="starting-point" aria-labelledby="${item.id}-start"><p class="eyebrow">Start something of your own</p><h3 id="${item.id}-start">Give the agent a direction.</h3><label class="sr-only" for="${item.id}-prompt">Starting prompt for ${esc(item.name)}</label><textarea id="${item.id}-prompt" class="prompt" readonly rows="5" spellcheck="false">${esc(item.prompt)}</textarea><div class="copy-row"><button type="button" class="primary" data-copy="${item.id}-prompt">Copy starting prompt</button><span class="copy-status" role="status"></span></div><p class="start-help">In Harness, start a ${esc(item.name)} project and paste this into the agent chat. Change the idea to make it yours.</p><details><summary>Continue from something you kept</summary><label class="sr-only" for="${item.id}-followup">Follow-up prompt for ${esc(item.name)}</label><textarea id="${item.id}-followup" class="prompt followup" readonly rows="5" spellcheck="false">${esc(item.followup)}</textarea><div class="copy-row"><button type="button" data-copy="${item.id}-followup">Copy follow-up</button><span class="copy-status" role="status"></span></div><p class="start-help">Keep the result in this project, or give the agent the path to your downloaded copy.</p></details></section>
    <section class="walkthrough" aria-labelledby="${item.id}-try"><p class="eyebrow">Then get your hands on it</p><h3 id="${item.id}-try">Make a choice. See it happen.</h3><ol>${item.steps.map((step) => `<li><h4>${esc(step.title)}</h4><p>${esc(step.text)}</p></li>`).join('')}</ol><p class="scope-note">${esc(item.note)}</p></section>
  </div>
  <div class="next-craft"><span>There is another craft to try.</span><a href="#${next.id}" data-experience="${next.id}">${esc(next.craft)} with ${esc(next.name)} <span aria-hidden="true">→</span></a></div>
</article>`
  })
  .join('\n')

const html = `<!doctype html>
<!-- Generated by store/tools/hands-on.mjs. Edit store/hands-on.json, not this file. -->
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Eight hands-on OpenHarness experiences, with real native demos, starting prompts and work you can keep."><title>Get your hands on it · OpenHarness</title><link rel="stylesheet" href="hands-on.css"><script src="hands-on.js" defer></script></head>
<body>
<a class="skip-link" href="#experiences">Skip to the experiences</a>
<header class="masthead"><a href="../README.md" class="wordmark">OpenHarness</a><span>A field guide for the curious</span><a href="hands-on.md">Text guide <span aria-hidden="true">↗</span></a></header>
<main>
  <div class="opening"><p class="eyebrow">From handoff to hands-on</p><h1>Get your hands on it.</h1><p>The agent brings the tools of a craft. You bring the idea, the taste and the next thing to try.</p></div>
  <nav class="crafts" aria-label="Choose a craft">${nav}</nav>
  <div id="experiences">${articles}</div>
  <noscript><p class="no-script">All eight experiences are shown below. Starting prompts can be selected and copied; open a Video file link to watch a recording.</p></noscript>
</main>
<footer><p>Eight experiences in this source checkout. <a href="../README.md#run-it">Get started with Harness</a> · <a href="try-hands-on.md">Run a native starter</a> · <a href="../README.md#domain-specific-harnesses-dsh">Browse all harnesses</a></p><p>Videos and images are recorded native sessions, authored separately from these suggested prompts. This guide runs locally without a service; media plays only when you choose it. Jev's demonstration uses offline practice answers.</p></footer>
</body></html>
`

const markdown = `<!-- Generated by store/tools/hands-on.mjs. Edit store/hands-on.json, not this file. -->
# Get your hands on it

The agent brings the tools of a craft. You bring the idea, the taste and the next thing to try.

[Interactive guide](hands-on.html) — open this HTML file from the checkout in a browser for the craft picker, copyable prompts and local video players. [Start a Harness project](../README.md#run-it).

These eight experiences are included in this source checkout. The recorded demos show separately authored projects; the prompts below are starting ideas for your own work. Jev's demo uses offline practice answers.

[Run a native starter](try-hands-on.md) to try the physics, music or circuit panes directly from this checkout with installed harness assets.

${experiences
  .map(
    (item) => `## ${item.name}: ${item.title}

${item.intro}

${item.video ? `[Watch the real session](${item.video}) · ` : ''}[See the pane](${item.poster}) · [Harness guide](${item.guide})

${item.scene}

**Start a ${item.name} project and give the agent a direction:**

> ${item.prompt}

${item.steps.map((step, index) => `${index + 1}. **${step.title}.** ${step.text}`).join('\n')}

**Yours to keep:** ${item.keeps}

**Continue from your kept work:**

> ${item.followup}

Keep the result in this project, or give the agent the path to your downloaded copy.

${item.note}
`
  )
  .join('\n')}
---

[Browse all harnesses](../README.md#domain-specific-harnesses-dsh). To update this guide, edit [store/hands-on.json](../store/hands-on.json), keep each starting prompt in its harness's store.json, and run \`node store/tools/hands-on.mjs\`. \`--check\` verifies generated files and all referenced local assets without installing or running a harness.
`

for (const [path, content] of [
  ['docs/hands-on.html', html],
  ['docs/hands-on.md', markdown]
]) {
  const full = resolve(root, path)
  if (check) {
    if (!existsSync(full) || readFileSync(full, 'utf8') !== content)
      throw Error(`${path} is stale; run node store/tools/hands-on.mjs`)
  } else writeFileSync(full, content)
}
console.log(
  `${check ? 'Checked' : 'Built'} ${experiences.length} hands-on experiences, matching prompts and local media.`
)
