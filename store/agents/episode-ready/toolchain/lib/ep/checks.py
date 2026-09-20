"""What decides whether the episode is publishable.

Three kinds of rule live here and they are kept apart on purpose:

  * **the instrument** — ffmpeg's `ebur128`, an ITU-R BS.1770 meter, and `ffprobe` reading the
    container back. These are measurements, not opinions.
  * **the craft's rules** — what a podcast editor would send back: dead air, a chapter shorter
    than a player can seek to, artwork that Apple will reject, a caption nobody can read.
  * **the brief's own claims** — whatever `episode.json` says this episode is (a target, a
    duration, a chapter count, a list of deliverables) checked against what was produced.

What none of it can see is whether the episode is any good, and whether the denoiser took the
life out of the voice. That is what `ep review` gathers evidence for, and it says so.
"""
from __future__ import annotations

import json
import re
import struct
from pathlib import Path

from . import ff
from .deliver import ART_FEED, ART_LARGE, ordered_chapters
from .project import Project
from .render import fmt_hms

#: A chapter shorter than this is not reachable in most players' chapter menus.
MIN_CHAPTER_SECONDS = 10.0
#: Silence longer than this inside the body is dead air a listener notices.
MAX_INTERNAL_SILENCE = 2.5
MAX_HEAD_SILENCE = 0.8
MAX_TAIL_SILENCE = 2.5
#: Speech has to sit at least this far above the room tone. Absolute level is the wrong measure:
#: a quiet recording levelled up to -16 LUFS brings its hiss up with it.
MIN_SNR_DB = 30.0
#: Apple's RSS table: mono 64-128 kbps, stereo 128-256, at 44.1 or 48 kHz.
BITRATE_RANGE = {1: (64, 128), 2: (128, 256)}
CAPTION_MAX_SECONDS = 8.0
SUMMARY_LIMIT = 4000


#: Which of the declared methods each kind of finding belongs to. `tool` is what an instrument or
#: an independent reader said; `checks` is a rule of the craft or a claim in the brief.
BY_INSTRUMENT = {
    "loudness", "loudness_off_target", "true_peak", "loudness_range", "over_compressed",
    "encoded_loudness", "encoded_true_peak",
    "clipping", "duration_mismatch", "unreadable_deliverable", "chapters_not_embedded",
    "no_id3_chapters", "no_id3_art", "no_title_tag", "no_embedded_art", "sample_rate", "bitrate",
    "no_master",
}


def finding(severity: str, kind: str, message: str, ref: str | None = None) -> dict:
    out = {"severity": severity, "kind": kind, "message": message,
           "method": "tool" if kind in BY_INSTRUMENT else "checks"}
    if ref:
        out["ref"] = ref
    return out


def review_fingerprint(project: Project) -> dict:
    """What a listening review is a review *of*: the audio plan, the chapters, the transcript and
    the notes. Content, not timestamps — `ep check` rewrites `episode.json` every time it runs,
    so a timestamp would call every review stale the moment it was folded in."""
    import hashlib

    from .project import plan_hash

    def digest(name: str) -> str:
        path = project.root / name
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16] if path.exists() else ""

    return {
        "plan": plan_hash(project.data),
        "chapters": hashlib.sha256(
            json.dumps(project.get("chapters") or [], sort_keys=True).encode()).hexdigest()[:16],
        "transcript": digest("transcript.json"),
        "notes": digest("shownotes.md"),
    }


def review_result(project: Project) -> dict | None:
    """What a fresh pair of ears said, if `ep review` has been answered — and only if it was
    answered about *this* episode. A review of an earlier cut is not evidence about what is in
    the workspace now, and leaving it in the header tells the person their finished episode
    failed a test it was never given."""
    folder = project.root / ".harness" / "review"
    path = folder / "result.json"
    if not path.exists():
        return None
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    try:
        when = json.loads((folder / "context.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return result
    now = review_fingerprint(project)
    changed = [k for k, v in when.items() if k in now and now[k] != v]
    if changed:
        result = dict(result)
        result["stale"] = True
        result["staleBecause"] = {"plan": "the edit", "chapters": "the chapters",
                                  "transcript": "the transcript",
                                  "notes": "the show notes"}[changed[0]]
    return result


def evaluation(project: Project, findings: list[dict]) -> list[dict]:
    """The three ways this episode is judged, in the shape the pane and the store page read.

    `gate: true` entries are what `ready` depends on. The listening review is advisory: a model
    that has not heard the audio should not be able to block a person's episode, and a model that
    has read the evidence should still be able to say something is wrong.
    """
    render = project.get("render") or {}
    measured, target = render.get("measured"), render.get("target")
    tool_bad = [f for f in findings if f.get("method") == "tool" and f["severity"] == "error"]
    rule_bad = [f for f in findings if f.get("method") == "checks" and f["severity"] == "error"]
    delivered = (project.get("delivered") or {}).get("files") or []

    if measured and target:
        encoded = (render.get("encoded") or {})
        best = next(iter(encoded.values()), None)
        detail = (f"{measured['lufs']:g} LUFS against {target['lufs']:g} ± {target['tolerance']:g}, "
                  f"true peak {measured['truePeakDb']:g} dBTP")
        if best:
            detail += f"; encoded {best['lufs']:g} LUFS / {best['truePeakDb']:g} dBTP"
    else:
        detail = "nothing rendered yet"
    entries = [{
        "method": "tool",
        "by": f"ffmpeg {_ffmpeg_version()} — ebur128 (ITU-R BS.1770) and ffprobe reopening every file",
        "passed": None if not measured else not tool_bad,
        "gate": True,
        "detail": detail if not tool_bad else tool_bad[0]["message"],
    }, {
        "method": "checks",
        "by": "the platforms' published rules and the brief's own claims",
        "passed": None if not delivered and not measured else not rule_bad,
        "gate": True,
        "detail": (rule_bad[0]["message"] if rule_bad
                   else f"{len(delivered)} file(s) delivered, every rule met" if delivered
                   else "not delivered yet"),
    }]
    review = review_result(project)
    if review is None:
        detail, passed = "not run yet — `ep review` writes the evidence", None
    elif review.get("stale"):
        detail = (f"answered before {review['staleBecause']} changed — run `ep review` again "
                  f"and ask a fresh reader")
        passed = None
    else:
        detail = str(review.get("summary")
                     or f"{sum(1 for c in review.get('criteria', []) if c.get('passed'))}"
                        f" of {len(review.get('criteria', []))} criteria met")[:160]
        passed = bool(review.get("passed"))
    entries.append({
        "method": "review",
        "by": "a listening rubric, judged with fresh ears",
        "passed": passed,
        "gate": False,
        "detail": detail,
    })
    return entries


def _ffmpeg_version() -> str:
    proc = ff.run([ff.FFMPEG, "-version"], check=False)
    first = (proc.stdout or "").splitlines()[:1]
    return first[0].split(" ")[2] if first and len(first[0].split(" ")) > 2 else "?"


def run(project: Project, *, deep: bool = True, log=print) -> list[dict]:
    """Every check that can run on what is currently in the workspace."""
    findings: list[dict] = []
    findings += check_plan(project)
    master = project.work / "master.wav"
    if not master.exists():
        findings.append(finding("error", "no_master",
                                "nothing has been rendered yet — run `ep render`"))
        return findings
    duration = float(ff.ffprobe_json(master, "-show_format").get("format", {}).get("duration") or 0.0)
    findings += check_master(project, master, duration, deep=deep, log=log)
    findings += check_chapters(project, duration)
    findings += check_transcript(project, duration)
    findings += check_notes(project, duration)
    findings += check_deliverables(project, duration, log=log)
    return findings


# --------------------------------------------------------------------------- the plan

def check_plan(project: Project) -> list[dict]:
    out: list[dict] = []
    if not project.voice_sources():
        out.append(finding("error", "no_source",
                           "episode.json names no voice source — put the recording in raw/ and run `ep intake`"))
    for source in project.get("sources", []):
        path = project.abs_path(source.get("path", ""))
        if not path.exists():
            out.append(finding("error", "missing_source",
                               f"the source {source.get('path')} is not in the workspace",
                               source.get("id")))
    if not (project.get("title") or "").strip():
        out.append(finding("error", "no_title", "the episode has no title"))
    if not (project.get("summary") or "").strip():
        out.append(finding("warning", "no_summary",
                           "there is no summary; every host asks for one and it is what people read first"))
    if len(project.get("summary") or "") > SUMMARY_LIMIT:
        out.append(finding("error", "summary_too_long",
                           f"the summary is {len(project['summary'])} characters; itunes:summary takes {SUMMARY_LIMIT}"))
    if not project.get("artwork"):
        out.append(finding("warning", "no_artwork",
                           "no artwork: the episode will inherit the show's cover, and Apple wants 1400–3000 px square"))
    wants = project.get("requires") or {}
    if wants.get("durationSeconds"):
        want = float(wants["durationSeconds"])
        got = project.output_duration()
        tolerance = max(30.0, want * 0.1)
        if abs(got - want) > tolerance:
            out.append(finding("error", "duration_claim",
                               f"the brief asks for {fmt_hms(want)} and the edit is {fmt_hms(got)}"))
    if wants.get("chapters") and len(project.get("chapters") or []) < int(wants["chapters"]):
        out.append(finding("error", "chapter_claim",
                           f"the brief asks for {wants['chapters']} chapters and there are "
                           f"{len(project.get('chapters') or [])}"))
    return out


# --------------------------------------------------------------------------- the instrument

def check_master(project: Project, master: Path, duration: float, *, deep: bool, log=print) -> list[dict]:
    out: list[dict] = []
    target = ff.target_from(project.get("target"))
    loud = ff.measure(master)
    off = loud.integrated - target.lufs
    if abs(off) > target.tolerance:
        out.append(finding(
            "error", "loudness_off_target",
            f"the master is {loud.integrated:.1f} LUFS; {target.name} wants {target.lufs:g} "
            f"± {target.tolerance:g} LU ({off:+.1f} LU off)"))
    else:
        out.append(finding("info", "loudness",
                           f"{loud.integrated:.1f} LUFS, inside {target.name}'s ± {target.tolerance:g} LU"))
    if loud.true_peak > target.true_peak + 0.05:
        out.append(finding("error", "true_peak",
                           f"true peak is {loud.true_peak:.1f} dBTP; the ceiling is {target.true_peak:g} dBTP "
                           "— lossy encoding will clip it"))
    if loud.lra > target.lra_max + 1:
        out.append(finding("warning", "loudness_range",
                           f"loudness range is {loud.lra:.1f} LU; above about {target.lra_max:g} LU the quiet "
                           "parts get lost in a car or on a train"))
    if loud.lra < 2.0 and duration > 60:
        out.append(finding("warning", "over_compressed",
                           f"loudness range is only {loud.lra:.1f} LU — this is squashed flat; ease the compressor"))

    project_render = project.get("render") or {}
    project_render["measured"] = loud.as_dict()
    project["render"] = project_render

    if not deep:
        return out

    clipped = ff.levels(master).clipped
    if clipped > 4:
        out.append(finding("error", "clipping",
                           f"{clipped} samples in the master sit at full scale — something is clipped"))
    # Hiss is a property of the voice recording, so it is measured on the session. Measuring the
    # master instead would report a quiet music intro as a noise floor.
    voice_bed = project.work / "session.wav"
    level = ff.levels(voice_bed if voice_bed.exists() else master)
    if level.snr < MIN_SNR_DB:
        out.append(finding("warning", "noise_floor",
                           f"the voices sit only {level.snr:.0f} dB above the room tone "
                           f"({level.speech_db:.0f} against {level.floor_db:.0f} dBFS); under "
                           f"{MIN_SNR_DB:g} dB the hiss is audible between words — raise "
                           "`clean.denoise` on the noisy source, then listen back before going higher"))
    out += check_dead_air(project, master, duration)
    return out


def check_dead_air(project: Project, master: Path, duration: float) -> list[dict]:
    """Silence a listener would notice — but a music cue is not silence, even a quiet one."""
    out: list[dict] = []
    music = [(float(m.get("at") or 0.0),
              float(m.get("at") or 0.0) + (float(m["out"]) - float(m["in"])))
             for m in (project.get("music") or [])]

    def under_music(a: float, b: float) -> bool:
        return any(start - 0.2 <= a and b <= end + 0.2 for start, end in music)

    for start, end in ff.levels(master).silences(min_seconds=0.4):
        gap = end - start
        if under_music(start, end):
            if gap > 1.5:
                out.append(finding("warning", "music_inaudible",
                                   f"the music from {_clock(start)} measures below the silence floor "
                                   f"for {gap:.0f} s — raise its gainDb or it is not really there"))
            continue
        if start <= 0.05:
            if gap > MAX_HEAD_SILENCE:
                out.append(finding("warning", "silence_head",
                                   f"{gap:.1f} s of silence before the first sound — trim the head "
                                   "or put something there"))
        elif end >= duration - 0.05:
            if gap > MAX_TAIL_SILENCE:
                out.append(finding("warning", "silence_tail",
                                   f"{gap:.1f} s of silence after the last word — trim the tail"))
        elif gap > MAX_INTERNAL_SILENCE:
            out.append(finding("warning", "dead_air",
                               f"{gap:.1f} s of dead air at {_clock(start)}", f"{start:.2f}"))
    return out[:8]


# --------------------------------------------------------------------------- the craft's rules

def check_chapters(project: Project, duration: float) -> list[dict]:
    out: list[dict] = []
    raw = project.get("chapters") or []
    if not raw:
        out.append(finding("warning", "no_chapters",
                           "no chapters — listeners cannot skip to a topic and most players show a menu for them"))
        return out
    for chapter in raw:
        if float(chapter.get("start") or 0) >= duration:
            out.append(finding("error", "chapter_past_end",
                               f"chapter \"{chapter.get('title') or 'Chapter'}\" starts at "
                               f"{_clock(float(chapter['start']))}, past the end of the episode "
                               f"({fmt_hms(duration)})"))
    chapters = ordered_chapters(project, duration)
    if not chapters:
        out.append(finding("error", "chapters_out_of_range",
                           f"every chapter starts after the end of the episode ({fmt_hms(duration)})"))
        return out
    if chapters[0]["start"] > 1.0:
        out.append(finding("warning", "chapter_not_at_zero",
                           f"the first chapter starts at {_clock(chapters[0]['start'])}; it should start at 0"))
    seen: set[str] = set()
    for i, chapter in enumerate(chapters):
        length = chapter["end"] - chapter["start"]
        if length < MIN_CHAPTER_SECONDS:
            out.append(finding("error", "chapter_too_short",
                               f"chapter {i + 1} \"{chapter['title']}\" is {length:.0f} s; under "
                               f"{MIN_CHAPTER_SECONDS:g} s players cannot seek to it", _clock(chapter["start"])))
        if len(chapter["title"]) > 128:
            out.append(finding("warning", "chapter_title_long",
                               f"chapter {i + 1}'s title is {len(chapter['title'])} characters; players cut off "
                               "around 40"))
        key = chapter["title"].strip().lower()
        if key in seen:
            out.append(finding("warning", "chapter_title_repeated",
                               f"two chapters are both called \"{chapter['title']}\""))
        seen.add(key)
    for i in range(1, len(chapters)):
        if chapters[i]["start"] <= chapters[i - 1]["start"]:
            out.append(finding("error", "chapters_not_monotonic",
                               f"chapter {i + 1} starts at or before chapter {i}"))
    return out


def check_transcript(project: Project, duration: float) -> list[dict]:
    out: list[dict] = []
    path = project.root / "transcript.json"
    if not path.exists():
        out.append(finding("warning", "no_transcript",
                           "no transcript — it is what makes an episode searchable and accessible"))
        return out
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [finding("error", "transcript_unreadable", f"transcript.json is not valid JSON ({exc})")]
    segments = data.get("segments") or []
    if not segments:
        return [finding("error", "transcript_empty", "transcript.json has no segments")]
    last = 0.0
    long_cues = 0
    for i, seg in enumerate(segments):
        start, end = float(seg.get("start", 0)), float(seg.get("end", 0))
        if end < start:
            out.append(finding("error", "transcript_reversed", f"transcript cue {i + 1} ends before it starts"))
            break
        if start < last - 0.25:
            out.append(finding("error", "transcript_not_monotonic",
                               f"transcript cue {i + 1} starts before the one before it"))
            break
        if end > duration + 1.0:
            out.append(finding("error", "transcript_past_end",
                               f"transcript cue {i + 1} ends at {_clock(end)}, past the episode's "
                               f"{fmt_hms(duration)}"))
            break
        if end - start > CAPTION_MAX_SECONDS:
            long_cues += 1
        last = start
    if long_cues:
        out.append(finding("warning", "transcript_long_cues",
                           f"{long_cues} caption(s) run longer than {CAPTION_MAX_SECONDS:g} s — they will not fit "
                           "on a phone"))
    covered = sum(float(s.get("end", 0)) - float(s.get("start", 0)) for s in segments)
    if duration and covered / duration < 0.55:
        out.append(finding("warning", "transcript_thin",
                           f"the transcript covers {covered / duration:.0%} of the episode; either much of it is "
                           "music, or the model missed speech"))
    texts = [str(s.get("text", "")).strip() for s in segments]
    for i in range(2, len(texts)):
        if texts[i] and texts[i] == texts[i - 1] == texts[i - 2]:
            out.append(finding("warning", "transcript_repeats",
                               f"the same line repeats three times around {_clock(float(segments[i]['start']))} "
                               "— that is usually the model hallucinating over silence"))
            break
    return out


_TIMESTAMP = re.compile(r"\b(\d{1,2}:\d{2}(?::\d{2})?)\b")
_URL = re.compile(r"https?://[^\s)<>\"']+")


def check_notes(project: Project, duration: float) -> list[dict]:
    out: list[dict] = []
    path = project.root / "shownotes.md"
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        out.append(finding("warning", "no_shownotes",
                           "no shownotes.md — the episode description is what a listener reads before pressing play"))
        return out
    text = path.read_text(encoding="utf-8")
    words = len(text.split())
    if words < 60:
        out.append(finding("warning", "shownotes_thin",
                           f"the show notes are {words} words; under about 60 there is nothing for a reader or a "
                           "search engine to work with"))
    chapters = ordered_chapters(project, duration)
    starts = {round(c["start"]) for c in chapters}
    stray = []
    for match in _TIMESTAMP.finditer(text):
        seconds = _parse_clock(match.group(1))
        if seconds > duration + 1:
            stray.append(f"{match.group(1)} is past the end")
        elif chapters and not any(abs(seconds - s) <= 2 for s in starts):
            stray.append(f"{match.group(1)} matches no chapter")
    for message in stray[:4]:
        out.append(finding("warning", "shownotes_timestamp", f"a timestamp in the show notes: {message}"))
    for url in _URL.findall(text):
        if url.endswith((".", ",")) or " " in url:
            out.append(finding("warning", "shownotes_link", f"this link looks broken: {url}"))
    return out


def _parse_clock(text: str) -> float:
    parts = [int(p) for p in text.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def _clock(seconds: float) -> str:
    h, rem = divmod(int(max(0.0, seconds)), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


# --------------------------------------------------------------------------- what was delivered

def check_deliverables(project: Project, duration: float, *, log=print) -> list[dict]:
    out: list[dict] = []
    dist = project.root / "dist"
    if not dist.is_dir() or not any(dist.iterdir()):
        out.append(finding("warning", "not_delivered", "nothing in dist/ yet — run `ep deliver`"))
        return out
    wants = {f.lower() for f in (project.get("output", {}).get("formats") or [])}
    for name in ("mp3", "m4a", "wav", "flac"):
        if name not in wants:
            continue
        pattern = "*.mp3" if name == "mp3" else ("*.m4a" if name in ("m4a", "aac") else f"*.{name}")
        matches = list(dist.glob(pattern))
        if not matches:
            out.append(finding("error", "missing_deliverable",
                               f"episode.json asks for {name} and dist/ has none — run `ep deliver`"))
            continue
        out += check_encoded(project, matches[0], duration, name)
    for want in (project.get("requires") or {}).get("files") or []:
        if not list(dist.glob(want)) and not (project.root / want).exists():
            out.append(finding("error", "missing_requested_file",
                               f"the brief asks for {want} and it is not in dist/"))
    art = project.get("artwork")
    if art:
        out += check_artwork(project)
    return out


def check_encoded(project: Project, path: Path, duration: float, kind: str) -> list[dict]:
    out: list[dict] = []
    rel = f"dist/{path.name}"
    info = ff.ffprobe_json(path, "-show_format", "-show_streams", "-show_chapters")
    audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not audio:
        return [finding("error", "unreadable_deliverable", f"{rel} has no audio stream", rel)]
    got = float(info.get("format", {}).get("duration") or 0.0)
    if abs(got - duration) > 1.5:
        out.append(finding("error", "duration_mismatch",
                           f"{rel} is {fmt_hms(got)} but the master is {fmt_hms(duration)}", rel))
    channels = int(audio.get("channels") or 0)
    rate = int(audio.get("sample_rate") or 0)
    if rate not in (44100, 48000):
        out.append(finding("warning", "sample_rate",
                           f"{rel} is {rate} Hz; podcast hosts expect 44.1 or 48 kHz", rel))
    if kind in ("mp3", "m4a"):
        kbps = int(float(audio.get("bit_rate") or info.get("format", {}).get("bit_rate") or 0)) // 1000
        low, high = BITRATE_RANGE.get(channels, (64, 256))
        if kbps and not (low - 8 <= kbps <= high + 16):
            out.append(finding("warning", "bitrate",
                               f"{rel} is {kbps} kbps for {channels} channel(s); Apple's range is "
                               f"{low}–{high} kbps", rel))
    if kind == "wav":
        # The master is for an editor, not for a feed: no tags, no chapters, no cover expected.
        return out
    # The master is what the levelling aimed at; this is what the platform receives. Lossy
    # encoding moves both numbers a little, and AESTD1008 warns that peak overshoot grows as the
    # bitrate falls — which is only visible if you measure the encoded file.
    target = ff.target_from(project.get("target"))
    loud = ff.measure(path)
    if abs(loud.integrated - target.lufs) > target.tolerance:
        out.append(finding("error", "encoded_loudness",
                           f"{rel} measures {loud.integrated:.1f} LUFS once encoded; {target.name} "
                           f"wants {target.lufs:g} ± {target.tolerance:g} LU", rel))
    if loud.true_peak > target.true_peak + 0.3:
        out.append(finding("warning", "encoded_true_peak",
                           f"{rel} peaks at {loud.true_peak:.1f} dBTP once encoded, above the "
                           f"{target.true_peak:g} dBTP ceiling — lower `target.truePeakDb` by about "
                           f"{loud.true_peak - target.true_peak:.1f} dB and render again", rel))
    project.setdefault_encoded(rel, loud.as_dict())
    chapters_wanted = len(ordered_chapters(project, duration))
    chapters_got = len(info.get("chapters") or [])
    if chapters_wanted and chapters_got != chapters_wanted:
        out.append(finding("error", "chapters_not_embedded",
                           f"{rel} carries {chapters_got} chapters but the episode has {chapters_wanted}", rel))
    tags = {k.lower(): v for k, v in (info.get("format", {}).get("tags") or {}).items()}
    if not tags.get("title"):
        out.append(finding("error", "no_title_tag", f"{rel} has no title tag", rel))
    if project.get("artwork"):
        has_art = any(s.get("codec_type") == "video" for s in info.get("streams", []))
        if not has_art:
            out.append(finding("error", "no_embedded_art", f"{rel} has no embedded cover art", rel))
    if kind == "mp3" and chapters_wanted:
        frames = _id3_frames(path)
        for want in ("CHAP", "CTOC"):
            if want not in frames:
                out.append(finding("error", "no_id3_chapters",
                                   f"{rel} has no ID3v2 {want} frame — players will not show chapters", rel))
        if project.get("artwork") and "APIC" not in frames:
            out.append(finding("error", "no_id3_art", f"{rel} has no ID3v2 APIC cover frame", rel))
    return out


def _id3_frames(path: Path, limit: int = 2_000_000) -> set[str]:
    """Which ID3v2 frame ids the file actually carries — read from the tag, not from ffprobe."""
    with path.open("rb") as fh:
        head = fh.read(10)
        if len(head) < 10 or head[:3] != b"ID3":
            return set()
        size = struct.unpack(">I", bytes([head[6] & 0x7F, head[7] & 0x7F, head[8] & 0x7F, head[9] & 0x7F]))[0]
        body = fh.read(min(size, limit))
    return {m.decode("ascii") for m in re.findall(rb"(?<![A-Z0-9])([A-Z][A-Z0-9]{3})(?=[\x00-\xff]{6})", body)}


def check_artwork(project: Project) -> list[dict]:
    out: list[dict] = []
    src = project.abs_path(project.get("artwork"))
    if not src.exists():
        return [finding("error", "artwork_missing", f"the artwork {project.get('artwork')} is not in the workspace")]
    info = ff.ffprobe_json(src, "-show_streams", "-select_streams", "v")
    stream = (info.get("streams") or [{}])[0]
    width, height = int(stream.get("width") or 0), int(stream.get("height") or 0)
    if width != height:
        out.append(finding("error", "artwork_not_square",
                           f"the artwork is {width}×{height}; podcast artwork must be square"))
    smallest = min(width, height)
    if smallest and smallest < ART_FEED:
        out.append(finding("error", "artwork_too_small",
                           f"the artwork is {width}×{height}; Apple's minimum is {ART_FEED}×{ART_FEED}"))
    elif smallest and smallest < ART_LARGE:
        out.append(finding("info", "artwork_small",
                           f"the artwork is {width}×{height}; {ART_LARGE}×{ART_LARGE} is what featured placement wants"))
    feed = project.root / "dist" / f"cover-{ART_FEED}.jpg"
    if feed.exists() and feed.stat().st_size > 512_000:
        out.append(finding("warning", "artwork_heavy",
                           f"dist/{feed.name} is {feed.stat().st_size // 1024} KB; Apple's ceiling is 512 KB"))
    return out


def summarise(project: Project, findings: list[dict], *, tail: str | None = None) -> tuple[bool, str]:
    """The one line the pane header shows, and the one machine fact behind it."""
    override = tail
    errors = [f for f in findings if f["severity"] == "error"]
    warnings = [f for f in findings if f["severity"] == "warning"]
    render = project.get("render") or {}
    measured = (render.get("measured") or {}).get("lufs")
    duration = render.get("duration")
    bits = []
    if duration:
        bits.append(fmt_hms(duration))
    if measured is not None:
        bits.append(f"{measured:g} LUFS")
    chapters = len(project.get("chapters") or [])
    if chapters:
        bits.append(f"{chapters} chapters")
    head = " · ".join(bits)
    delivered = bool((project.get("delivered") or {}).get("files"))
    gates = [e for e in evaluation(project, findings) if e["gate"]]
    ready = not errors and delivered and all(e["passed"] for e in gates)
    if errors:
        tail = f"{len(errors)} error{'s' if len(errors) != 1 else ''}"
        if warnings:
            tail += f", {len(warnings)} warning{'s' if len(warnings) != 1 else ''}"
    elif warnings:
        tail = f"{len(warnings)} warning{'s' if len(warnings) != 1 else ''}"
    elif ready:
        tail = "ready to publish"
    else:
        tail = "not delivered yet"
    # A failed listening review does not block delivery, but the header must not say everything
    # is fine when the one judgement that used ears says it is not.
    review = review_result(project)
    if review is not None and not review.get("stale") and not review.get("passed"):
        tail += " · the listening review disagrees"
    if override is not None:
        tail = override
    return ready, f"{head} · {tail}" if head else tail
