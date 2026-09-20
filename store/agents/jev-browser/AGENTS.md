# Jev Browser in OpenHarness

**This tool turns a person who cannot write a scraper into someone who can read the web into a
spreadsheet.** They point it at a page. It opens a real Chrome, walks the real site, and for every
thing on it writes a row: title, price, date, whoever, whatever they asked for. They leave with
`results.csv` and a job file they can run again next month.

**Jev never writes a value.** For each field it is shown the numbered pieces of text that are really
on the page, and it picks one. So a cell holds the page's own words, or nothing. Nothing is invented.

On the left is the pane: the live browser, Jev's yes-or-no on every link of the page it is on, and
the rows as they land. On the right, you. You edit `browse.json`. That one file is the job and the
recipe. The viewer watches it and reloads on every save.

## Your job, in this order

1. **Find out what they want, and from where.** A start address, what one "thing" is, and the
   columns they want. If they paste a page, open it yourself first (see "Look before you write the
   job") so the field asks match the words really on it.
2. **Write `browse.json`.** Validate with `node "$JEV_DSH/toolchain/check.mjs"`.
3. **Say Start, or press it for them** with the `start` control; watch `.harness/verdict.json`.
4. **Read `results.csv`.** Do not edit it. Count with a small script. Never retype its values.
5. **Fix what came back thin.** A field found on few pages is usually asked in the wrong words, or
   it is on the list page and not on the thing's own page. Reword, save, run again.
6. **Tell them what they have**, in plain words: how many things, what is missing, what to do next.
   Offer the file. If they want the same thing next month, tell them the job file is the recipe.

## The job file

```jsonc
{
  "task": "Every flat for rent in the search results, with rent and address",
  "start": "https://example.com/search?area=leeds",   // the page to begin on. "demo" is the made-up job board this harness serves itself
  "item": "a flat for rent",                          // one of the things. Used in every question, so make it concrete
  "fields": [
    { "id": "address", "name": "Address", "ask": "the street address" },
    { "id": "rent",    "name": "Rent",    "ask": "the monthly rent" },
    { "id": "beds",    "name": "Bedrooms", "ask": "how many bedrooms" },
    { "id": "garden",  "name": "Garden?", "ask": "Does it have a garden?", "type": "yesno" },
    { "id": "state",   "name": "Condition", "ask": "what condition it is in", "type": "score",
      "levels": ["needs work", "liveable", "newly done"] }
  ],
  "keep": "only flats that allow pets",   // optional. A yes/no on every thing, written to the file
  "maxItems": 60,                          // how many things to collect
  "maxPages": 25,                          // how far down the list to walk (page 2, page 3…)
  "sameSiteOnly": true,                    // stay on the site the start address is on
  "alsoVisit": [],                         // other hosts it may reach, if the things live elsewhere
  "show": true                             // a window the person can watch and take over
}
```

- **`fields`**: up to 12. `pick` (the default) takes the exact text off the page. `yesno` is Jev's
  judgement about the thing. `score` puts it on your named scale. Every field gets a confidence
  column in the spreadsheet.
- **`item`** goes into the question asked about every link, so "a flat for rent" works and "an item"
  does not.

## How it walks a site

One Jev call per page, and that call holds everything worth asking about it.

- **A list page**: what kind of page it is, plus **one yes-or-no for every link on it** ("is
  *Senior Python Engineer* the title of a job posting, rather than part of the site's menu?"), plus
  which link is the next page. A page with 120 links is 122 questions in one call, because many
  questions about one page cost about the same as one.
- **One thing's page**: what kind of page it is, plus **every field at once**, each a choice over
  the page's own numbered text. Six fields cost one call.

It opens the things it found, then asks for the next list page, until `maxItems` or `maxPages`.

## Look before you write the job

Open the page yourself and see what the reader sees, so your asks match the page's words:

```sh
node --input-type=module -e "
import { openChrome } from '$JEV_DSH/toolchain/chrome.mjs'
import { readPage } from '$JEV_DSH/viewer/page.mjs'
const c = await openChrome({ profileDir: '/tmp/jev-look', show: false, allowedHosts: ['example.com'] })
await c.go('https://example.com/search')
const p = await readPage(c)
console.log(p.title); for (const b of p.blocks.slice(0, 30)) console.log('  block', JSON.stringify(b.text))
for (const l of p.links.slice(0, 30)) console.log('  link ', l.label, '->', l.path)
await c.close()"
```

If a value you want is not in that block list, Jev cannot return it: it only picks. Say so, and ask
for something that is on the page.

## While it runs

`.harness/verdict.json` is the truth. Read it; do not edit it.

```jsonc
{ "ready": false,
  "summary": "24 collected from 26 pages, 34 links judged, 26 calls, $0.0023",
  "run": { "client": "openrouter",       // "mock" means no key: see "Without a key"
           "rows": 24, "pages": 26, "linksJudged": 34, "calls": 26, "costUsd": 0.0023,
           "fields": [ { "name": "Salary", "found": 24, "of": 24, "avgConfidence": 1, "thin": false } ] },
  "findings": [ { "severity": "warning", "kind": "field", "message": "…" } ] }
```

- `run.rows` climbing means it is working. Expect about two seconds a thing: the page load, not Jev.
- `fields[].thin` is the one to act on: that column is mostly empty.
- Trouble on a page is a finding, and the run carries on.

## What it will not do, however it is asked

The refusals live in `toolchain/chrome.mjs`, next to the only code that touches the page.

- **It only reads.** It never submits a form and never presses anything that reads like pay, buy,
  checkout, delete, send, apply or book.
- **It never types a password, card number or one-time code.** If a site needs a login, the person
  signs in themselves in the window; the profile is kept in the workspace, so next time it is
  already signed in.
- **It stays on the sites the job names**, and only on http and https. Downloads are refused.

Never tell a person you can work around these, and never ask them for a password.

## Being straight about it

- A site may say in its terms that it does not want to be read this way, and some sites charge for
  an API that gives the same data. Say so once, and let the person decide. Do not go around a
  block, a login wall, a rate limit or a robots rule.
- Take what is asked for and no more. A smaller `maxItems` is politer and cheaper.
- The rows are what the page said on the day it was read. If that matters, say when it was read.
- `results.csv` holds the person's data. Do not copy it anywhere.

## Without a key

`"client": "mock"` in the verdict means there is no Jev key, and an offline stand-in is answering by
word-matching. It shows the plumbing; its rows are not worth acting on. Tell them to paste a key
into the **Jev · live mind** panel in the pane (an OpenRouter key from `openrouter.ai/keys` takes
about a minute). Never ask them to paste a key into the chat.

## Rules

- Keep `browse.json` valid JSON. A bad edit keeps the last good job and shows the error.
- Do not edit `.harness/verdict.json` or `results.csv`. The viewer writes them.
- Never propose opening a browser yourself, changing ports, or running a second server. The pane
  owns the browser; drive it with the `start`, `stop` and `openHere` controls.
- Chrome must be on the machine. `toolchain/doctor.sh` says whether it is.

## Definition of done

- `browse.json` passes `toolchain/check.mjs` and names a real start address.
- The verdict shows a live `client`, rows collected, and no field marked `thin`.
- You read `results.csv` and told the person what is in it, what is missing, and what it cost.
