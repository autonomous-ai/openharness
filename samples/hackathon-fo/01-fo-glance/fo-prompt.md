# What to tell Fo so the glance screen shows up

The round device only reads the turn's **recap**, which the daemon cuts from the **opening** of Fo's answer
(`deriveTurnSummary` in `cli/src/lib/deviceRecap.ts`, called from `cli/src/core/agents/cloud.ts`). So the glance line
must be the **first line** of the answer. If it's at the end, it gets cut off and the device shows the normal recap.

Tested with `deriveTurnSummary` itself:

| Fo's answer starts with | Recap the device gets | Device draws |
|---|---|---|
| `GLANCE applied=5 replies=2 interviews=1 goal=10`, a blank line, then the text | `GLANCE applied=5 replies=2 interviews=1 goal=10 Today I sent…` | the glance screen |
| `**GLANCE applied=5 replies=2 goal=10**` (bold) | `GLANCE applied=5 replies=2 goal=10 Sent 5 applications.` (the `**` is dropped) | the glance screen |
| text first, `GLANCE …` at the end | `Sent 5 applications today.` | the normal recap |

The firmware reads `key=value` pairs up to the first word without an `=`, so text joined on after them is fine.

## Instructions (paste at the start of your conversation with Fo)

```text
From now on, every answer you give MUST start with exactly one glance line, then a blank line, then the content.

The glance line looks like this:
GLANCE applied=<number> replies=<number> interviews=<number> goal=<number>

Rules:
- Write the word GLANCE in capitals exactly, with no punctuation, no bold, and not in a code block.
- At most 4 key=value pairs, separated by one space. Keys use only lowercase letters a-z (at most 12), values are whole numbers 0..9999.
- applied = applications sent so far (if a company confirms it received N applications, count all N);
  replies = times a company or recruiter answered an application (a receipt confirmation is not a reply);
  interviews = interviews scheduled or proposed; goal = this week's application goal (default 10).
- Update the numbers every turn with what you know, even when nothing changed in that turn.

Your job: help me find a Senior Backend Engineer (Go) role in Ho Chi Minh City or remote. Today, find 5 matching job postings,
sum up each one in one line, and record that I applied to all 5.
```

Expected answer:

```text
GLANCE applied=5 replies=0 interviews=0 goal=10

I found 5 matching postings and recorded that you applied:
1. ...
```

On the device: the harness name on the upper curve, three numbers `5 / 0 / 0` labeled `applied / replies / interviews`,
an amber ring filled to 5/10 around the edge, and the line `5 / 10 applied` on the lower curve.

## Later turns

- "Company A just answered my email and set up an interview for Friday." → Fo's answer starts with
  `GLANCE applied=5 replies=1 interviews=1 goal=10`.
- "I applied to 3 more." → `GLANCE applied=8 replies=1 interviews=1 goal=10`.

Other keys work too, and the device shows them as written, for example `GLANCE pages=12 bugs=3 goal=40` for a
different task. With no `applied`, the ring counts the first number. With no `goal`, there's no ring.

## When the glance screen doesn't show up

- Fo adds text before the glance line ("Hi there! GLANCE …"): remind it that "the FIRST line must be GLANCE".
- A number is over 9999, a key has uppercase letters, underscores or accents (`Applied`, `applied_today`), or there are
  more than 4 pairs: the device shows the normal recap. That's the intended behavior: a malformed line never turns into
  wrong numbers.
