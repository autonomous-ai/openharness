# Score acceptance evidence

Validated 2026-09-20, macOS Intel, Node 22.23.2 and official LilyPond 2.26.0.
No physical instruments or real-player evaluation were used. This is software
validation of a composition/edit/export workflow, not a musical-quality rating.

## Two complete briefs

| Job | Requirements and substantive revision | Evidence |
| --- | --- | --- |
| After the Rain | An original 16-bar 6/8 flute, B-flat clarinet and cello miniature, for a user who owns no instruments | 55 checks; four one-page PDFs; actual clarinet written range F#4–D5, concert range E4–C5; full score equals independent concert proofs |
| A Small Beginning | An independent eight-bar 4/4 beginner flute/piano duet; then lower flute ceiling from G5 to E5 and reduce attacks to three per bar while keeping the piano unchanged | 49 checks; three one-page PDFs; stricter brief rejects the original flute; corrected music passes; piano MIDI hash is unchanged; length remains eight bars |

The initial duet also caught a piano voicing below the requested C4 right-hand
floor. The chord was inverted into range; the requirement was not widened.

Both jobs deliver a full PDF/MIDI, separate player PDF/MIDI, slower full/solo/
minus-one MIDI with count-in, editable sources, saved brief and standalone tools.
An extracted trio ZIP was independently checked with `unzip -t` and rebuilt
using its own scripts. Source revision and exported notes matched the original;
no Harness account, Python or npm package was required for rebuilding.

## Native and unit checks

```sh
LILYPOND_BIN=/path/to/lilypond node --test store/agents/score/test/*.test.mjs
```

**14/14 passed**, including four opt-in native tests. Without `LILYPOND_BIN`,
the native cases are explicitly skipped, not counted as native proof.

Coverage includes:

- MIDI event bounds, running status, timing, incomplete notes and end-of-track.
- Contract validation, scientific pitch, transposition, range, polyphony,
  successive-note leaps, note attacks and measured duration including rests.
- Fifteen pitched MIDI channels without consuming channel 10; simple and
  compound count-in; tempo changes and note-preserving export round trips.
- Source allowlisting, omitted includes, traversal, symlinks and exclusive lock.
- Native wrong-transposition, wrong-length and chord/polyphony failures.
- Native source mutation during rendering; failed revisions preserve good output.
- Strict revision that leaves unaffected piano bytes unchanged; prior handoff
  remains recoverable in history.
- Real ZIP extraction and standalone native rebuild.
- The earlier self-contained Lighthouse at Dusk source still engraves its
  142-note piano study, while reporting `ready: false` without a checked brief.

## Real viewer, audio and downloads

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  node store/agents/score/test/browser.mjs /path/to/built-workspace /path/to/evidence
```

Passed separately for trio and revised duet in the shared **opaque-origin**
viewer, at 1600×1100 and 390×844. The acceptance helper does not overwrite the
builder's readiness verdict.

- Play/pause advances real AudioContext time; a live analyser measures nonzero
  audio, not just a moving animation.
- Seeking resumes notes already held at the selected time.
- Mute/solo changes the actual mix; selected complete-bar loops repeat.
- Listening setup survives a JSON save/restore; wrong source revisions are rejected.
- WAV export produces nonzero, unclipped 22.05 kHz mono PCM with expected
  loop/speed/count-in duration: approximately 5.343 s for trio and 8.010 s for duet.
- An all-muted WAV export is rejected with a useful message.
- All score/part PDF, practice MIDI and project ZIP downloads match on-disk bytes.
- All document images load; no browser errors or mobile horizontal overflow.

Every page of the trio, revised duet and legacy PDF was rasterized with Poppler
and visually inspected. The printed clarinet key/transposition, labels, slurs,
dynamics and breaks were checked. Browser desktop, part and mobile views were
also inspected. Store images are captures of those real workflows.

## Release checks and retained local evidence

Package conformance, skill validation, generated experience/branding checks,
`git diff --check` and the 433 registry/store/catalog/publisher tests passed.

Local QA root for this run: `/private/tmp/harness-score-workflows.HyXxOL`.
Final native fixtures are in `release-native/`; browser receipts, WAVs, downloaded
files and screenshots are in `release-browser-trio/` and
`release-browser-duet/`. These temporary local paths are evidence locations for
this workstation, not files shipped in the Store package.

## Limits that remain

No claim of performer-approved playability, musical quality, breath/fingering
suitability, sampled sound quality or rights clearance. Browser audio and
practice exports are note-only synthetic sketches. The checked workflow is
bounded to constant meter/tempo, complete bars and pitched staves; see the
[contract](../skills/score/references/ensemble.md) for exact limits. Source
allowlisting is not a sandbox for trusted LilyPond Scheme.
