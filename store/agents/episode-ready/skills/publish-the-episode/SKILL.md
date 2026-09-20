---
name: publish-the-episode
description: Everything after the master — chapters that players can seek to, a transcript with the right names in it, show notes written from what was actually said, artwork and metadata the platforms accept, and the encoded files plus RSS item to upload. Read this once the loudness is on target.
---

# Publish the episode

Every command here was run against this package's pinned toolchain. This half is where an episode
stops being audio and becomes something a host will take.

## Order

Chapters → transcript → show notes → deliver → check. Chapters first because they are quick and
the pane shows them at once; the transcript takes about a seventh of the running time; the notes
are written **from** the transcript.

## 1. Chapters

Chapters go in `episode.json` in **output** time (the finished episode, after the cuts):

```json
"chapters": [
  { "start": 0,    "title": "Cold open" },
  { "start": 15.1, "title": "The supply chain, not the electronics" },
  { "start": 27.4, "title": "A lunchbox and forty centimetres of wire" }
]
```

`url` and `img` are optional per chapter and travel into the Podcasting 2.0 JSON.

The rules `ep check` enforces, and why:

- **The first starts at 0.** A gap before chapter one shows as untitled time in every player.
- **Nothing under 10 seconds.** Players cannot seek to it; it is clutter in the chapter menu.
- **Monotonic, all inside the episode.** Obvious, and easy to break after a re-cut.
- **A title describes its own chapter**, not the episode. "What broke in year two", not "Part 2".
  Six words is plenty; players cut off around 40 characters in a car.
- **No two the same.**

**Place them on a sentence, not on a round number.** After transcribing, take the `start` of the
segment nearest where you want the chapter — a chapter that begins two words into a sentence
sounds broken. If you are chaptering before transcribing, use the gaps: `removed` in
`episode.json` tells you where the pauses were.

**After a re-cut, chapter times move.** Re-read the transcript and put them back on their
sentences; do not assume the old numbers still land.

## 2. Transcript

```bash
"$EPISODE_TOOLCHAIN/ep" transcribe
"$EPISODE_TOOLCHAIN/ep" transcribe --model small.en        # slower, better on accents and jargon
"$EPISODE_TOOLCHAIN/ep" transcribe --language auto         # a non-English episode
```

It transcribes **the master**, so the times line up with the published file, and writes
`transcript.json` with word-level times.

**Set the vocabulary first.** It becomes Whisper's `initial_prompt` and it is the single biggest
thing that decides whether proper nouns come out right:

```bash
"$EPISODE_TOOLCHAIN/ep" set transcript.vocabulary='["Mara Oyelaran","nucleo","Shipping Notes"]'
```

Measured: with the guest's name in the vocabulary, "Mara Oyelaran" came out letter-perfect on a
recording where it is otherwise mangled. It is not magic — "nucleo board" still came back as
"nuclear board" — so fix the rest:

```bash
"$EPISODE_TOOLCHAIN/ep" fix "nuclear board=nucleo board"
```

`ep fix` corrects the cue text and the word times under it everywhere at once, and remembers the
correction in the vocabulary so a re-transcribe does not undo it.

**The person can correct a word in the pane too**, and that writes `transcript.json` directly.
Never overwrite their corrections by re-transcribing without putting them back.

Models, all pinned by commit and fetched on first use:

| `--model` | Size | Speed on CPU | Use it |
|---|---|---|---|
| `base.en` | 148 MB, installed | ~7× realtime | the default; clean English speech |
| `small.en` | 486 MB | ~2.5× realtime | accents, jargon, a noisy recording |
| `medium.en` | 1.5 GB | slow | only when `small.en` is still wrong |
| `large-v3-turbo` | ~1.6 GB | slow | the best available; multilingual |
| `small`, `base`, `large-v3` | — | — | non-English (with `--language`) |

A 45-minute episode is about 6 minutes on `base.en` and 18 on `small.en`. Tell the person before
you start, and the pane's header will say so too.

Whisper invents text over silence. Vad filtering and a hallucination threshold are on by default,
and `ep check` flags a line that repeats three times or a cue over 8 seconds — both are the
signature of it. If you see it, cut the silence properly and transcribe again.

## 3. Show notes

Write `shownotes.md` by hand, from the transcript. This is not a summarising exercise you can do
from the brief: **everything in the notes must be something that was actually said.** A claim the
episode does not make is the worst thing this harness can produce.

A shape that works:

```markdown
# What broke in year two

Mara Oyelaran took a battery sensor from a breadboard on a lunchbox to twenty thousand units in
the field. In this episode she explains why the electronics were never the hard part, what the
first prototype actually looked like, and how she found out her second supplier had gone under —
from a courier.

## Chapters

- **00:00** — Cold open
- **00:15** — The supply chain, not the electronics
- **00:27** — A lunchbox and forty centimetres of wire

## Links

- [Shipping Notes](https://shippingnotes.example)
```

- **Two or three sentences of summary first.** Most apps truncate at 120–150 characters, so the
  first sentence has to stand alone and say why someone should press play.
- **Timestamps must match chapter starts.** `ep check` resolves every `MM:SS` in the file against
  the chapters and warns on one that matches nothing.
- **Aim past 60 words.** Under that there is nothing for a reader or a search engine.
- `summary` in `episode.json` is the separate short version for `itunes:summary`, limit **4000
  characters**; every other RSS tag is limited to 255.
- Only links the person gave you or that were named in the episode. Never invent a URL.

## 4. Artwork

Put it in `art/`; intake picks up the first image. Apple wants square, RGB, **1400–3000 px**, and
the feed copy under **512 KB**. `ep deliver` writes `dist/cover-3000.jpg` and `dist/cover-1400.jpg`
(dropping quality until the small one fits) and embeds the 1400 in the audio. `ep check` fails a
cover that is not square or is under 1400.

If the person has no artwork, say so and carry on — the episode inherits the show's cover. Do not
invent a logo for their show.

## 5. Deliver

```bash
"$EPISODE_TOOLCHAIN/ep" deliver
```

`output.formats` in `episode.json` decides what is written; the default is `["mp3","m4a","wav"]`.

```
ok   dist/what-broke-in-year-two.mp3                 522 KB  MP3 for the feed — chapters and cover embedded
ok   dist/what-broke-in-year-two.m4a                 531 KB  AAC in MP4 — Apple Podcasts, Overcast
ok   dist/what-broke-in-year-two-master.wav         5.50 MB  24-bit master — open it in any editor
ok   dist/what-broke-in-year-two.vtt                   1 KB  transcript — podcast:transcript
ok   dist/what-broke-in-year-two.srt                   1 KB  transcript — podcast:transcript
ok   dist/what-broke-in-year-two.txt                   1 KB  transcript — podcast:transcript
ok   dist/what-broke-in-year-two.transcript.json       1 KB  transcript — podcast:transcript
ok   dist/chapters.json                                1 KB  Podcasting 2.0 chapters — podcast:chapters
ok   dist/shownotes.html                               1 KB  show notes — the episode description
ok   dist/cover-3000.jpg                              92 KB  artwork 3000×3000 RGB JPEG
ok   dist/cover-1400.jpg                              27 KB  artwork 1400×1400 RGB JPEG
ok   dist/episode-item.xml                             2 KB  an <item> to paste into your feed
```

What is in each one:

- **MP3** — ID3v2.3 with real `CHAP` + `CTOC` chapter frames and an `APIC` cover, so chapters show
  in Apple Podcasts, Overcast and Pocket Casts without a side-car. `ep check` reads the raw tag to
  confirm the frames are there, not just that ffprobe can see chapters.
- **M4A** — AAC with MP4 chapters and `+faststart`.
- **`-master.wav`** — 44.1 kHz 24-bit, for an editor. It carries no chapters or tags and is not
  checked for them.
- **`.vtt` / `.srt` / `.txt` / `.transcript.json`** — all four are legal `podcast:transcript`
  types. The `.txt` is the readable one, with the chapter headings in place, for the episode page.
- **`chapters.json`** — Podlove Simple Chapters, the `application/json+chapters` that
  `podcast:chapters` points at.
- **`episode-item.xml`** — an `<item>` with the `itunes:` and `podcast:` tags filled in, the
  enclosure length set to the real byte count, and a comment saying which namespaces the feed
  needs. Set `link` in `episode.json` to your hosting URL and the URLs come out right; leave it
  empty and they say `example.com` for you to replace.
- **`report.md`** — the measurements, so the person can show a host their episode is in spec.

Bitrates: `output.mp3Kbps` / `output.aacKbps`, default 96. Apple's RSS table is 64–128 kbps for
mono, 128–256 for stereo, at 44.1 or 48 kHz; `ep check` warns outside it. Speech is mono unless
the person recorded in stereo on purpose — set `output.channels: 2` if they did.

## 6. Check, and mean it

```bash
"$EPISODE_TOOLCHAIN/ep" check          # writes the verdict the pane header reads
"$EPISODE_TOOLCHAIN/ep" check --json   # the findings, for you to work through
"$EPISODE_TOOLCHAIN/ep" check --quick  # skips the sample-level passes
```

It exits non-zero when there is an error. `ready` in the verdict — and *ready to publish* in the
header — means no errors **and** files in `dist/`.

Common findings and what they actually mean:

| Finding | What to do |
|---|---|
| `loudness_off_target` | do not nudge the target to match the output; find why the mix is wrong |
| `true_peak` | the ceiling was exceeded; something bypassed the limiter, usually a loud music cue |
| `chapter_too_short` | merge it into its neighbour or move its start |
| `chapters_not_embedded` | `ep deliver` was not re-run after the chapters changed |
| `no_id3_chapters` | the MP3 is stale; re-deliver |
| `transcript_past_end` | the transcript is from before the last re-cut; transcribe again |
| `shownotes_timestamp` | a timestamp in the notes matches no chapter; one of the two is wrong |
| `noise_floor` | see `produce-an-episode`: denoise plus a gate on the noisy source |
| `duration_claim` / `chapter_claim` | `requires` in `episode.json` says the person asked for something else |

### Holding yourself to the brief

When the person asks for something measurable, write it into `episode.json` and let the check hold
you to it rather than trusting yourself to remember:

```json
"requires": {
  "durationSeconds": 1500,
  "chapters": 6,
  "files": ["*.srt", "chapters.json"]
}
```

## 7. The part no measurement reaches

Whether the episode is worth listening to, whether a chapter title is honest about its chapter,
whether the show notes claim something that was never said, and whether the repair took the life
out of a voice.

```bash
"$EPISODE_TOOLCHAIN/ep" review
```

writes `work/review/REVIEW.md` and a six-second clip around every splice and every chapter start,
with the transcript of each moment, each chapter's own transcript under its title, the show notes
to read against them, and a table you would otherwise have to derive by hand:

```
| from  | to    | note               | speech level | presence − body |
| 00:24 | 00:32 | panellist          | -16 dB       | -9.6 dB         |
| 00:32 | 00:41 | distant panellist  | -16 dB       | -15.5 dB        |
```

**Presence is 3–10 kHz against 300–1000 Hz**, and it is how you tell a microphone that is further
away from one that is merely quieter. A speaker matched in level but 6 dB down in presence still
sounds across the room — level matching cannot fix it, and only this shows it. Applause and music
read bright; compare the speech stretches with each other.

**Then have it judged by someone who has not been in this conversation.** A reviewer who watched
you make the episode will agree with you about it.

1. Read `review-rubric.md` beside this skill. It is seven criteria with what a pass looks like.
2. Start a reviewer with a fresh context that can see only the rubric and `work/review/`:
   - **Claude Code** — a subagent (the Task/Agent tool), prompt: *"Read
     `skills/publish-the-episode/review-rubric.md` and `work/review/REVIEW.md` with the clips
     beside it. Judge each criterion. Write `.harness/review/result.json` in the shape the rubric
     gives. You have not seen how this episode was made; say what the evidence shows."*
   - **Codex, or any engine without subagents** — the same prompt through its non-interactive
     mode in a clean session (`codex exec "…"`, `claude -p "…"`).
   - **No second session available** — read the rubric and the evidence yourself in one pass, and
     say in the result that it was not a fresh reader.
3. `ep check` folds `.harness/review/result.json` into the verdict as the third method. It is
   **advisory**: it never blocks delivery, because a reviewer that has read a transcript has not
   heard the episode. It is there so the question is asked and the answer is written down.
4. **Act on it, then run it again.** A review is a review of one cut: `ep review` records the
   plan, the chapters, the transcript and the notes it was given, and the moment any of them
   changes the verdict says *"answered before the show notes changed — run `ep review` again"*
   rather than crediting the new episode with the old review's verdict. Do not leave that
   hanging at the end of a session.

Tell the person what the review said, what you changed because of it, and what you left and why.
