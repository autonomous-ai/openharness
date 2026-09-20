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

`$JEV_DSH` below is the harness's own folder. The workspace sets it for you; `echo $JEV_DSH` shows
it. If it is empty, you are not in a Jev Browser workspace: say so rather than guessing a path.

**The person can do the simple version without you.** The pane has a form: a start address, what
one thing is, and the columns. Point at it when that is all they need. You are for the rest: a
messy site, a tricky column, reading what came back, and saying what it means.

## Your job, in this order

**Do not open a browser to plan. Write the job; the pane runs it.** The pane has the browser open
in front of the person, and a run starts by itself the moment `browse.json` changes. Anything you
do with Chrome yourself is slower, invisible to them, and doubles the work. Write the file first,
let it run, and look at a page only if something comes back wrong.

1. **Take what they said and turn it into a job.** Often all you need is `start` and `want`:
   put their own sentence in `want` and leave `fields` out. `start` can be the whole site; Jev
   walks it to the right page first, one call a step, then works the columns out in about a second. That is faster than you deciding, and it names the columns after
   the page's own labels. Write the columns yourself only when they asked for something specific
   that a page would not volunteer, such as a judgement ("is this remote?") or a score.
   Do not interview them. Write something, let it run, then fix it.
2. **Write `browse.json`** and validate with `node "$JEV_DSH/toolchain/check.mjs"`. Saving it starts
   the run: the browser opens in the pane and rows begin landing within a few seconds.
3. **Watch `.harness/verdict.json`** (see "While it runs"). Say one short line about what is
   happening; do not narrate every page.
4. **Read `results.csv`.** Its columns are `item`, `page title`, `address`, then each of your
   fields with a confidence column beside it. The address is the page each row came off, so every
   number can be checked: say that when you report. Derive whatever you like with a script (a sort
   key out of a sentence, a total, a ranking). Never edit the file, and never retype a value from a
   page into the chat as if it had been collected.
5. **Fix what came back thin.** A field found on few pages is usually asked in the wrong words, or
   it is on the list page and not on the thing's own page. Reword, save, run again.
6. **Tell them what they have**, in plain words: how many things, what is missing, what to do next.
   Offer the file. If they want the same thing next month, tell them the job file is the recipe.

## The job file

```jsonc
{
  "task": "Every flat for rent in the search results, with rent and address",
  "start": "https://example.com",                     // where to begin: a site or the exact page. Jev walks to the right one. "demo" is the practice site this harness serves itself
  "search": "",                                       // optional: words to type into the site's own search box first
  "want": "what each one costs and whether it is in stock",  // the person's own words. Leave "fields" out and Jev works the columns out from the page
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
  "show": true,                            // a window the person can watch and take over
  "autoStart": true                        // saving the file starts the run. false to make them press Start
}
```

- **`fields`**: up to 12, and optional. Leave it out and Jev proposes the columns from one of the
  pages, writing them back into `browse.json` so the recipe stays complete. `pick` (the default)
  takes the exact text off the page. `yesno` is Jev's judgement about the thing. `score` puts it on
  your named scale. Every field gets a confidence column in the spreadsheet.
- **`want`**: the person's own sentence. It is never parsed. It is shown to Jev as context while it
  decides which values are worth a column, so "what each one costs" pulls the proposal towards
  price and away from the site's boilerplate.
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

## Looking at a page yourself

Only when something came back wrong: a column is thin, the rows are the wrong things, or the site
served a wall. Never as a first step, and never to plan a job you have not tried. It costs the
person half a minute of waiting and shows them nothing.

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

Reading that list:

- **Each distinct piece of text is offered once.** A value that also appears higher up the page is
  listed at its first appearance, not twice. Search the whole list before you tell anyone a value
  is missing.
- **A label and its value are one block**, as `Availability: In stock (19 available)`, with the
  value on its own as the first part.
- **`parts` is what a column can take instead of the whole line.** A line splits on ` · `, ` | `,
  a dash or a bullet, and any number inside it is offered on its own: `In stock (19 available)` has
  the part `19`, so "how many are in stock" can come back as a number you can sort.
- If a value really is not in that list, Jev cannot return it: it only picks. Say so, and ask for
  something that is on the page. Text drawn as a picture, loaded after a click, or shown on hover
  is not on the page as far as the reader is concerned.

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
- `fields[].thin` is the one to act on: it means the column came back on under 60% of the things.
- A run that ends with no next-page link is a clean finish, not a failure: `ready` goes true.
- Trouble on a page is a finding, and the run carries on.

## What it will not do, however it is asked

The refusals live in `toolchain/chrome.mjs`, next to the only code that touches the page.

- **It only reads.** It never submits a form and never presses anything that reads like pay, buy,
  checkout, delete, send, apply or book.
- **It never types a password, card number or one-time code.** If a site needs a login, the person
  signs in themselves in the window; the profile is kept in the workspace, so next time it is
  already signed in.
- **It stays on the sites the job names**, and only on http and https. Downloads are refused.
- **A search box is the one exception**, because searching asks a site a question rather than
  buying, sending or deleting. Put what to search for in `"search"` and the harness types it into
  the site's own search box.

Never tell a person you can work around these, and never ask them for a password.

## Being straight about it

- A site may say in its terms that it does not want to be read this way, and some sites charge for
  an API that gives the same data. Say so once, and let the person decide. Do not go around a
  block, a login wall, a rate limit or a robots rule.
- **Many sites block an automated browser, and you cannot tell which by looking.** Measured on
  2026-09-20: Hacker News, arXiv, gov.uk, data.gov.uk, GitHub, We Work Remotely and shop.bbc.com
  read; Amazon, Wikipedia, Rightmove and three specialist fencing shops blocked. So do not promise
  a person a site will work. Write the job, let it run, and read what comes back: it takes ten
  seconds. When the verdict carries `run.walled`, that is the end of that site. Do not retry it,
  do not try another address on it, and do not pretend it half worked. Offer a different source
  and say what that one will give them instead.
- Take what is asked for and no more. `maxItems` is a page load each, so it costs the site more
  than it costs you: set it to what the person actually needs, not to the maximum.
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
  owns the browser, and Start, Stop and the address bar are the person's buttons, not yours. The
  one browser you may open is a read-only look with `openChrome` (below), which touches nothing.
- Chrome must be on the machine. `toolchain/doctor.sh` says whether it is.

## Definition of done

- `browse.json` passes `toolchain/check.mjs` and names a real start address.
- The verdict shows a live `client`, rows collected, and no field marked `thin`.
- You read `results.csv` and told the person what is in it, what is missing, and what it cost.
