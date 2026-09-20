"""Transcription, and the caption files that come out of it.

The transcript is taken from the *master*, not the raw take, so its times line up with the
published episode, the chapters and the show notes. The person's own vocabulary — the guest's
name, the product, the jargon — goes in as `initial_prompt`, which is the single biggest thing
that decides whether proper nouns come out right.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

#: How long a caption is allowed to be before it stops being readable on a phone.
MAX_CUE_SECONDS = 7.0
MAX_CUE_CHARS = 180


def model_dir(name: str) -> Path:
    package = Path(os.environ.get("EPISODE_PACKAGE", "."))
    return package / "upstream" / "models" / name


def ensure_model(name: str, *, log=print) -> Path:
    """The pinned weights for `name`, fetched at the commit VERSIONS records if they are not here."""
    dest = model_dir(name)
    if (dest / "model.bin").exists():
        return dest
    package = Path(os.environ.get("EPISODE_PACKAGE", "."))
    versions = (package / "VERSIONS").read_text(encoding="utf-8")
    key = "WHISPER_MODEL_" + re.sub(r"[.-]", "_", name)
    match = re.search(rf"^{re.escape(key)}='([^']+)'", versions, re.M)
    if not match:
        known = sorted(re.findall(r"^WHISPER_MODEL_(\w+)=", versions, re.M))
        known = [k.replace("_en", ".en").replace("_", "-") for k in known]
        raise SystemExit(
            f"miss '{name}' is not one of the pinned models. Pinned: {', '.join(known)}"
        )
    log(f"     fetching the {name} weights once (pinned to {match.group(1).rsplit('@', 1)[1][:12]})")
    from . import ff

    script = package / "toolchain" / "lib" / "fetch_model.py"
    proc = ff.run([os.environ.get("EPISODE_PYTHON") or _python(), str(script), name,
                   match.group(1), str(dest.parent)], check=False)
    print(proc.stdout.strip())
    if proc.returncode != 0 or not (dest / "model.bin").exists():
        raise SystemExit(f"miss the {name} weights could not be fetched — check the network and try again")
    return dest


def _python() -> str:
    import sys

    return sys.executable


def transcribe(audio: Path, *, model: str = "base.en", language: str | None = "en",
               vocabulary: list[str] | None = None, log=print) -> dict:
    """Word-timed segments for `audio`, as the shape `transcript.json` keeps."""
    from faster_whisper import WhisperModel

    path = ensure_model(model, log=log)
    prompt = None
    if vocabulary:
        prompt = "Spelling reference: " + ", ".join(str(v) for v in vocabulary if str(v).strip()) + "."
    log(f"     transcribing with {model}" + (f", primed with {len(vocabulary)} term(s)" if vocabulary else ""))
    engine = WhisperModel(str(path), device="cpu", compute_type="int8")
    segments, info = engine.transcribe(
        str(audio),
        language=None if (language in (None, "", "auto")) else language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 700},
        # Whisper invents text over silence; both of these are what stop it.
        hallucination_silence_threshold=2.0,
        condition_on_previous_text=False,
        initial_prompt=prompt,
    )
    out: list[dict] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        words = [
            {"w": (w.word or "").strip(), "s": round(float(w.start), 3), "e": round(float(w.end), 3)}
            for w in (seg.words or [])
            if (w.word or "").strip()
        ]
        out.append({"start": round(float(seg.start), 3), "end": round(float(seg.end), 3),
                    "text": tidy(text), "words": words})
    return {
        "model": model,
        "language": info.language,
        "duration": round(float(info.duration), 3),
        "vocabulary": list(vocabulary or []),
        "segments": split_long(out),
    }


# Whisper emits "-up" and "'s" as their own tokens; joining them with a space gives
# "pick -up address" and "it 's". Punctuation that opens a group takes the space after it instead.
_TIDY = re.compile(r"\s+([,.;:!?%)\]}\u2019\u201d]|-\w|'\w)|([(\[{\u2018\u201c])\s+")


def tidy(text: str) -> str:
    """Whisper's word tokens carry their own leading spaces; joining them leaves ' ,' and '20 ,000'."""
    return _TIDY.sub(lambda m: m.group(1) or m.group(2), " ".join(text.split())).strip()


def replace_terms(transcript: dict, pairs: list[tuple[str, str]]) -> int:
    """Fix a misheard name everywhere at once, in the cue text and in the word times under it.

    A correction usually spans more than one word ("nuclear board" -> "nucleo board"), so the run
    of words it covers is replaced as a run and the new tokens share that run's time span. Getting
    this wrong leaves the pane — which draws the words, not the text — still showing the mistake.
    """
    hits = 0
    for seg in transcript.get("segments", []):
        for wrong, right in pairs:
            pattern = re.compile(re.escape(wrong), re.I)
            if pattern.search(seg["text"]):
                seg["text"] = pattern.sub(right, seg["text"])
                hits += 1
            seg["words"] = _replace_in_words(seg.get("words") or [], pattern, right)
    return hits


def _replace_in_words(words: list[dict], pattern: re.Pattern, right: str) -> list[dict]:
    if not words:
        return words
    joined = " ".join(w["w"] for w in words)
    starts, cursor = [], 0
    for word in words:
        starts.append(cursor)
        cursor += len(word["w"]) + 1
    out = list(words)
    for match in reversed(list(pattern.finditer(joined))):
        first = last = None
        for i, begin in enumerate(starts):
            end = begin + len(words[i]["w"])
            if begin < match.end() and end > match.start():
                first = i if first is None else first
                last = i
        if first is None:
            continue
        span_start, span_end = out[first]["s"], out[last]["e"]
        # "nuclear board," -> "nucleo board" must not lose the comma the run was carrying.
        trailing = ""
        tail = out[last]["w"]
        while tail and tail[-1] in ",.;:!?\u2019\u201d)]}\"'":
            trailing = tail[-1] + trailing
            tail = tail[:-1]
        replacement = right if right.rstrip()[-1:] in ",.;:!?" else right + trailing
        tokens = replacement.split() or [replacement]
        step = (span_end - span_start) / len(tokens)
        replaced = [
            {"w": token, "s": round(span_start + i * step, 3), "e": round(span_start + (i + 1) * step, 3)}
            for i, token in enumerate(tokens)
        ]
        out = out[:first] + replaced + out[last + 1:]
    return out


def split_long(segments: list[dict]) -> list[dict]:
    """Break the cues Whisper returns as one long run, using the word times it already gave us."""
    out: list[dict] = []
    for seg in segments:
        span = seg["end"] - seg["start"]
        if (span <= MAX_CUE_SECONDS and len(seg["text"]) <= MAX_CUE_CHARS) or not seg["words"]:
            out.append(seg)
            continue
        current: list[dict] = []
        for word in seg["words"]:
            current.append(word)
            span = current[-1]["e"] - current[0]["s"]
            text = tidy(" ".join(w["w"] for w in current))
            ends_clause = word["w"].endswith((".", "?", "!", ",", ";", ":"))
            if (span >= MAX_CUE_SECONDS or len(text) >= MAX_CUE_CHARS) or (ends_clause and span >= 3.0):
                out.append({"start": current[0]["s"], "end": current[-1]["e"],
                            "text": text, "words": list(current)})
                current = []
        if current:
            out.append({"start": current[0]["s"], "end": current[-1]["e"],
                        "text": tidy(" ".join(w["w"] for w in current)), "words": list(current)})
    return out


# --------------------------------------------------------------------------- caption writers

def _clock(seconds: float, comma: bool = False) -> str:
    seconds = max(0.0, float(seconds))
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms == 1000:
        ms, s = 0, s + 1
    sep = "," if comma else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_vtt(transcript: dict, *, speakers: dict[str, str] | None = None) -> str:
    lines = ["WEBVTT", ""]
    for i, seg in enumerate(transcript["segments"], 1):
        lines.append(str(i))
        lines.append(f"{_clock(seg['start'])} --> {_clock(seg['end'])}")
        speaker = seg.get("speaker")
        prefix = f"<v {speakers.get(speaker, speaker)}>" if speaker and speakers else (f"<v {speaker}>" if speaker else "")
        lines.append(f"{prefix}{seg['text']}")
        lines.append("")
    return "\n".join(lines)


def to_srt(transcript: dict) -> str:
    lines = []
    for i, seg in enumerate(transcript["segments"], 1):
        lines.append(str(i))
        lines.append(f"{_clock(seg['start'], comma=True)} --> {_clock(seg['end'], comma=True)}")
        speaker = seg.get("speaker")
        lines.append(f"{speaker}: {seg['text']}" if speaker else seg["text"])
        lines.append("")
    return "\n".join(lines)


def to_text(transcript: dict, chapters: list[dict] | None = None) -> str:
    """Readable prose, with the chapter headings in place — what goes on the episode page."""
    chapters = sorted(chapters or [], key=lambda c: float(c.get("start", 0)))
    out: list[str] = []
    next_chapter = 0
    paragraph: list[str] = []

    def flush() -> None:
        if paragraph:
            out.append(" ".join(paragraph).strip())
            out.append("")
            paragraph.clear()

    last_speaker = None
    for seg in transcript["segments"]:
        while next_chapter < len(chapters) and float(chapters[next_chapter]["start"]) <= seg["start"]:
            flush()
            out.append(f"## {chapters[next_chapter].get('title') or 'Chapter'}")
            out.append("")
            next_chapter += 1
        speaker = seg.get("speaker")
        if speaker != last_speaker and speaker:
            flush()
            paragraph.append(f"**{speaker}:**")
            last_speaker = speaker
        paragraph.append(seg["text"])
        if len(" ".join(paragraph)) > 600:
            flush()
    flush()
    return "\n".join(out).strip() + "\n"


def to_podcast_json(transcript: dict) -> str:
    """`application/json` for podcast:transcript — the segment form the namespace documents."""
    segments = []
    for seg in transcript["segments"]:
        item = {"startTime": seg["start"], "endTime": seg["end"], "body": seg["text"]}
        if seg.get("speaker"):
            item["speaker"] = seg["speaker"]
        segments.append(item)
    return json.dumps({"version": "1.0.0", "segments": segments}, indent=2, ensure_ascii=False) + "\n"
