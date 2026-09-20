"""Everything the person uploads.

The rule here is that nothing leaves this harness in a format only this harness reads: MP3 with
real ID3v2 chapter frames, M4A with MP4 chapters, a 24-bit master, WebVTT, SubRip, the Podcasting
2.0 chapters JSON, HTML show notes and an RSS item ready to paste into a feed.
"""
from __future__ import annotations

import html
import json
import re
import shutil
from pathlib import Path
from urllib.parse import quote

from . import asr, ff, md
from .project import Project
from .render import fmt_hms

#: Apple: artwork 1400-3000 px square, RGB, JPEG or PNG. We write both ends of that range.
ART_LARGE = 3000
ART_FEED = 1400
#: itunes:summary takes 4000 characters; every other tag takes 255.
SUMMARY_LIMIT = 4000


def clock(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


# --------------------------------------------------------------------------- metadata

def ffmetadata(project: Project, duration: float) -> str:
    """The `;FFMETADATA1` file that carries the tags and the chapters into both containers."""
    data = project.data
    ep = data.get("episode") or {}

    def esc(value: str) -> str:
        return re.sub(r"([=;#\\\n])", r"\\\1", str(value or ""))

    lines = [";FFMETADATA1"]
    fields = {
        "title": data.get("title"),
        "album": data.get("show"),
        "artist": data.get("author") or data.get("show"),
        "album_artist": data.get("show"),
        "genre": "Podcast",
        "comment": data.get("summary"),
        "description": data.get("summary"),
        "date": (ep.get("pubDate") or "")[:10],
        "track": ep.get("number"),
        "episode_id": ep.get("guid"),
        "podcast": "1",
    }
    for key, value in fields.items():
        if value not in (None, "", []):
            lines.append(f"{key}={esc(value)}")
    for chapter in ordered_chapters(project, duration):
        lines += [
            "",
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={int(round(chapter['start'] * 1000))}",
            f"END={int(round(chapter['end'] * 1000))}",
            f"title={esc(chapter['title'])}",
        ]
    return "\n".join(lines) + "\n"


def ordered_chapters(project: Project, duration: float) -> list[dict]:
    """Chapters sorted, ends filled in, clamped to the episode — the form everything else wants."""
    raw = sorted(
        ({"start": max(0.0, float(c.get("start") or 0.0)),
          "title": str(c.get("title") or "").strip() or "Chapter",
          "url": c.get("url") or None,
          "img": c.get("img") or None}
         for c in project.get("chapters") or []),
        key=lambda c: c["start"],
    )
    out: list[dict] = []
    for i, chapter in enumerate(raw):
        if chapter["start"] >= duration:
            continue
        end = raw[i + 1]["start"] if i + 1 < len(raw) else duration
        out.append({**chapter, "end": min(max(end, chapter["start"] + 0.001), duration)})
    return out


# --------------------------------------------------------------------------- artwork

def artwork(project: Project, *, log=print) -> dict:
    """Square, RGB, both of Apple's sizes, and the feed copy under its 512 KB ceiling."""
    rel = project.get("artwork") or ""
    if not rel:
        return {}
    src = project.abs_path(rel)
    if not src.exists():
        raise SystemExit(f"miss the artwork {rel} is not in the workspace")
    out: dict[str, str] = {}
    for size, name in ((ART_LARGE, f"cover-{ART_LARGE}.jpg"), (ART_FEED, f"cover-{ART_FEED}.jpg")):
        dest = project.dist / name
        scale = (
            f"scale={size}:{size}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={size}:{size},format=yuvj420p"
        )
        quality = 3
        while True:
            ff.ffmpeg(["-y", "-i", str(src), "-vf", scale, "-frames:v", "1",
                       "-q:v", str(quality), str(dest)])
            if name != f"cover-{ART_FEED}.jpg" or dest.stat().st_size <= 512_000 or quality >= 12:
                break
            quality += 2
        out[str(size)] = f"dist/{name}"
        log(f"     {name} ({dest.stat().st_size // 1024} KB)")
    return out


# --------------------------------------------------------------------------- encoding

def encode(project: Project, master: Path, meta: Path, cover: Path | None, *, log=print) -> list[dict]:
    data = project.data
    output = data.get("output") or {}
    rate = int(output.get("sampleRate", 44100))
    channels = int(output.get("channels", 1))
    formats = [f.lower() for f in (output.get("formats") or ["mp3"])]
    base = project.base_name()
    written: list[dict] = []

    def common(inputs: list[str], extra: list[str], dest: Path) -> None:
        args = ["-y"]
        for path in inputs:
            args += ["-i", path]
        args += extra + [str(dest)]
        ff.ffmpeg(args)

    for fmt in formats:
        if fmt == "mp3":
            dest = project.dist / f"{base}.mp3"
            inputs = [str(master), str(meta)] + ([str(cover)] if cover else [])
            extra = ["-map", "0:a", "-map_metadata", "1", "-map_chapters", "1"]
            if cover:
                extra += ["-map", "2:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic",
                          "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)"]
            extra += ["-c:a", "libmp3lame", "-b:a", f"{int(output.get('mp3Kbps', 96))}k",
                      "-ar", str(rate), "-ac", str(channels),
                      "-id3v2_version", "3", "-write_id3v1", "1"]
            common(inputs, extra, dest)
            written.append(described(dest, "MP3 for the feed — chapters and cover embedded"))
        elif fmt in ("m4a", "aac"):
            dest = project.dist / f"{base}.m4a"
            inputs = [str(master), str(meta)] + ([str(cover)] if cover else [])
            extra = ["-map", "0:a", "-map_metadata", "1", "-map_chapters", "1"]
            if cover:
                extra += ["-map", "2:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic"]
            extra += ["-c:a", "aac", "-b:a", f"{int(output.get('aacKbps', 96))}k",
                      "-ar", str(rate), "-ac", str(channels), "-movflags", "+faststart"]
            common(inputs, extra, dest)
            written.append(described(dest, "AAC in MP4 — Apple Podcasts, Overcast"))
        elif fmt == "wav":
            dest = project.dist / f"{base}-master.wav"
            shutil.copyfile(master, dest)
            written.append(described(dest, "24-bit master — open it in any editor"))
        elif fmt == "flac":
            dest = project.dist / f"{base}.flac"
            common([str(master), str(meta)],
                   ["-map", "0:a", "-map_metadata", "1", "-c:a", "flac",
                    "-ar", str(rate), "-ac", str(channels)], dest)
            written.append(described(dest, "FLAC — lossless archive"))
        else:
            log(f"     (skipping unknown output format '{fmt}')")
    return written


def human(size: int) -> str:
    return f"{size / 1_000_000:.2f} MB" if size >= 1_000_000 else f"{max(1, size // 1000)} KB"


def described(path: Path, note: str) -> dict:
    return {"file": f"dist/{path.name}", "bytes": path.stat().st_size, "note": note}


# --------------------------------------------------------------------------- side files

def chapters_json(project: Project, chapters: list[dict]) -> str:
    data = project.data
    payload = {
        "version": "1.2.0",
        "title": data.get("title") or "",
        "podcastName": data.get("show") or "",
        "author": data.get("author") or "",
        "fileName": f"{project.base_name()}.mp3",
        "chapters": [
            {k: v for k, v in (
                ("startTime", round(c["start"], 3)),
                ("endTime", round(c["end"], 3)),
                ("title", c["title"]),
                ("url", c.get("url")),
                ("img", c.get("img")),
            ) if v is not None}
            for c in chapters
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def rss_item(project: Project, chapters: list[dict], files: list[dict], duration: float,
             notes_html: str) -> str:
    data = project.data
    ep = data.get("episode") or {}
    base = (data.get("link") or "").rstrip("/")
    audio = next((f for f in files if f["file"].endswith(".mp3")), files[0] if files else None)
    name = Path(audio["file"]).name if audio else f"{project.base_name()}.mp3"
    url = f"{base}/{quote(name)}" if base else f"https://example.com/{quote(name)}"
    summary = md.to_plain(data.get("summary") or "")[:SUMMARY_LIMIT]

    def tag(name: str, value: str, cdata: bool = False) -> str:
        if not value:
            return ""
        inner = f"<![CDATA[{value}]]>" if cdata else html.escape(str(value))
        return f"    <{name}>{inner}</{name}>\n"

    out = ["  <item>\n"]
    out.append(tag("title", data.get("title") or "Episode"))
    out.append(tag("guid", ep.get("guid") or ""))
    if ep.get("pubDate"):
        out.append(tag("pubDate", ep["pubDate"]))
    out.append(tag("description", notes_html, cdata=True))
    out.append(tag("itunes:summary", summary))
    out.append(tag("itunes:author", data.get("author") or data.get("show") or ""))
    out.append(tag("itunes:duration", clock(duration)))
    out.append(tag("itunes:episodeType", ep.get("type") or "full"))
    if ep.get("number"):
        out.append(tag("itunes:episode", str(ep["number"])))
    if ep.get("season"):
        out.append(tag("itunes:season", str(ep["season"])))
    out.append(tag("itunes:explicit", "true" if ep.get("explicit") else "false"))
    if data.get("keywords"):
        out.append(tag("itunes:keywords", ", ".join(data["keywords"])))
    if audio:
        out.append(f'    <enclosure url="{html.escape(url, quote=True)}" '
                   f'length="{audio["bytes"]}" type="audio/mpeg" />\n')
    for suffix, mime in ((".vtt", "text/vtt"), (".srt", "application/x-subrip"),
                         (".transcript.json", "application/json")):
        if (project.dist / f"{project.base_name()}{suffix}").exists():
            href = f"{base}/{quote(project.base_name() + suffix)}" if base else \
                   f"https://example.com/{quote(project.base_name() + suffix)}"
            out.append(f'    <podcast:transcript url="{html.escape(href, quote=True)}" '
                       f'type="{mime}" language="{data.get("transcript", {}).get("language") or "en"}" />\n')
    if chapters:
        href = f"{base}/chapters.json" if base else "https://example.com/chapters.json"
        out.append(f'    <podcast:chapters url="{html.escape(href, quote=True)}" '
                   f'type="application/json+chapters" />\n')
    out.append("  </item>\n")
    head = (
        "<!-- Paste this <item> into your feed's <channel>. The feed element needs\n"
        '     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" and\n'
        '     xmlns:podcast="https://podcastindex.org/namespace/1.0".\n'
        "     Replace the example.com URLs with where you actually host the files. -->\n"
    )
    return head + "".join(out)


def report(project: Project, chapters: list[dict], files: list[dict], findings: list[dict]) -> str:
    render = project.get("render") or {}
    measured = render.get("measured") or {}
    target = render.get("target") or {}
    lines = [
        f"# {project.get('title') or 'Episode'} — production report",
        "",
        f"Rendered {render.get('renderedAt', '—')} · duration **{fmt_hms(render.get('duration', 0))}**",
        "",
        "## Loudness",
        "",
        "| | Measured | Target |",
        "|---|---|---|",
        f"| Integrated | **{measured.get('lufs', '—')} LUFS** | {target.get('lufs', '—')} ± {target.get('tolerance', '—')} LU |",
        f"| True peak | **{measured.get('truePeakDb', '—')} dBTP** | ≤ {target.get('truePeakDb', '—')} |",
        f"| Loudness range | {measured.get('lra', '—')} LU | ≤ {target.get('lraMax', '—')} LU |",
        "",
        f"Preset `{target.get('preset', '—')}`. Measured with ffmpeg's `ebur128` (ITU-R BS.1770).",
        "",
    ]
    if chapters:
        lines += ["## Chapters", ""]
        lines += [f"- `{clock(c['start'])}` {c['title']}" for c in chapters]
        lines.append("")
    if files:
        lines += ["## Files", "", "| File | Size | |", "|---|---|---|"]
        for f in files:
            lines.append(f"| `{f['file']}` | {human(f['bytes'])} | {f['note']} |")
        lines.append("")
    errors = [f for f in findings if f["severity"] == "error"]
    warnings = [f for f in findings if f["severity"] == "warning"]
    lines += ["## Checks", ""]
    if not errors and not warnings:
        lines.append("Everything measured is within spec.")
    for finding in errors + warnings:
        lines.append(f"- **{finding['severity']}** {finding['message']}")
    lines.append("")
    return "\n".join(lines)


def notes_markdown(project: Project) -> str:
    path = project.root / "shownotes.md"
    return path.read_text(encoding="utf-8") if path.exists() else ""


def deliver(project: Project, *, log=print) -> dict:
    """Encode and write everything in `dist/`. Returns what was written."""
    master = project.work / "master.wav"
    if not master.exists():
        raise SystemExit("miss there is no master yet — run `ep render` first")
    duration = float(project.get("render", {}).get("duration") or 0.0)
    if not duration:
        duration = float(ff.ffprobe_json(master, "-show_format").get("format", {}).get("duration") or 0.0)
    base = project.base_name()
    chapters = ordered_chapters(project, duration)

    art = artwork(project, log=log)
    cover = project.abs_path(art[str(ART_FEED)]) if art else None

    meta = project.work / "metadata.ffmeta"
    meta.write_text(ffmetadata(project, duration), encoding="utf-8")

    log("     encoding")
    files = encode(project, master, meta, cover, log=log)

    transcript_path = project.root / "transcript.json"
    if transcript_path.exists():
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
        writers = {
            f"{base}.vtt": asr.to_vtt(transcript),
            f"{base}.srt": asr.to_srt(transcript),
            f"{base}.txt": asr.to_text(transcript, chapters),
            f"{base}.transcript.json": asr.to_podcast_json(transcript),
        }
        for name, body in writers.items():
            (project.dist / name).write_text(body, encoding="utf-8")
            files.append(described(project.dist / name, "transcript — podcast:transcript"))

    if chapters:
        (project.dist / "chapters.json").write_text(chapters_json(project, chapters), encoding="utf-8")
        files.append(described(project.dist / "chapters.json",
                               "Podcasting 2.0 chapters — podcast:chapters"))

    notes = notes_markdown(project)
    notes_html = ""
    if notes.strip():
        notes_html = md.to_html(notes)
        (project.dist / "shownotes.html").write_text(notes_html, encoding="utf-8")
        shutil.copyfile(project.root / "shownotes.md", project.dist / "shownotes.md")
        files.append(described(project.dist / "shownotes.html", "show notes — the episode description"))

    if art:
        for size in (ART_LARGE, ART_FEED):
            path = project.dist / f"cover-{size}.jpg"
            if path.exists():
                files.append(described(path, f"artwork {size}×{size} RGB JPEG"))

    xml = rss_item(project, chapters, files, duration, notes_html)
    (project.dist / "episode-item.xml").write_text(xml, encoding="utf-8")
    files.append(described(project.dist / "episode-item.xml", "an <item> to paste into your feed"))

    project["delivered"] = {"files": files, "at": __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    return {"files": files, "chapters": chapters, "duration": duration}
