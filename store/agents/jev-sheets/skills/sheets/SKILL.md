# Craft: Jev Sheets

Jev Sheets is a spreadsheet where a column header is a typed question and Jev answers it for every
row. The person brings a file they could never read in full. The craft is wording questions so the
answers are right and the confidence is honest, then turning the answers into findings a person can
act on. A made-up sheet is only the fallback when they have no file at hand.

## How one row is judged

For each row the viewer makes ONE call. The state is the row (its `text` plus plain fields like
`from` or `plan`). The questions are all the Jev columns, asked in parallel. Questions cannot see
each other, and nobody sees `truth` or `group`.

```
state      { "text": "You charged my card twice. Refund it today.", "plan": "pro" }
questions  urgent  noul    "Urgent?"
           team    choice  billing = payment or invoice problems | tech = bugs and outages | sales = ...
           anger   score   calm < annoyed < furious
answers    urgent  0.86    team  billing (0.84)    anger  annoyed (0.79)
```

Answers are cached by row text plus column definition. So after an edit to `sheet.json`, only the
cells that changed are asked again. Rewording one header refills one column.

## The header grammar

```
Urgent?                                          yes or no   (ends with ?)
Team: billing | tech | sales                     choice      (2 to 255 options)
Team: billing = invoices, refunds | tech = bugs  choice with meanings  (always prefer this)
Anger: calm < annoyed < furious                  score       (2 to 10 levels, lowest first)
Urgency                                          score       (bare word: low < medium < high)
```

In `sheet.json` a column is a header string or `{ "id": "team", "header": "Team: ..." }`. Use an
`id` whenever rows carry `truth`, so rewording the header does not orphan the labels.

## Working on the person's own file (the main job)

1. **Get it in.** They press Choose a file in the pane or paste rows, and `"source"` appears in
   `sheet.json` by itself. Or they give you a path: copy it into the workspace and set `"source"` (an Excel `.xlsx` works as it is: the first sheet is read). A PDF,
   a chat export or a folder of notes: convert it to a `.csv` or `.jsonl` in the workspace, one row
   per item, keeping a column that says where each row came from. Long documents: one row per
   paragraph or clause.
2. **Look.** Read the header and about twenty rows. Say in two lines what is in it. Set `context`
   to one sentence about what a row is, and `textColumn` if the guess was wrong.
3. **Aim at their decision.** If they already said what they want to know, do not ask again. If
   not, ask what they are trying to decide. Then write three to five questions aimed at that. Mix the
   types: one yes or no, one choice with a meaning for every option and an `other`, one score. The
   other columns are part of what Jev reads, so a question can lean on them ("Worth a call today?"
   can use a `seats` column).
4. **Check the save took, then read the answers.** In `.harness/verdict.json`, `sheet.loadedAt`
   moves within two seconds of a save, and the fill is done when `sheet.cellsFilled` equals
   `sheet.cellsTotal` (30 to 40 seconds for every 1,000 rows with a live key; `"client": "mock"` means
   no key, so stop and say so). `answers.csv` has a `row` number, the text, the file's own columns,
   and for each question the answer as a word plus `<Name> confidence`. There are no truth labels, so judge a question by how many cells sit under the review
   line and by reading the rows behind the numbers.
5. **Write `findings.md`.** What was asked and of how many rows. For each question the count and share
   of every answer. For each finding that matters, three to five word-for-word quotes with row
   numbers (lead with the answer in the first five lines). A cross-cut or two when it says something ("of the 212 crash reports, 61% also say they
   may leave"). What Jev was unsure about. The next question worth asking. Count with
   `node "$JEV_DSH/toolchain/count.mjs"` (counts, `--by a --and b` cross-cuts, `--where a=b --rows 10`
   to read the rows behind a number, `--unsure a`, `--find "words"`), never by eye.
6. **Sharpen and repeat.** Split a fat `other`. Reword a column whose answers sit near 50%: a yes
   or no about intent usually wants to become "says in words that…" or a three-way choice. Try the
   rewording on a few rows in **Question Lab** first, because a full pass can take most of a
   minute per 1,000 rows however few columns changed. The pane freezes rows/context, asks both
   versions together and lets the person keep preferences and notes alongside the raw answers.

Kept Question Lab packets live at `.harness/question-trials/<id>/`. Read `review.md` and the exact
rows, questions, probabilities and per-call provider/model in `trial.json`; `column.json` contains
the tested header. Keep human preferences separate from truth labels. This deliberate sample
cannot estimate whole-sheet accuracy, and greater confidence does not establish correctness.
`mock` answers are only a practice flow. Failed or cancelled trials retain their status and are
not complete comparisons. After the person chooses a wording, add it to the original
`sheet.json`; the pane's **Try on whole sheet** is a temporary extra column, like other pane-added
columns. Do not replace their source file with the packet's `sheet.json`: that file contains only
the frozen sample and belongs in a separate workspace if they want to rerun it.

Keep their data in the workspace. Quote only what the report needs.

## Building a made-up sheet (when they have no file)

1. Pick the unit of a row (a message, a review, an application, a bug report) and write `context`
   in one sentence.
2. Write 40 to 200 rows of made-up text, one to three sentences each. Vary length, tone and who is
   writing. Add one or two plain fields if they help (`from`, `plan`, `channel`, `stars`).
3. Write three to five columns. Mix the types: one yes or no, one choice, one score.
4. Label `truth` for the starter columns on every row. It is what lets the pane show accuracy.
5. Write a block of mixed-signal rows, about a quarter of the sheet, and mark them
   `"group": "mixed"`. Mark the rest `"group": "clear"`. Good mixed rows pull two ways at once:
   polite words with an angry point, "no rush" with an outage, a billing question inside a sales
   request.
6. Add six to ten `suggestions`: more headers a person could try on the same rows.
7. Run `node "$JEV_DSH/toolchain/check.mjs"`.

## Reading the verdict

The viewer writes `.harness/verdict.json`. Read `sheet.columns[]`:

```jsonc
{ "id": "team", "accuracy": 0.93, "labelled": 60, "underReviewLine": 11, "avgConfidence": 0.78,
  "weakest": [ { "row": "x56", "text": "Before we sign for 200 seats, legal needs...",
                 "answered": "tech", "confidence": 0.47, "truth": "sales" } ] }
```

and `sheet.groups` for the average confidence of clear rows against mixed rows.

- **Low accuracy on clear rows** means the question is unclear. Look at the weakest rows. Usually
  two options overlap, or an option has no meaning written down. Reword and save.
- **Many cells under the review line on clear rows** means the options are too close together, or a
  score has too many levels. Merge or rename them.
- **Mixed rows as confident as clear rows** means the mixed rows are not really mixed. Rewrite them
  so the two signals are about equally strong.
- **A confident wrong answer** is the most useful row in the sheet. Tell the person about it.

Change one column at a time, save, and read the verdict again. Report what moved.

## The offline mock

Without a Jev key, a local mock answers. On a person's own data it is not good enough to act on: the
pane says so, and the fix is a key pasted into the pane's live panel, never into the chat. It counts word cues: the words of the header, the
option names and their meanings, plus a small built-in list for common ideas (urgency, anger,
billing, bugs, sales, refunds, churn, sentiment, spam, security). It knows nothing else. On the
mock, a column only works if the rows use words that the option meanings also use. So write
meanings with the words a row would really contain. The pane badges the mock as MOCK, and its
accuracy says nothing about live Jev.

## Definition of done

On the person's own file: `sheet.json` passes `check.mjs`, `context` is set, every choice option has
a meaning, you read `answers.csv` and the rows behind the main numbers, and `findings.md` is written.

On a made-up sheet:

- `sheet.json` passes `check.mjs`.
- Made-up rows on the asked topic, with a mixed-signal block and truth labels.
- Every choice option has a meaning. Scores have clear, ordered levels.
- You read the verdict and reported: accuracy per column, cells under the review line, the average
  confidence of clear against mixed rows, and the next question you would sharpen.
