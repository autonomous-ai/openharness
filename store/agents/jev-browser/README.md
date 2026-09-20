# Jev Browser

**Point it at a web page. Get a spreadsheet.** Type an address, say what one "thing" on it is, and
list the columns you want. A real Chrome opens, walks the site, and writes `results.csv` while you
watch. No code, no selectors, no copy and paste.

## How you use it

The pane asks you three questions and then goes. There is nothing to press afterwards.

| | |
|---|---|
| **Start on** | `books.toscrape.com/catalogue/category/books/travel_2/index.html` |
| **Search for** | leave it empty, or put words to type into the site's own search box |
| **Each one is** | `a book for sale` |
| **Columns** | `the title` · `the price` · `how many copies are available` · `Is it in stock?` |

Press **Go**. The browser opens, the rows land, and `results.csv` is in your project folder. A line
that reads like a question ("Is it in stock?") becomes a yes-or-no column; everything else is taken
off the page word for word.

The agent on the right is for the rest: a site that fights back, a column that comes back empty,
and reading what you collected. You do not need it to run a job. Ask it in plain words and it
writes the same job file the form does, and that starts on its own too.

**Every value is text taken off the page.** Jev, TypeSafe's System One model, never writes words. It
is shown the numbered pieces of text that really are on the page and it picks one. So a cell holds
the page's own words, or it holds nothing. A made-up price is not possible, because there is nothing
to make one out of.

This is a harness for OpenHarness. The pane on the left is the browser and the spreadsheet. The
agent on the right writes the job with you, reads the results, and sharpens what came back thin.

## One call per page

That single call to Jev holds everything worth asking about the page.

- **On a list page**: what kind of page it is, **one yes-or-no for every link on it**, and which
  link is the next page. 120 links is 122 typed questions, answered together, each with its own
  probability. In the picture above, the twelve real roles came back at 76 to 88 per cent and the
  menu links at 2 per cent.
- **On one thing's page**: every field at once, each a choice over the page's own text.

Many questions about one page cost about the same as one, so this is the cheap way round.

## What it will not do

The refusals sit next to the only code that can touch a page, so nothing above them can go around.

- **It only reads.** It never submits a form, and never presses anything that reads like pay, buy,
  checkout, delete, send, apply or book.
- **It never types a password, a card number or a one-time code.** If a site needs a login, you sign
  in yourself in the window. The profile is kept in your project folder, so the next run is already
  signed in.
- **It stays on the sites your job names**, on http and https only, and downloads are refused.
- **A search box is the one control it will ever use**, because searching asks a site a question
  rather than buying, sending or deleting anything.

Some sites say in their terms that they do not want to be read this way, and some sell an API for
the same data. That is your call to make, and the harness will not go around a block or a login.

## Try it in ten seconds

Press **Try the practice site**. The harness serves its own small job board on your machine, with
real HTTP, real links, real pagination and a real browser. Only the content of that site is made
up. It even has a search box, so you can try the "search for" line on it.

## The job, which is also the recipe

```jsonc
{
  "task": "Every flat for rent in the search results, with rent and address",
  "start": "https://example.com/search?area=leeds",
  "item": "a flat for rent",
  "fields": [
    { "id": "address", "name": "Address", "ask": "the street address" },
    { "id": "rent", "name": "Rent", "ask": "the monthly rent" },
    { "id": "garden", "name": "Garden?", "ask": "Does it have a garden?", "type": "yesno" }
  ],
  "maxItems": 60,
  "maxPages": 25
}
```

Run it again next month and you get next month's answer. That file is the whole recipe. Saving it
starts a run, so the agent writing it for you has the same effect as pressing Go. Set
`"autoStart": false` if you would rather press the button yourself.

## What you get

- **`results.csv`** in your project folder: one row per thing, every column with the confidence Jev
  had in it, and the address of the page it came off. Every number in your spreadsheet can be
  checked against the page that produced it. Download it from the pane or open it from the folder.
- The agent on the right will count it, tell you what is missing, and sharpen the weak columns.

## Measured

On 2026-09-20 with live Jev (`typesafe/jev-1.13`) through OpenRouter.

| Run | Things | Time | Cost | Result |
|---|---|---|---|---|
| The built-in job board, 36 roles | 24 | 33 s | $0.0023 | 144 of 144 cells exactly matched the site's own data, no repeats, nothing skipped |
| `books.toscrape.com`, a public sandbox | 8 | 21 s | $0.0018 | every title, price, stock count and UPC code right |

The product codes matter: `a22124811bfa8350` is not something a model could write from memory. It
came off the page, which is the whole point. Small runs are a sanity check, not a benchmark.

## Without a key

The pane runs on an offline stand-in that matches words. It shows the plumbing and it is honest
about being a stand-in, but its rows are not worth acting on. Paste an OpenRouter or TypeSafe key
into the **Jev · live mind** panel in the pane. It is saved on your machine in
`~/.config/typesafe/credentials` and checked with one tiny call.

## When a site says no

Big shops, marketplaces and social sites mostly block an automated browser. What comes back is a
wall: "Sorry, something went wrong", a captcha, or a near-empty page. The harness recognises that,
says which site did it, and stops. It will not work around a block, and neither should the agent.

A specialist shop, a maker's own site or a public dataset usually reads perfectly, and its pages
often print the fields a marketplace hides.

## The honest limit

The limit is the page, not the model. A site that prints its values as text reads perfectly. A site
that draws them as pictures, hides them behind a click, or loads them on scroll gives blank cells.
Those show up as an empty column that the verdict marks thin, not as a wrong answer. The tool would
rather leave a cell empty than write something the page never said.

## Anatomy

```
jev-browser/
  harness.json               DSH manifest (engine: claude)
  AGENTS.md                  the agent's job: write browse.json, read results.csv, sharpen
  skills/browser/SKILL.md    the craft of fields, and what a page can and cannot give
  template/browse.json       the starter job, pointed at the built-in board
  toolchain/
    chrome.mjs               drives a real Chrome over the DevTools protocol, and holds every refusal
    jev.mjs                  the Jev client (TypeSafe, Cloudflare or OpenRouter, or the stand-in)
    check.mjs                validates browse.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs               the server: the job, the browser, the run, results.csv, the verdict
    page.mjs                 reads a live page into numbered links and numbered text
    crawl.mjs                the loop and the questions
    demosite.mjs             the made-up job board served on this machine
    mock.mjs                 the offline stand-in
    kit.mjs index.html studio.css studio.js base.css jev-hud.js
  test/viewer.test.mjs
```

## Requirements

Google Chrome on the machine, and Node 22 or newer. `toolchain/doctor.sh` says whether both are
there. Set `CHROME_PATH` if Chrome lives somewhere unusual.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- The idea of a decision model picking the next browser action out of the page's own elements comes
  from the open-source browser agents the community built around Jev. This harness is an
  independent, from-scratch tool and uses none of their code.
- **Google Chrome** is Google's, and is not included: the harness drives whatever Chrome you have.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- Built by Autonomous for the OpenHarness store.
