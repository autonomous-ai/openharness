# Jev Sheets

![Jev Sheets logo](brand/logo.svg)

**Ask your spreadsheet anything, and get an answer for every row.** Drop in a pile of text you could
never read in full: 5,000 app reviews, a survey's free-text answers, a quarter of support tickets,
a list of leads. Type a question in plain words as a column header. Jev, TypeSafe's System One
model, answers it for every row in seconds, for cents, and says how sure it is of each answer.

It turns one person into a research team. Work that used to mean a week of reading and tagging by
hand, or a script and an afternoon, becomes a question you type.

This is a harness for OpenHarness. The pane on the left is the sheet. The agent on the right is your
analyst: it looks at your file, writes sharp questions with you, reads the answers and writes up the
findings.

## Bring your file

- **Choose a file.** The pane has its own chooser, because the Harness desktop pane is a web view
  that never opens the system file dialog. It lists your newest spreadsheets from Downloads, Desktop
  and Documents, lets you browse your home folder, and takes a pasted path like
  `~/Downloads/reviews.xlsx`. An Excel `.xlsx` file (its first sheet), or `.csv`, `.tsv`, `.json` or
  `.jsonl`, up to 32 MB and 10,000 rows. macOS may ask once whether Harness may read those folders.
- **Paste rows** copied from Excel or Google Sheets into the chooser's paste box.
- In an ordinary browser you can also drop a file on the page.
- **Tell the agent where it is.** It copies the file in. It can also turn a PDF, a chat export or a
  folder of notes into rows for you.

One column is the row's text (a column called `text`, `message`, `review`… or the longest one). The
other columns ride along as context, so "stars" or "plan" can inform an answer. The file is saved
in your project folder. Its rows go to the Jev API to be answered, and nowhere else.

The pane opens on a small made-up sample so there is something to try in the first ten seconds. It
is labelled as made up, and one click takes you back to it.

## Ask

| You type | It becomes |
|---|---|
| `Thinking of leaving?` | a yes or no question (`noul`). Ends with a question mark. |
| `Topic: sync \| price \| crash` | a `choice` of 2 to 255 options |
| `Topic: sync = notes not syncing \| price = cost or subscription` | the same, with a meaning for each option. This makes Jev sharper. |
| `Anger: calm < annoyed < furious` | a `score` on 2 to 10 ordered levels |
| `Urgency` | a bare word becomes a score: `low < medium < high` |

Press Enter and the column fills in a wave. Every question on the sheet is asked in one call per
row, so five questions cost about the same as one. Or ask the agent: "what should I be asking
this file?"

## Read the answers

- **Answers so far** counts every answer for every question. Click a count to see only those rows.
- Cells fade when Jev is less sure. A **?** marks a cell under the review line. Drag the line, or
  turn on "needs review only", to see the rows a person should look at.
- Click a cell to see the exact question Jev was asked and the full probabilities.
- Click a header to sort. Double-click a row to edit its text: it is judged again at once.

## Question Lab: try the wording before the whole sheet

Open **Question Lab** beside the sheet controls. Start with an existing question and write a
clearer version. Preview 10, 20 or 40 rows: a mix of low-confidence rows and rows spread across the
sheet, just the spread, or the first rows in your current filtered/sorted view. A selected sheet
cell can pin its row into the trial. The preview freezes the exact text, metadata and context.

**Compare** asks both versions again, together in one paired request per row through the normal
Jev client. Click any row to read its full text, both distributions and the exact questions. Filter
to changed answer labels, mark **Original**, **New wording** or **Unsure**, and leave a note about
what the wording captured or missed. These preferences are your review, not new truth labels.
Changing question types or answer labels is allowed; a different label does not establish a
better answer. The selected sample is not representative, and confidence is not accuracy.

![Question Lab comparing a fictional support row, explicitly in offline practice mode](../../../docs/images/question-lab.png)

[Watch the native 13-second walkthrough](../../../docs/images/question-lab-demo.mp4)
(original fictional rows, offline practice mode).

**Keep this trial** saves an immutable `.harness/question-trials/<id>/` packet. It contains the
frozen rows, exact wire questions, raw answers, per-call provider/model/usage, your notes,
`comparison.csv`, `review.md`, a reusable sample `sheet.json`, `column.json`, checksums and a ZIP.
The packet includes your sampled data; keep it where you would keep the original file. No API
keys are included. Reopen it from **Kept & open trials**, even after the source file is gone.

**Use on whole sheet** saves the candidate as a separate question in `sheet.json`, preserving the
original question and your data. It reuses trial answers when the connected route and requested
model still match, then fills the remaining rows. The chosen wording survives reset and viewer
restart; repeated clicks or reopening the kept trial do not add duplicate questions. New viewer
sessions ask the saved questions again rather than treating old answers as current.

If the rows, context or original question changed, start a new trial. A broken or conflicting
project edit leaves the current sheet and kept trial available for retry. Open trials last only
for the current viewer process; kept trials remain in the project.

One trial runs at a time, at most four row requests in flight. Cancellation stops further rows;
requests already in flight can finish, including the client's normal transient-error retries.
Failed and cancelled trials can be kept with their incomplete status. Limits: 40 rows, 4,000
characters per header, 512 KB for the frozen preview, 24 KB per paired response, 2 MB for the
saved result, eight open trials and 100 kept trials per workspace. Move older packets elsewhere
to make room. Without a key, every trial is prominently labeled **OFFLINE STAND-IN** and is only
for practicing the workflow. It provides no evidence about Jev's actual judgment quality.

## Take it away

- **`answers.csv`** holds every row, its own columns, and each answer with its confidence. Download
  it from the pane, or find it in the project folder. Cells that could run as a formula are escaped.
- **`findings.md`**: ask the agent for the findings. It leads with the answer, counts with the
  shipped `toolchain/count.mjs` (counts, cross-cuts, the rows behind a number), and quotes rows word
  for word with their row numbers.

## What it costs

Measured on 2026-09-20 with live Jev (`typesafe/jev-1.13`) through OpenRouter, on a made-up file of
1,200 app reviews dropped on the pane, with three questions asked together (a seven-way topic, "says
they may cancel or switch?" and an anger scale):

| rows | questions | time | cost | topic right, clear rows | topic right, above the review line |
|---|---|---|---|---|---|
| 1,200 | 3 | 36 s | $0.028 | 96.5% | 98.7% |

All 119 reviews that said "I am close to switching" were found. One run on made-up reviews is a
sanity check, not a benchmark. OpenRouter answers in about half a
second a call. The native TypeSafe API is several times faster.

## Tested cold

A fresh agent was given only this harness's `AGENTS.md` and skill, a workspace with the 1,200 made-up
reviews already dropped on the pane, and one sentence: "What are people complaining about most, who
is about to leave us and why, and what should we fix first?" In 16 minutes and $0.18 of Jev calls
it wrote five questions, reworded three of them after reading the unsure rows, and wrote findings
with counts, cross-cuts and quoted rows. It also noticed by itself that the made-up file glues
closing sentences onto reviews at random, and said so. The first cold run had failed outright, and
that is how the bugs it hit got fixed. The tool's weak spot stays a tone scale on evenly written
text: about a quarter of those cells remained unsure, and the findings said not to rank by it.

## A key

Real answers need a Jev key. Paste one into the **Jev · live mind** panel in the pane. An OpenRouter
key (`openrouter.ai/keys`) takes about a minute and has no waitlist. A TypeSafe key works too. The
key is checked with one tiny call and saved on your machine in `~/.config/typesafe/credentials`
(chmod 600). It is never shown again and never leaves the machine except to call the API.
Cloudflare Workers AI is a third route: see `toolchain/README.md`.

Without a key the pane runs on an offline stand-in that only matches words. It shows how the tool
works. It is not good enough for your own data, and the pane says so in a yellow bar. After you
connect, every cell is asked again, for real.

## Being honest

- Jev's confidence is real information. A column where most answers sit near 50% is a vague
  question, not a finding. Reword it.
- Read the rows behind a number before you act on it. One click on the count shows them.
- It finds, counts and sorts. It is not legal, medical, financial or hiring advice.
- The pane only accepts requests from itself: a web page on another site cannot upload a file, list
  your folders, press a control or set a key. The chooser stays inside your home folder, never enters
  a hidden folder such as `~/.ssh`, and reads nothing until you pick it.

## The sample, and the honest dial

The made-up sample is 60 inbound messages to Fernhill Cloud, a file sync company that does not
exist, with truth labels. 44 rows are clear and 16 carry mixed signals on purpose ("No rush at all,
but our production backups have been failing since Monday"). Nothing is randomised. The tests
measure, on the offline stand-in: clear rows 0.86 average confidence and 99% right, mixed rows 0.72
and 73% right, and 44% of mixed cells under the review line against 1.5% of clear ones. With live
Jev on the same 60 rows: Team 98%, Anger 90%, Urgent 85%, filled in 5.4 s for $0.0013. So the review
line catches the rows a person should look at.

## Anatomy

```
jev-sheets/
  harness.json               DSH manifest (engine: claude)
  AGENTS.md                  the agent's job: get the file in, ask sharp questions, write the findings
  skills/sheets/SKILL.md     the craft of questions, review and the report
  template/sheet.json        the made-up sample (60 messages, 3 Jev columns, truth labels)
  toolchain/
    jev.mjs                  the Jev client (TypeSafe, Cloudflare or OpenRouter, or the offline stand-in)
    check.mjs                validates sheet.json
    count.mjs                counts answers.csv: every answer, cross-cuts, the rows behind a number
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs               the server: the sheet, uploads, the call pool, the cache, answers.csv, the verdict
    picker.mjs               the pane's own file chooser: recent files, folders, open by path, home folder only
    source.mjs               reads the person's file: Excel, CSV, TSV, JSON, JSONL
    xlsx.mjs                 a small Excel reader: zip directory, shared strings, the first sheet
    grammar.mjs              the header parser, shared with the pane and check.mjs
    questions.mjs            one question builder for the sheet and Question Lab
    question-lab.mjs         bounded paired trials, row review and immutable portable packets
    question-lab-ui.mjs question-lab.css trial-zip.mjs    the comparison pane and archive writer
    mock.mjs                 the offline stand-in (reads only the row text and the question)
    kit.mjs                  loopback server, same-origin guard, upload, download, key connect, SSE
    index.html studio.css studio.js base.css jev-hud.js     the pane
  test/*.test.mjs            server, import/export, grammar and Question Lab regression checks
  test/question-lab-browser.mjs    native Chrome acceptance journeys with explicit offline data
```

## How it runs

`viewer/viewer.mjs` serves the pane on a loopback port and watches `sheet.json` and the source file.
For each row with a missing cell it sends one `evaluate()` call: the row is the state, and every
missing Jev column is a question. Up to 32 calls run at a time. Answers are cached by row text plus
column definition, so a new column asks only for that column, an edited row asks only for that row,
and new rows ask only for themselves. A bad JSON edit keeps the last good sheet on screen and shows
the error. The viewer writes `answers.csv` and `.harness/verdict.json` itself. The agent reads both.

Run `JEV_OFFLINE=1 node --test test/*.test.mjs` for the package checks. For the real-browser trial
journeys, run `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/question-lab-browser.mjs`.
It imports an original fictional CSV, uses the actual viewer and client in explicit offline mode,
and verifies review editing, archive retries/downloads, source changes, restart and a 390px view.
The HTTP client test uses a local protocol fixture with a dummy key. Neither check validates live
Jev accuracy or performance. The browser check requires Chrome; set `CHROME` to its executable
path on a nonstandard installation. Its `EVIDENCE` directory contains screenshots and results.

## Logo and icon

The original identity ships in `brand/`: [vector icon](brand/icon.svg), [256px PNG](brand/icon.png),
[light logo](brand/logo.svg) and [dark logo](brand/logo-dark.svg). MIT, by Autonomous.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.
