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

- **Drop it on the pane.** A `.csv`, `.tsv`, `.json` or `.jsonl` file, up to 32 MB and 10,000 rows.
- **Paste rows** copied from Excel or Google Sheets, anywhere on the pane.
- **Tell the agent where it is.** It copies the file in. It can also convert an `.xlsx`, a PDF or a
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

## Take it away

- **`answers.csv`** holds every row, its own columns, and each answer with its confidence. Download
  it from the pane, or find it in the project folder. Cells that could run as a formula are escaped.
- **`report.md`**: ask the agent for the findings. It counts from `answers.csv`, opens the rows
  behind each number, and quotes them word for word.

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
- The pane only accepts requests from itself: a web page on another site cannot upload a file, press
  a control or set a key.

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
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs               the server: the sheet, uploads, the call pool, the cache, answers.csv, the verdict
    source.mjs               reads the person's file: CSV, TSV, JSON, JSONL
    grammar.mjs              the header parser, shared with the pane and check.mjs
    mock.mjs                 the offline stand-in (reads only the row text and the question)
    kit.mjs                  loopback server, same-origin guard, upload, download, key connect, SSE
    index.html studio.css studio.js base.css jev-hud.js     the pane
  test/viewer.test.mjs test/own-file.test.mjs
```

## How it runs

`viewer/viewer.mjs` serves the pane on a loopback port and watches `sheet.json` and the source file.
For each row with a missing cell it sends one `evaluate()` call: the row is the state, and every
missing Jev column is a question. Up to 32 calls run at a time. Answers are cached by row text plus
column definition, so a new column asks only for that column, an edited row asks only for that row,
and new rows ask only for themselves. A bad JSON edit keeps the last good sheet on screen and shows
the error. The viewer writes `answers.csv` and `.harness/verdict.json` itself. The agent reads both.

## Logo and icon

The original identity ships in `brand/`: [vector icon](brand/icon.svg), [256px PNG](brand/icon.png),
[light logo](brand/logo.svg) and [dark logo](brand/logo-dark.svg). MIT, by Autonomous.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.
