# Listening rubric

Seven criteria. A reviewer sees only this file and the evidence `ep review` wrote — never the
conversation that produced the episode. Each is a pass or a fail with one sentence of why.

The evidence is `work/review/REVIEW.md` and the six-second clips beside it: one around every
splice, one at every chapter start, the transcript of each moment, each chapter's own transcript
under its title, and the show notes as written.

| id | Criterion | A pass looks like |
|---|---|---|
| `splices` | Every cut sounds like a pause, not an edit | At each `splice-*` clip the join lands in silence or on a breath. No word is clipped, no breath is cut in half, no sentence restarts. |
| `voice` | The repair left the voice alone | No metallic or underwater quality, no pumping, no word endings swallowed by a gate, no sibilance turned to a lisp. |
| `balance` | Speakers sit together | On a multi-speaker episode no one is noticeably louder, closer or duller than anyone else. Music sits under speech and never fights it. |
| `chapters` | Each title describes its own chapter | Reading a title, then that chapter's transcript, the title is what that stretch is about — not the episode's subject, not the next chapter's. |
| `transcript` | The words match the audio where it matters | Names, numbers and quoted phrases in the transcript are what is said. Nothing is invented in a silence; nothing repeats three times. |
| `notes` | The show notes claim only what was said | Every statement in the notes can be traced to the transcript. No invented guest credential, no link that was not given, no claim about content the episode does not contain. |
| `opening` | The first fifteen seconds earn the next fifteen | Something happens: a line worth hearing, or music that resolves into one. Not dead air, not a fade into a mumble. |

## The answer

`.harness/review/result.json`:

```json
{
  "passed": true,
  "summary": "one line, what a listener would say",
  "criteria": [
    { "id": "splices", "passed": true, "note": "all four joins land in silence" },
    { "id": "voice", "passed": false, "note": "the guest sounds hollow after 00:30 — the denoiser is too strong" }
  ]
}
```

`passed` at the top is false if any criterion fails. The review is **advisory**: it never blocks
delivery on its own, because a model that has read a transcript has not heard the episode. It is
there so that what only ears can judge is at least asked about, and written down.
