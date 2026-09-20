# Art and Music authoring rebuild · 2026-09-20

Generative Art and Music Studio have authoring implementations and are **listed for user testing**.
The user explicitly requested access through the Harness Store after finding both missing. The
other five earlier harnesses remain unlisted, with their source and identities in the repository.
This report establishes working tools and reproducible fixtures; the remaining product validation
in [SUPERPOWERS.md](SUPERPOWERS.md) is still outstanding.

## What changed

Fieldwork accepts an arbitrary drawing program, project-specific controls, text, images and data.
The agent authors the program for the brief; the person edits the resulting studio. It delivers
SVG, PNG, format/edition ZIPs, a complete editable project and portable HTML. There is no style enum
or imitation AI prompt box. Rendering uses a terminable worker and refuses stale exports on errors.

Afterhours holds an arbitrary score: notes, tempo changes, sections, instruments and recordings.
The person can edit/drag notes, mix tracks, import MIDI/audio, trim and position recordings, and use
their recording as a pitched instrument. Production delivery contains stereo PCM WAV, aligned WAV
stems, standard MIDI with tempo/section/end markers, a project and portable studio.

Both preserve local drafts and handle source-revision conflicts explicitly. Saved projects can be
imported into the agent's source with a backup. Browser edits are **not automatically written back**
to the workspace. The browser says how to save/attach the project; the agent instructions state this
boundary. Authoring/export tools install locally; the resulting studios work offline.

## Acceptance fixtures and targeted revisions

These briefs and their input materials were authored in this coding session to exercise distinct
workflows. They are not customer commissions, real rainfall observations or evidence of an
unsupervised Claude session completing a user's brief.

| Brief | Original delivery | Targeted revision | Material retained |
|---|---|---|---|
| Night Garden festival | 3 formats; original cut-paper geometry | New dates and venue | Illustration, seed, name, lineup and palette |
| Canopy Coffee packaging | 3 formats; woodcut geometry and embedded logo fixture | New product lot | Logo bytes, origin, illustration and colors |
| A Year of Rain | 3 formats; actual CSV values encoded in calendar rings | January 42 → 84 mm; total 1388 → 1430 | Other 11 observations, palette and program |
| Blue Hour documentary cue | 48 s, 5 tracks, 249 notes | Quiet final motif echo; 250 notes | Accompaniment and timing |
| Orbit Runner game title | 30 s, 4 tracks, 312 notes | Remove first two launch bars' hats; 296 notes | Hook, bass, kick and snare |
| Keepsake family-film waltz | 33 s, 3/4, two tempos, 92 notes | Add bell response; 94 notes | Imported melody, accompaniment and tempo map |

Source examples live inside each independently installable package. `revisions.mjs` exercises the
actual project-import command, verifies retained material, creates source history and exports both
editable projects and revised deliverables. Before/after vectors or scores are retained in its
output folder. Store images are actual exported artwork or actual studio captures.

## Evidence

- 96 Node tests passed across package scripts, original retained models, new project/score models
  and the shared viewer. The 13 new authoring tests also passed after final validation changes.
- Real Chrome tests passed for both rebuilt studios through the Store viewer. They cover controls,
  note dragging, undo/redo, own image/audio imports, MIDI/project roundtrips, portable HTML, browser
  draft/source conflicts, viewer reload, 390px layout and no page exceptions. Music tests verify
  a running audio context; this is **not listening evidence**.
- Both installed packages passed running-app integration: temporary idle Claude sessions, new
  workspaces, package instructions, viewer routing, honest initial verdict and live reload. No
  prompts were sent. Only the test sessions were deleted.
- Six desktop identity tests passed. Existing SVG/PNG logos remain intact; the fallback taglines
  now describe the new capabilities.
- All nine initial art layouts were visually inspected. Square-format collisions were fixed.
  The final data-art formats include a scale and ring-order legend. Python XML parsing plus PNG
  CRC/deflate decoding passed for all nine revised formats. SVG and PNG dimensions agree.
- Python `wave`, `zipfile` and **mido 1.3.3** independently read all three original and three revised
  music deliveries. They verified note content, tempo, meter, length, section/end markers, stereo
  48 kHz/16-bit WAV and matching stem lengths. Summed stems differ from the mix by at most **2 PCM
  integer units**, within quantization error. MIDI retains intentional silence at the end.
- Same-score Web Audio rerenders differed by less than 1e-7 in the checked samples. The measured
  original peaks were 0.494, 0.390 and 0.229. These measurements do not assess composition quality.

Reproduction commands are in [the test guide](../store/tools/experience-tests/README.md).
CI now includes both real-browser authoring workflows and the independent music delivery reader.
Large transient WAV/ZIP/browser captures belong in ignored evidence folders, not source control.

## Remaining product review

The full music listening pass has **not happened**. Musical transitions, sound quality and fit to a
real user's brief remain unverified. The scenarios also do not replace end-to-end authoring trials
with the installed coding engine and real user inputs. The user's subsequent request to test both
through the Store supersedes the earlier decision to withhold their listings. Publication makes
the rebuilt tools accessible for that testing; it does not establish that these reviews passed.

Install **Generative Art** or **Music Studio** from the Harness Store and create a **new workspace**
to try the rebuild. Existing local links also point at it. Existing workspaces retain their own
files; a package update or public Store catalog refresh does not overwrite them.

Practical limits: static RGB artwork with editable system-font text, not press certification;
four-minute instrumental scores with 16 tracks and 28 MB embedded data, not generated singing or
a mastered release. MIDI does not reproduce sustain, pitch bend or controller automation; import
reports that limitation. WAV stems preserve the studio sound.
