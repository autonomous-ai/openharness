#!/usr/bin/env bash
# A new workspace. Runs once, in the workspace, right after the template is copied.
# Fast and offline: everything expensive already happened at install.
set -euo pipefail
WS="$PWD"
DSH="${HARNESS_DSH_DIR:-}"
mkdir -p raw art dist work .harness

# Any actual recording already here means this is the person's workspace, not a fresh one.
brought=0
for f in raw/*; do
  case "${f##*.}" in
    wav|WAV|mp3|MP3|m4a|M4A|flac|FLAC|aiff|AIFF|aif|AIF|aac|AAC|ogg|OGG|opus|OPUS|mov|MOV|mp4|MP4|mkv|MKV|caf|CAF)
      brought=1 ;;
  esac
done

demo="$DSH/upstream/demo"
seeded=0
if [ -n "$DSH" ] && [ -f "$demo/episode.json" ] && [ "$brought" = 0 ]; then
  # The worked example, produced at install from a public-domain recording, so the pane opens on
  # real work rather than on an empty screen. The person replaces it with their own recording.
  for item in episode.json transcript.json shownotes.md raw art dist .harness; do
    [ -e "$demo/$item" ] && cp -R "$demo/$item" "$WS/" 2>/dev/null || true
  done
  # The master and its waveform, but not the intermediates: `ep render` makes those again in
  # seconds, and a new workspace should not start life 40 MB heavy.
  for item in master.wav master.peaks before.peaks contour.json metadata.ffmeta; do
    [ -e "$demo/work/$item" ] && cp "$demo/work/$item" "$WS/work/" 2>/dev/null || true
  done
  seeded=1
fi

if [ "$seeded" = 0 ] && [ ! -s episode.json ]; then
  cat > episode.json <<'JSON'
{
  "schema": 1,
  "title": "",
  "show": "",
  "summary": "",
  "author": "",
  "link": "",
  "keywords": [],
  "episode": { "number": null, "season": null, "type": "full", "explicit": false, "guid": "", "pubDate": "" },
  "artwork": "",
  "target": { "preset": "apple" },
  "output": { "sampleRate": 44100, "channels": 1, "mp3Kbps": 96, "aacKbps": 96, "formats": ["mp3", "m4a", "wav"] },
  "clean": { "highpassHz": 80, "denoise": 10, "declick": true, "deesser": 0.3, "gateDb": null,
             "compressor": { "thresholdDb": -20, "ratio": 3, "attackMs": 15, "releaseMs": 250, "makeupDb": 2 } },
  "sources": [],
  "voice": [],
  "voiceOffset": 0,
  "music": [],
  "removed": [],
  "chapters": [],
  "links": [],
  "transcript": { "model": "base.en", "language": "en", "vocabulary": [] },
  "render": {},
  "phase": "intake"
}
JSON
fi

if [ "$seeded" = 0 ] || [ ! -s .harness/verdict.json ]; then
  cat > .harness/verdict.json <<'JSON'
{
  "spec": 1,
  "ready": false,
  "summary": "put your recording in raw/ and say what you want",
  "findings": [],
  "phases": [
    { "id": "intake", "name": "Intake", "state": "active" },
    { "id": "cut", "name": "Cut", "state": "pending" },
    { "id": "clean", "name": "Clean", "state": "pending" },
    { "id": "level", "name": "Level", "state": "pending" },
    { "id": "chapter", "name": "Chapter", "state": "pending" },
    { "id": "transcribe", "name": "Transcribe", "state": "pending" },
    { "id": "write", "name": "Write", "state": "pending" },
    { "id": "deliver", "name": "Deliver", "state": "pending" }
  ],
  "updatedAt": "1970-01-01T00:00:00Z"
}
JSON
fi
exit 0
