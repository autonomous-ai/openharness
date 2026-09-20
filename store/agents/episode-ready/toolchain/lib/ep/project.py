"""`episode.json` — the one file the whole harness reads and writes.

Everything an episode is lives here: the sources, what was cut, the music, the chapters, the
metadata and the target. Rendering is a pure function of it, so a revision is a change to this
file and not a second attempt at the work.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = 1
PROJECT_NAME = "episode.json"

#: The stages the pane's header shows, in order. `ep phase` moves between them.
PHASES: list[tuple[str, str]] = [
    ("intake", "Intake"),
    ("cut", "Cut"),
    ("clean", "Clean"),
    ("level", "Level"),
    ("chapter", "Chapter"),
    ("transcribe", "Transcribe"),
    ("write", "Write"),
    ("deliver", "Deliver"),
]

DEFAULT_CLEAN: dict[str, Any] = {
    "highpassHz": 80,
    "denoise": 10,
    "declick": True,
    "deesser": 0.3,
    "gateDb": None,
    "compressor": {"thresholdDb": -20, "ratio": 3, "attackMs": 15, "releaseMs": 250, "makeupDb": 2},
}

AUDIO_SUFFIXES = {
    ".wav", ".wave", ".aiff", ".aif", ".aifc", ".flac", ".mp3", ".m4a", ".aac", ".ogg",
    ".oga", ".opus", ".caf", ".wma", ".mp4", ".mov", ".mkv", ".webm", ".m4v",
}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg"}


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slug(text: str, fallback: str = "episode") -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:60] or fallback


def plan_hash(data: dict) -> str:
    """A fingerprint of everything that changes the audio.

    The master is stale when this moves, which is not the same as "episode.json is newer than
    master.wav": the check writes the project after every render, so a timestamp comparison says
    "stale" forever.
    """
    plan = {
        "sources": [
            {k: src.get(k) for k in ("id", "path", "role", "gainDb", "offsetSec", "clean")}
            for src in data.get("sources") or []
        ],
        "clean": data.get("clean"),
        "voice": data.get("voice"),
        "voiceOffset": data.get("voiceOffset"),
        "music": data.get("music"),
        "target": data.get("target"),
        "output": {k: (data.get("output") or {}).get(k) for k in ("sampleRate", "channels")},
    }
    blob = json.dumps(plan, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def blank(title: str = "") -> dict:
    """A project with nothing in it yet — what a brand new workspace holds."""
    return {
        "schema": SCHEMA,
        "title": title,
        "show": "",
        "summary": "",
        "author": "",
        "link": "",
        "keywords": [],
        "episode": {"number": None, "season": None, "type": "full", "explicit": False,
                    "guid": str(uuid.uuid4()), "pubDate": ""},
        "artwork": "",
        "target": {"preset": "apple"},
        "output": {"sampleRate": 44100, "channels": 1, "mp3Kbps": 96, "aacKbps": 96,
                   "formats": ["mp3", "m4a", "wav"]},
        "clean": dict(DEFAULT_CLEAN),
        "sources": [],
        "voice": [],
        "voiceOffset": 0.0,
        "music": [],
        "removed": [],
        "chapters": [],
        "links": [],
        "transcript": {"model": "base.en", "language": "en", "vocabulary": []},
        "render": {},
        "phase": "intake",
        "updatedAt": utcnow(),
    }


class Project:
    """Load, mutate, save. Saving is atomic because the viewer reads the file as we write it."""

    def __init__(self, root: Path, data: dict):
        self.root = Path(root)
        self.data = data

    # ---------------------------------------------------------------- io

    @classmethod
    def path_for(cls, root: str | Path) -> Path:
        return Path(root) / PROJECT_NAME

    @classmethod
    def find_root(cls, start: Path | None = None) -> Path:
        """The workspace: the nearest folder at or above cwd holding episode.json, else the one
        Harness named, else cwd. Walking up means the agent can run `ep` from raw/ or dist/."""
        here = Path(start or Path.cwd()).resolve()
        for folder in [here, *here.parents]:
            if (folder / PROJECT_NAME).exists():
                return folder
        named = os.environ.get("HARNESS_WORKSPACE")
        return Path(named) if named else here

    @classmethod
    def load(cls, root: str | Path | None = None) -> "Project":
        root = Path(root) if root else cls.find_root()
        path = cls.path_for(root)
        if not path.exists():
            return cls(root, blank())
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"miss {PROJECT_NAME} is not valid JSON ({exc}); fix it and run again")
        merged = blank()
        merged.update(data)
        for key, value in DEFAULT_CLEAN.items():
            merged.setdefault("clean", {}).setdefault(key, value)
        return cls(root, merged)

    def save(self) -> None:
        self.data["updatedAt"] = utcnow()
        path = self.path_for(self.root)
        tmp = path.with_suffix(".json.part")
        tmp.write_text(json.dumps(self.data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(path)

    # ---------------------------------------------------------------- shorthands

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.data[key] = value

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    @property
    def work(self) -> Path:
        d = self.root / "work"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def dist(self) -> Path:
        d = self.root / "dist"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def setdefault_encoded(self, name: str, measurement: dict) -> None:
        """What a delivered file measured once encoded — the numbers the platform will see."""
        render = self.data.setdefault("render", {})
        render.setdefault("encoded", {})[name] = measurement

    def source(self, source_id: str) -> dict | None:
        for src in self.data.get("sources", []):
            if src.get("id") == source_id:
                return src
        return None

    def voice_sources(self) -> list[dict]:
        return [s for s in self.data.get("sources", []) if s.get("role", "voice") == "voice"]

    def abs_path(self, rel: str) -> Path:
        p = Path(rel)
        return p if p.is_absolute() else self.root / p

    def base_name(self) -> str:
        return slug(self.data.get("title") or self.data.get("show") or "episode")

    # ---------------------------------------------------------------- the two timelines
    #
    # SESSION time is the recording as it happened: every voice source laid at its own
    # `offsetSec` and mixed. Two tracks from a remote-recording service both sit at 0 and run in
    # parallel; an intro recorded separately sits after the main take. Cuts are ranges of the
    # session, so removing a gap removes it from every speaker at once.
    #
    # OUTPUT time is the published episode: the kept session ranges joined, shifted by
    # `voiceOffset` to leave room for a cold open, with the music cues placed over the top.

    #: Fields a kept range may carry beyond `in`/`out`: what to do to that stretch alone.
    CLIP_FIELDS = ("gainDb", "presenceDb", "warmthDb", "note")

    def session_duration(self) -> float:
        end = 0.0
        for source in self.voice_sources():
            length = float((source.get("probe") or {}).get("duration") or 0.0)
            end = max(end, float(source.get("offsetSec") or 0.0) + length)
        return end

    def voice_clips(self) -> list[dict]:
        """The kept ranges of the session, in order. With no edit yet, the whole session."""
        clips = [c for c in (self.data.get("voice") or []) if float(c["out"]) > float(c["in"])]
        if clips:
            return clips
        duration = self.session_duration()
        return [{"in": 0.0, "out": duration}] if duration else []

    def voice_length(self) -> float:
        return sum(max(0.0, float(c["out"]) - float(c["in"])) for c in self.voice_clips())

    def output_duration(self) -> float:
        end = float(self.data.get("voiceOffset") or 0.0) + self.voice_length()
        for item in self.data.get("music") or []:
            end = max(end, float(item.get("at", 0.0)) + (float(item["out"]) - float(item["in"])))
        return end

    def session_to_output(self, when: float) -> float | None:
        """Where a moment in the recording ends up in the episode — how a mark survives a cut."""
        cursor = float(self.data.get("voiceOffset") or 0.0)
        for clip in self.voice_clips():
            start, end = float(clip["in"]), float(clip["out"])
            if start <= when <= end:
                return cursor + (when - start)
            cursor += end - start
        return None

    def output_to_session(self, when: float) -> float | None:
        cursor = float(self.data.get("voiceOffset") or 0.0)
        for clip in self.voice_clips():
            length = float(clip["out"]) - float(clip["in"])
            if cursor <= when <= cursor + length:
                return float(clip["in"]) + (when - cursor)
            cursor += length
        return None

    # ---------------------------------------------------------------- phases

    def set_phase(self, phase_id: str) -> None:
        ids = [p[0] for p in PHASES]
        if phase_id not in ids:
            raise SystemExit(f"miss '{phase_id}' is not a phase; they are: {', '.join(ids)}")
        self.data["phase"] = phase_id

    def phase_states(self, *, done: bool = False, failed: bool = False) -> list[dict]:
        current = self.data.get("phase") or "intake"
        ids = [p[0] for p in PHASES]
        index = ids.index(current) if current in ids else 0
        out = []
        for i, (pid, name) in enumerate(PHASES):
            if done:
                state = "done"
            elif i < index:
                state = "done"
            elif i == index:
                state = "failed" if failed else "active"
            else:
                state = "pending"
            out.append({"id": pid, "name": name, "state": state})
        return out


def discover(root: Path) -> tuple[list[Path], list[Path]]:
    """What the person dropped in: recordings in raw/, artwork in art/."""
    audio, art = [], []
    for folder, suffixes, bucket in ((root / "raw", AUDIO_SUFFIXES, audio), (root / "art", IMAGE_SUFFIXES, art)):
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*")):
            if path.is_file() and path.suffix.lower() in suffixes and not path.name.startswith("."):
                bucket.append(path)
    return audio, art
