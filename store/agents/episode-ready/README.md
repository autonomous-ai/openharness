<img src="brand/logo.svg" alt="Episode Ready" height="48">

# Episode Ready

Drop the recording of an interview or a solo episode into `raw/`, say what you want, and get the
published episode back: dead air cut, voices repaired and matched, levelled to the loudness the
platforms expect, chaptered, transcribed, tagged and encoded into the files any podcast host will
take. Everything you upload lands in `dist/`, and everything in there opens somewhere other than
here.

```
harness dsh install autonomous/episode-ready       # from the Store
harness dsh install "$PWD" --link                  # this working tree, for development
harness dsh doctor autonomous/episode-ready        # what the machine is missing, if anything
```

Installing takes a couple of minutes and about **750 MB**: a pinned FFmpeg, a Python for the
transcriber, and the Whisper `base.en` weights. After that nothing needs the network.

## What you get

| | |
|---|---|
| `episode.mp3` | for the feed — ID3v2 with real `CHAP`/`CTOC` chapter frames and embedded cover art |
| `episode.m4a` | AAC in MP4 with chapters, for Apple Podcasts and Overcast |
| `*-master.wav` | 44.1 kHz / 24-bit, to open in any editor |
| `*.vtt` `*.srt` `*.txt` `*.transcript.json` | all four are legal `podcast:transcript` types |
| `chapters.json` | Podlove Simple Chapters, for `podcast:chapters` |
| `shownotes.md` / `.html` | the episode description |
| `episode-item.xml` | an `<item>` with the `itunes:` and `podcast:` tags filled in |
| `cover-3000.jpg` / `cover-1400.jpg` | inside Apple's artwork spec |
| `report.md` | the measurements, so you can show a host the episode is in spec |

## The pane

The left of the window is a mastering desk. The waveform of the master with its short-term
loudness drawn over it; a BS.1770 meter against the target and its tolerance band; **Before/Master
(`B`)**, which switches between what you handed in and what came out *at the same moment of the
recording* and shades what the edit removed; chapter flags you drag and titles you rename; the
transcript following the playhead, editable word by word; the show notes, editable; every
deliverable with its size and a download.

Everything you change there is written into the same files the agent reads on its next turn —
`episode.json`, `transcript.json`, `shownotes.md` — with the previous version kept in
`.harness/history/`. A change that affects the audio marks the master stale and offers a
re-render; renaming a chapter does not.

A new workspace opens on a finished worked example so the pane is never empty. The first time you
put your own recording in `raw/`, `ep intake` moves the whole example — audio, title, chapters,
notes, transcript — into `.harness/history/example/` and starts a blank episode.

## How it is judged

Three verdicts, all shown in the pane, two of them gates:

- **Verified by ffmpeg's `ebur128`** (an ITU-R BS.1770 meter) and by `ffprobe` reopening every
  delivered file — integrated loudness, true peak, loudness range, clipping, and that the MP3
  really carries its chapter frames and its cover, read from the raw ID3 tag. The encoded file is
  measured as well as the master, because the encoded file is what the platform receives. **Gate.**
- **Checked against** the platforms' published rules — [Apple Podcasts' audio
  requirements](https://podcasters.apple.com/support/893-audio-requirements) (-16 LKFS ± 1 dB,
  true peak -1 dBFS) and [AESTD1008.1.21-9](https://aes.org/community/technical-council/technical-document-aestd1008/)
  (-18 LUFS for speech) — plus the craft's rules (no chapter under 10 seconds, no dead air over
  2.5 s, speech at least 30 dB above the room, artwork square and 1400–3000 px) and whatever the
  brief itself claimed. **Gate.**
- **Reviewed against a listening rubric with fresh ears** — seven criteria, judged by a reviewer
  that has not seen the conversation, on clips the harness writes around every splice and chapter.
  **Advisory**, because a reviewer that has read a transcript has not heard the episode; but a
  failure is said plainly in the header, and a review answered before the last change is reported
  as out of date rather than credited to the new cut.

**What none of it can tell you:** whether the episode is worth listening to, and whether the
repair took the life out of a voice. The defaults are deliberately gentle for that reason.

## Credit and stewardship

Episode Ready is an original workflow, written by Autonomous. It is not a front end for one
project; it stands on other people's work, and that work is credited here rather than on the tile.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for versions and licences.

- **[FFmpeg](https://ffmpeg.org)** does the decoding, repair, loudness measurement, mixing and
  muxing. Fetched at install from conda-forge, pinned to `9.0.2` in an LGPL build
  (`--disable-gpl --enable-version3`), never vendored into this repository.
- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** (SYSTRAN) and
  **[CTranslate2](https://github.com/OpenNMT/CTranslate2)** run the transcription, with
  **[Whisper](https://github.com/openai/whisper)** weights converted by SYSTRAN, pinned by
  Hugging Face commit.
- The recording a new workspace opens on is *To Write or Not To Write* by **Susan Andrews Rice**
  (*The Writer*, vol. 6, April 1892), read for **[LibriVox](https://librivox.org)** in Short
  Nonfiction Collection Vol. 013 and in the public domain. Fetched at install, pinned by SHA-256,
  and produced through this harness's own pipeline — what you see in a new workspace is real
  output, not a mock-up.
- The mark and the pane are Autonomous's own; no upstream project's logo is used.

Bugs in FFmpeg or faster-whisper belong upstream. Bugs in this harness belong here.

## Limits, said plainly

- Transcription runs on the CPU at roughly seven times real time with `base.en`, so a 45-minute
  episode takes six or seven minutes. `--model small.en` is more accurate and about a third the
  speed.
- Whisper invents text over silence. VAD filtering and a hallucination threshold are on, and the
  check flags a line that repeats three times, but read the transcript.
- The install is about 750 MB and needs the network once.
- There is no speaker diarisation: on a single-microphone recording the transcript does not say
  who is speaking. With one file per speaker you know already.
- The harness will not invent audio, and it will not write a show note that is not in the
  transcript. If you ask it to, it will say no.

MIT licensed. See [LICENSE](LICENSE).
