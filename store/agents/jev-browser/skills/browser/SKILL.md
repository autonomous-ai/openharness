---
name: browser
description: Turn what a person wants off a website into a browse.json job, read what came back in results.csv, and sharpen the fields that came back thin.
---

# Craft: reading a website into a spreadsheet

The person points at a page. You write the job. A real Chrome walks the site and Jev answers, per
page, in one call. Every value in the spreadsheet is a piece of text that was really on the page,
because Jev only ever picks from what the reader found. It cannot write a value, so it cannot
invent one.

## The shape of a site

Almost every site worth reading has two page kinds, and the job assumes them:

```
a LIST page  →  links to each thing, and a link to the next list page
a THING page →  the details of one thing
```

Point `start` at the list. If you point it at one thing's page, that one row is collected and the
run ends. If the things have no page of their own (everything is on the list), say so to the person:
this harness collects one row per page, so a list-only site gives one row for the whole list.

## Writing the fields

A field is what to look for, in the words a person would use.

| What you want | Write |
|---|---|
| a value printed on the page | `{ "id": "rent", "name": "Rent", "ask": "the monthly rent" }` |
| a judgement about the thing | `{ "ask": "Does it allow pets?", "type": "yesno" }` |
| a place on your own scale | `{ "ask": "what condition it is in", "type": "score", "levels": ["needs work", "liveable", "newly done"] }` |

- **Say it as it appears.** "the pay or salary range" beats "compensation" if the page says Salary.
- **One value per field.** If the page prints "Acme · Leeds · £45,000" the reader offers that line
  and each of its parts, so `company`, `place` and `salary` can each take their own part.
- **A value that is not on the thing's page cannot be collected.** Rating stars drawn as pictures,
  a price loaded after a click, a number inside an image: none of those are text. Check with the
  reader (see AGENTS.md, "Look before you write the job") before promising a column.
- **`yesno` is judgement, not text.** Use it for "is it remote?", not for "what is the salary?".
  `check.mjs` warns when a `pick` field reads like a question.

## Reading what came back

`results.csv`: one row per thing, every field with a confidence column. Then:

1. **Any column mostly empty?** The verdict marks it `thin`. Either the words are wrong, or the
   value is not on those pages. Open one page with the reader and look.
2. **Any column with low confidence?** Jev was choosing between two pieces of text. Read three of
   those rows: usually two parts of one line, and a sharper ask fixes it.
3. **Too few rows?** Look at the pane's link panel. If the real things scored under 0.5, `item` is
   too vague: "a job posting" works, "an entry" does not. If it ran out, raise `maxItems`.
4. **Rows that are not things?** A menu page scored over 0.5. Make `item` more specific, and say
   what it is not: `"item": "a flat for rent, not a neighbourhood guide"`.

Only then report. Count from the file with a script, never by eye.

## What it costs and how long it takes

One call per page. A list page with 120 links is about 122 questions in that one call; a thing's
page is one question per field. Measured on 2026-09-20 with live Jev through OpenRouter: 24 things
off a 36-item board took 33 s and $0.0023, and every one of the 144 cells matched the site's own
data. The time is page loads, not Jev: expect about a second and a half a page.

## The dial that is real

Turn `maxItems` up and nothing gets worse; the tool is not fighting a budget. The honest limit is
the **page**. A site that prints its values as text reads perfectly. A site that draws them, hides
them behind a click, or loads them after a scroll gives blanks, and the blanks show up as a thin
column rather than as a wrong answer. That is the tool telling the truth: it would rather leave a
cell empty than write something the page never said.

## Never

- Never go around a login wall, a block, a rate limit or a robots rule. Never ask for a password.
- Never present the offline stand-in's rows as Jev's judgement.
- Never retype a value from the page into the chat as if it were collected: run the job.
