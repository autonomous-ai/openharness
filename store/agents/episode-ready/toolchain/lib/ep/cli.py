"""`ep` — the only command this harness's agent needs.

Every subcommand leaves the workspace in a state the pane can draw, and writes
`.harness/verdict.json` before it returns, so the header moves while the work happens.
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path

from . import asr, checks, ff, verdict
from . import deliver as deliver_mod
from . import render as render_mod
from .project import PHASES, Project, blank, discover, slug
from .render import fmt_hms

USAGE = """ep — produce a podcast episode

  ep intake [files…]        read every recording in raw/ (or the files named), measure it, and
                            write it into episode.json. Run this first.
  ep cuts [--max-gap S]     turn the silences into an edit: dead air out, breathing room kept
  ep render                 clean, assemble and level to the target; writes work/master.wav
  ep transcribe [--model M] transcribe the master with the episode's vocabulary
  ep fix "wrong=right" …    correct a misheard word everywhere in the transcript
  ep deliver                encode dist/: MP3, M4A, master, captions, chapters, notes, RSS item
  ep check [--quick]        measure everything and write the verdict
  ep review                 gather the evidence a fresh reader needs for what only ears can judge
  ep phase <id> [--note]    move the pane's header to a stage before you start it
  ep targets                the loudness targets and where each one comes from
  ep set key=value …        change episode.json from the command line (dotted keys)
  ep selftest               prove the toolchain works end to end on two seconds of tone
"""


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    command, rest = argv[0], argv[1:]
    handlers = {
        "intake": cmd_intake, "cuts": cmd_cuts, "render": cmd_render,
        "transcribe": cmd_transcribe, "fix": cmd_fix, "deliver": cmd_deliver, "check": cmd_check,
        "review": cmd_review, "phase": cmd_phase, "targets": cmd_targets, "set": cmd_set,
        "selftest": cmd_selftest, "demo-build": cmd_demo_build, "peaks": cmd_peaks,
    }
    handler = handlers.get(command)
    if handler is None:
        print(f"miss '{command}' is not an ep command.\n\n{USAGE}", file=sys.stderr)
        return 2
    try:
        return handler(rest)
    except SystemExit as exc:
        if isinstance(exc.code, str):
            print(exc.code, file=sys.stderr)
            return 1
        raise
    except ff.FfError as exc:
        print(f"miss {exc}", file=sys.stderr)
        return 1


def _project() -> Project:
    return Project.load()


def _say(*parts) -> None:
    print(*parts, flush=True)


# --------------------------------------------------------------------------- intake

def cmd_intake(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ep intake", add_help=True)
    parser.add_argument("files", nargs="*", help="recordings to read; default is everything in raw/")
    parser.add_argument("--music", action="append", default=[],
                        help="a file that is music, not speech (theme, sting, bed)")
    parser.add_argument("--layout", choices=("auto", "parallel", "sequential"), default="auto",
                        help="parallel: one file per speaker, recorded at the same time (the "
                             "default for a remote-recording service). sequential: separate takes "
                             "played one after another.")
    args = parser.parse_args(argv)

    project = _project()
    project.set_phase("intake")
    verdict.write(project, summary="reading the recordings")

    found, art = discover(project.root)
    # The workspace opens on a worked example. As soon as one recording that is not part of it
    # appears, the example is somebody else's episode: its audio, title, chapters, notes and
    # transcript go to .harness/history/ and this becomes a new episode. Enforced here rather
    # than left to anyone to remember, because the example leaking into a person's episode is
    # the worst thing this harness could do.
    if project.get("example"):
        theirs = [p for p in found
                  if str(p.relative_to(project.root)) not in {s.get("path") for s in project.get("sources", [])}]
        if theirs:
            _retire_example(project)
            _say("ok   your own recording is here, so the worked example has been put away in "
                 ".harness/history/example/ — this is your episode now")
            found, art = discover(project.root)
    named = [project.abs_path(f) for f in args.files] if args.files else found
    music = {Path(m).name for m in args.music}
    if not named:
        raise SystemExit("miss there is nothing in raw/ — put the recording there "
                         "(wav, mp3, m4a, flac, aiff, mov… anything ffmpeg reads)")

    sources = []
    for path in named:
        if not path.exists():
            raise SystemExit(f"miss {path} is not in the workspace")
        rel = str(path.relative_to(project.root)) if path.is_relative_to(project.root) else str(path)
        role = "music" if (path.name in music or "theme" in path.stem.lower()
                           or "music" in path.stem.lower() or "sting" in path.stem.lower()) else "voice"
        _say(f"     measuring {rel}")
        info = ff.probe(path)
        existing = next((s for s in project.get("sources", []) if s.get("path") == rel), {})
        source = {
            "id": existing.get("id") or slug(path.stem, fallback=f"source{len(sources) + 1}"),
            "path": rel,
            "role": existing.get("role", role),
            "gainDb": existing.get("gainDb", 0),
            "probe": info.as_dict(),
        }
        sources.append(source)
        note = (f"{fmt_hms(info.duration)} · {info.lufs:.1f} LUFS · peak {info.true_peak:.1f} dBTP · "
                f"floor {info.noise_floor_db:.0f} dBFS · {info.channels}ch {info.sample_rate} Hz")
        _say(f"ok   {rel} — {note}")
        if info.clipped_samples > 4:
            _say(f"     ⚠ {info.clipped_samples} clipped samples: this mic was driven too hard. "
                 f"Add \"adeclip\" by setting this source's clean.declip, and expect to hear it.")
        if role == "voice":
            level = ff.levels(path)
            source["probe"]["snrDb"] = level.snr
            source["probe"]["speechDb"] = level.speech_db
            if level.snr < 36:
                repair = {"denoise": _denoise_for(level.snr)}
                if level.snr < 30:
                    # Denoising thins the hiss under the voice; a gate takes it out of the gaps.
                    # Measured on a 19 dB track: denoise alone reached 25 dB, denoise plus this
                    # gate reached 37 dB. Halfway up from the floor, so word endings survive.
                    repair["gateDb"] = round(level.floor_db + 0.55 * (level.speech_db - level.floor_db))
                source.setdefault("clean", {}).update(repair)
                extra = f" and clean.gateDb={repair['gateDb']}" if "gateDb" in repair else ""
                _say(f"     ⚠ speech sits only {level.snr:.0f} dB above this track's room tone "
                     f"({level.speech_db:.0f} against {level.floor_db:.0f} dBFS). Set "
                     f"clean.denoise={repair['denoise']}{extra} for it, then listen to the ends "
                     f"of words before going further.")

    # A workspace opens on a worked example. The moment the material is different material, the
    # example's title, show, chapters, notes and transcript are somebody else's episode — clear
    # them here rather than trusting anyone to remember.
    was = {s.get("path") for s in project.get("sources", [])}
    now = {s["path"] for s in sources}
    if was and not (was & now):
        _clear_previous(project)
        _say("ok   different material — the previous episode's title, chapters, notes and "
             "transcript have been put in .harness/history/ and cleared")

    voices = [s for s in sources if s["role"] == "voice"]
    layout = args.layout
    if layout == "auto":
        lengths = [float(s["probe"]["duration"]) for s in voices] or [0.0]
        # Files of much the same length are two sides of one conversation; very different
        # lengths are separate takes meant to play one after another.
        layout = "parallel" if len(voices) < 2 or min(lengths) >= 0.6 * max(lengths) else "sequential"
    cursor = 0.0
    for source in voices:
        source["offsetSec"] = 0.0 if layout == "parallel" else round(cursor, 3)
        cursor += float(source["probe"]["duration"])
    if len(voices) > 1:
        _say(f"ok   treating {len(voices)} voice tracks as {layout}"
             + (" (one conversation, mixed together)" if layout == "parallel"
                else " (separate takes, one after another)")
             + f" — override with `ep intake --layout "
               f"{'sequential' if layout == 'parallel' else 'parallel'}`")

    project["sources"] = sources
    project["voice"] = []
    project["removed"] = []
    if art and not project.get("artwork"):
        project["artwork"] = str(art[0].relative_to(project.root))
        _say(f"ok   artwork {project['artwork']}")
    if not project.get("title"):
        project["title"] = ""
    episode = project.data.setdefault("episode", {})
    if not episode.get("guid"):
        episode["guid"] = str(uuid.uuid4())

    project.save()
    session = project.session_duration()
    before = render_mod.build_before(project, log=_say)
    if before is not None:
        ff.write_peaks(before, project.work / "before.peaks")
    verdict.write(project, summary=f"{len(sources)} source(s) · {fmt_hms(session)} of tape",
                  findings=checks.check_plan(project))
    _say(f"ok   {len(sources)} source(s), a {fmt_hms(session)} session. Next: `ep cuts`, then set "
         f"the title and the target in episode.json.")
    return 0


# --------------------------------------------------------------------------- cuts

def cmd_cuts(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ep cuts")
    parser.add_argument("--max-gap", type=float, default=1.2,
                        help="a silence longer than this is shortened (seconds, default 1.2)")
    parser.add_argument("--keep", type=float, default=0.35,
                        help="breathing room left where a gap was cut (seconds, default 0.35)")
    parser.add_argument("--no-head-trim", action="store_true", help="leave the silence at the front alone")
    parser.add_argument("--restore", type=int, default=None, help="put one removed range back (its index)")
    args = parser.parse_args(argv)

    project = _project()
    project.set_phase("cut")
    if args.restore is not None:
        removed = project.get("removed") or []
        if not 0 <= args.restore < len(removed):
            raise SystemExit(f"miss there is no removed range {args.restore} (there are {len(removed)})")
        gone = removed.pop(args.restore)
        project["removed"] = removed
        project["voice"] = _restore(project.voice_clips(), gone)
        project.save()
        _say(f"ok   restored the session from {gone['start']:.1f}s to {gone['end']:.1f}s")
    else:
        if not project.voice_sources():
            raise SystemExit("miss no voice source yet — run `ep intake` first")
        render_mod.propose_cuts(project, max_gap=args.max_gap, keep=args.keep,
                                head_trim=not args.no_head_trim, log=_say)
        project.save()
    kept = project.voice_length()
    verdict.write(project, summary=f"edit is {fmt_hms(kept)} · {len(project.get('removed') or [])} cuts")
    _say(f"ok   the edit is {fmt_hms(kept)}. Next: `ep render`.")
    return 0


def _retire_example(project: Project) -> None:
    """Move the shipped example out of the way, audio and all, and start a blank episode."""
    home = project.root / ".harness" / "history" / "example"
    home.mkdir(parents=True, exist_ok=True)
    for source in project.get("sources", []):
        path = project.abs_path(source.get("path", ""))
        if path.exists() and path.is_relative_to(project.root):
            target = home / path.name
            path.replace(target)
    for name in ("transcript.json", "shownotes.md", "episode.json"):
        path = project.root / name
        if path.exists():
            __import__("shutil").copy2(path, home / name)
    _clear_previous(project)


def _clear_previous(project: Project) -> None:
    """Start a new episode in this workspace, keeping only the settings that are the person's
    (the loudness target, the repair defaults, the encoding), never the previous episode's words."""
    history = project.root / ".harness" / "history"
    history.mkdir(parents=True, exist_ok=True)
    stamp = __import__("datetime").datetime.now().strftime("%Y%m%d-%H%M%S")
    for name in ("transcript.json", "shownotes.md"):
        path = project.root / name
        if path.exists():
            path.replace(history / f"{stamp}-{name}")
    dist = project.root / "dist"
    if dist.is_dir():
        for item in dist.iterdir():
            if item.is_file():
                item.unlink()
    for item in project.work.glob("*"):
        if item.is_file():
            item.unlink()
    fresh = blank()
    keep = {k: project.data.get(k) for k in ("target", "clean", "link")}
    output = dict(fresh["output"])
    for key in ("sampleRate", "channels", "mp3Kbps", "aacKbps"):
        if key in (project.get("output") or {}):
            output[key] = project["output"][key]
    project.data.clear()
    project.data.update(fresh)
    for key, value in keep.items():
        if value:
            project.data[key] = value
    project.data["output"] = output
    project.data["episode"]["guid"] = str(uuid.uuid4())


def _denoise_for(snr_db: float) -> int:
    """How hard to lean on the denoiser for a given signal-to-noise, erring on the gentle side.
    `afftdn` stops gaining much above about 26 dB of reduction, so that is the ceiling."""
    if snr_db < 20:
        return 26
    if snr_db < 26:
        return 20
    if snr_db < 32:
        return 15
    return 12


def _restore(clips: list[dict], gone: dict) -> list[dict]:
    """Put one removed range back into the kept ranges, then close up any seam it leaves."""
    out = [dict(c) for c in clips]
    out.append({"in": float(gone["start"]), "out": float(gone["end"])})
    out.sort(key=lambda c: float(c["in"]))
    return _merge(out)


def _merge(clips: list[dict]) -> list[dict]:
    out: list[dict] = []
    for clip in clips:
        if out and abs(float(out[-1]["out"]) - float(clip["in"])) < 0.01:
            out[-1] = {**out[-1], "out": float(clip["out"])}
        else:
            out.append(dict(clip))
    return out


# --------------------------------------------------------------------------- render

def cmd_render(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ep render")
    parser.add_argument("--target", help="apple | aes-speech | spotify | ebu-r128, or a LUFS number")
    args = parser.parse_args(argv)

    project = _project()
    if args.target:
        project["target"] = _target_spec(args.target)
    project.set_phase("level")
    verdict.write(project, summary="cleaning and levelling")
    result = render_mod.render(project, log=_say)
    project.save()
    measured = result["measured"]
    target = result["target"]
    state = "on target" if result["inTolerance"] else "OFF TARGET"
    _say(f"ok   {fmt_hms(result['duration'])} · {measured['lufs']} LUFS ({state}, {target['preset']} wants "
         f"{target['lufs']} ± {target['tolerance']}) · true peak {measured['truePeakDb']} dBTP · "
         f"LRA {measured['lra']} LU")
    findings = checks.check_master(project, project.work / "master.wav", result["duration"],
                                   deep=False, log=_say)
    ready, summary = checks.summarise(project, findings)
    verdict.write(project, summary=summary, findings=findings, artifact="work/master.wav")
    _say("     Next: chapters into episode.json, then `ep transcribe`.")
    return 0


def _target_spec(text: str) -> dict:
    try:
        return {"preset": "custom", "lufs": float(text)}
    except ValueError:
        if text not in ff.PRESETS:
            raise SystemExit(f"miss '{text}' is not a target. Try: {', '.join(ff.PRESETS)} or a LUFS number")
        return {"preset": text}


# --------------------------------------------------------------------------- transcribe

def cmd_transcribe(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ep transcribe")
    parser.add_argument("--model", default=None, help="base.en (default), small.en, medium.en, large-v3…")
    parser.add_argument("--language", default=None, help="en by default; 'auto' to detect")
    parser.add_argument("--vocabulary", default=None,
                        help="comma-separated names and jargon to spell correctly")
    args = parser.parse_args(argv)

    project = _project()
    master = project.work / "master.wav"
    if not master.exists():
        raise SystemExit("miss there is no master to transcribe — run `ep render` first")
    settings = dict(project.get("transcript") or {})
    if args.model:
        settings["model"] = args.model
    if args.language:
        settings["language"] = args.language
    if args.vocabulary:
        settings["vocabulary"] = [v.strip() for v in args.vocabulary.split(",") if v.strip()]

    project.set_phase("transcribe")
    duration = float(project.get("render", {}).get("duration") or 0)
    verdict.write(project, summary=f"transcribing {fmt_hms(duration)} with {settings.get('model', 'base.en')}"
                                   " (about a seventh of the running time)")
    result = asr.transcribe(master, model=settings.get("model", "base.en"),
                            language=settings.get("language", "en"),
                            vocabulary=settings.get("vocabulary") or [], log=_say)
    (project.root / "transcript.json").write_text(
        json.dumps(result, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    settings["model"] = result["model"]
    settings["language"] = result["language"]
    project["transcript"] = settings
    project.save()
    words = sum(len(s.get("words") or []) for s in result["segments"])
    findings = checks.check_transcript(project, duration or result["duration"])
    verdict.write(project, summary=f"{len(result['segments'])} cues · {words} words", findings=findings)
    _say(f"ok   {len(result['segments'])} cues, {words} words → transcript.json")
    _say("     Next: chapter titles and shownotes.md, then `ep deliver`.")
    return 0


def cmd_fix(argv: list[str]) -> int:
    """Correct what the model misheard. A name wrong in 40 places is one command, not 40 edits."""
    if not argv:
        raise SystemExit('miss `ep fix` takes "wrong=right" pairs, e.g. ep fix "nuclear board=nucleo board"')
    project = _project()
    path = project.root / "transcript.json"
    if not path.exists():
        raise SystemExit("miss there is no transcript.json to fix — run `ep transcribe` first")
    transcript = json.loads(path.read_text(encoding="utf-8"))
    pairs = []
    for pair in argv:
        if "=" not in pair:
            raise SystemExit(f'miss "{pair}" is not wrong=right')
        wrong, right = pair.split("=", 1)
        pairs.append((wrong.strip(), right.strip()))
    hits = asr.replace_terms(transcript, pairs)
    path.write_text(json.dumps(transcript, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    # Remember it, so a re-transcribe does not undo the correction.
    settings = dict(project.get("transcript") or {})
    vocab = list(settings.get("vocabulary") or [])
    for _, right in pairs:
        if right not in vocab:
            vocab.append(right)
    settings["vocabulary"] = vocab
    project["transcript"] = settings
    project.save()
    _say(f"ok   {hits} cue(s) corrected. Re-run `ep deliver` to rewrite the captions.")
    return 0


# --------------------------------------------------------------------------- deliver

def cmd_deliver(argv: list[str]) -> int:
    argparse.ArgumentParser(prog="ep deliver").parse_args(argv)
    project = _project()
    project.set_phase("deliver")
    verdict.write(project, summary="encoding the files to upload")
    result = deliver_mod.deliver(project, log=_say)
    project.save()
    findings = checks.run(project, log=_say)
    ready, summary = checks.summarise(project, findings)
    mp3 = next((f for f in result["files"] if f["file"].endswith(".mp3")), None)
    verdict.write(project, summary=summary, findings=findings, ready=ready,
                  artifact=mp3["file"] if mp3 else "work/master.wav", done=ready)
    (project.dist / "report.md").write_text(
        deliver_mod.report(project, result["chapters"], result["files"], findings), encoding="utf-8")
    for item in result["files"]:
        _say(f"ok   {item['file']:<44} {deliver_mod.human(item['bytes']):>9}  {item['note']}")
    _say(f"ok   {summary}")
    return 0 if ready else 0


# --------------------------------------------------------------------------- check / review

def cmd_check(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ep check")
    parser.add_argument("--quick", action="store_true", help="skip the slow sample-level checks")
    parser.add_argument("--json", action="store_true", help="print the findings as JSON")
    args = parser.parse_args(argv)
    project = _project()
    findings = checks.run(project, deep=not args.quick, log=_say)
    ready, summary = checks.summarise(project, findings)
    project.save()
    artifact = None
    for candidate in sorted((project.root / "dist").glob("*.mp3")):
        artifact = f"dist/{candidate.name}"
        break
    verdict.write(project, summary=summary, findings=findings, ready=ready,
                  artifact=artifact or "work/master.wav", done=ready)
    entries = checks.evaluation(project, findings)
    if args.json:
        print(json.dumps({"ready": ready, "summary": summary, "findings": findings,
                          "evaluation": entries}, indent=2))
        return 0
    for f in findings:
        if f["severity"] == "info":
            continue
        print(f"{f['severity']:<8}{f['message']}")
    for entry in entries:
        mark = "?" if entry["passed"] is None else ("\u2713" if entry["passed"] else "\u2717")
        word = {"tool": "Verified by", "checks": "Checked against", "review": "Reviewed against"}[entry["method"]]
        gate = "" if entry["gate"] else "  (advisory)"
        print(f"{mark}  {word} {entry['by']} — {entry['detail']}{gate}")
    print(("ok   " if ready else "     ") + summary)
    return 0 if not any(f["severity"] == "error" for f in findings) else 1


def cmd_review(argv: list[str]) -> int:
    """Everything a fresh pair of ears needs, so the judgement call is made on evidence."""
    parser = argparse.ArgumentParser(prog="ep review")
    parser.add_argument("--out", default="work/review", help="where the evidence goes")
    args = parser.parse_args(argv)
    project = _project()
    out = project.abs_path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    master = project.work / "master.wav"
    if not master.exists():
        raise SystemExit("miss there is no master to review — run `ep render` first")
    duration = float(project.get("render", {}).get("duration") or 0)
    transcript = {}
    path = project.root / "transcript.json"
    if path.exists():
        transcript = json.loads(path.read_text(encoding="utf-8"))

    lines = [f"# Listening evidence — {project.get('title') or 'episode'}", "",
             f"Master `work/master.wav`, {fmt_hms(duration)}.", "",
             "Each clip below is six seconds of the master, written out so it can be listened to.",
             ""]
    moments: list[tuple[str, float]] = []
    cursor = float(project.get("voiceOffset") or 0.0)
    for i, clip in enumerate(project.voice_clips()[:-1]):
        cursor += float(clip["out"]) - float(clip["in"])
        moments.append((f"splice-{i + 1}", cursor))
    for i, chapter in enumerate(deliver_mod.ordered_chapters(project, duration)):
        moments.append((f"chapter-{i + 1}", chapter["start"]))
    seen: set[int] = set()
    for name, at in moments[:14]:
        key = int(at)
        if key in seen:
            continue
        seen.add(key)
        start = max(0.0, at - 3.0)
        dest = out / f"{name}.wav"
        ff.ffmpeg(["-y", "-ss", f"{start:.3f}", "-t", "6", "-i", str(master),
                   "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", str(dest)])
        said = " ".join(s["text"] for s in transcript.get("segments", [])
                        if float(s["end"]) > start and float(s["start"]) < start + 6)
        lines += [f"## {name} at {deliver_mod.clock(at)}", "",
                  f"`{dest.relative_to(project.root)}`", "",
                  f"> {said.strip() or '(no transcript here)'}", ""]
    # Every kept range, measured the way an editor listens: level, and presence against body.
    # A speaker matched in level but 8 dB down in presence is the one who sounds across the room.
    cursor = float(project.get("voiceOffset") or 0.0)
    rows = []
    for clip in project.voice_clips():
        length = float(clip["out"]) - float(clip["in"])
        band = ff.band_balance(master, cursor, min(length, 20.0))
        rows.append((deliver_mod.clock(cursor), deliver_mod.clock(cursor + length),
                     clip.get("note") or "", band))
        cursor += length
    if rows:
        ranked = sorted(rows, key=lambda r: r[3]["presenceOverBody"])
        dullest, brightest = ranked[0], ranked[-1]
        spread = brightest[3]["presenceOverBody"] - dullest[3]["presenceOverBody"]
        lines += ["## Is everyone in the same room?", "",
                  "Presence is 3–10 kHz against 300–1000 Hz. A microphone further away loses "
                  "presence before it loses level, so a stretch that matches in level can still "
                  "sound distant. More than about 6 dB between speakers is audible.", "",
                  f"Widest gap: **{spread:.1f} dB** — {dullest[0]} "
                  f"({dullest[2] or 'no note'}, {dullest[3]['presenceOverBody']:+.1f} dB) against "
                  f"{brightest[0]} ({brightest[2] or 'no note'}, "
                  f"{brightest[3]['presenceOverBody']:+.1f} dB). Applause and music read bright; "
                  "compare the speech stretches with each other.", "",
                  "| from | to | note | speech level | presence − body |", "|---|---|---|---|---|"]
        for start, end, note, band in rows:
            lines.append(f"| {start} | {end} | {note or '—'} | {band['levelDb']:.0f} dB | "
                         f"{band['presenceOverBody']:+.1f} dB |")
        lines.append("")

    chapters = deliver_mod.ordered_chapters(project, duration)
    if chapters and transcript:
        lines += ["## Does each chapter title describe its chapter?", ""]
        for chapter in chapters:
            said = " ".join(s["text"] for s in transcript.get("segments", [])
                            if float(s["start"]) >= chapter["start"] and float(s["start"]) < chapter["end"])
            lines += [f"**{deliver_mod.clock(chapter['start'])} — {chapter['title']}**", "",
                      f"> {said[:700].strip() or '(nothing transcribed in this chapter)'}", ""]
    notes = deliver_mod.notes_markdown(project)
    if notes:
        lines += ["## Do the show notes say anything the episode does not?", "",
                  "Show notes as written:", "", "```", notes.strip(), "```", ""]
    (out / "REVIEW.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    # What this evidence is evidence about, so a review that arrives after the next change is
    # not mistaken for a review of it.
    answer_dir = project.root / ".harness" / "review"
    answer_dir.mkdir(parents=True, exist_ok=True)
    (answer_dir / "context.json").write_text(
        json.dumps(checks.review_fingerprint(project), indent=1), encoding="utf-8")
    findings = checks.run(project, deep=False, log=lambda *a: None)
    ready, summary = checks.summarise(
        project, findings, tail=f"a fresh listener is going through {len(seen)} clips")
    verdict.write(project, summary=summary, findings=findings, ready=ready)
    _say(f"ok   listening evidence in {out.relative_to(project.root)}/REVIEW.md "
         f"({len(seen)} clips). Read it with fresh ears, or hand it to a fresh agent.")
    return 0


# --------------------------------------------------------------------------- small commands

def cmd_phase(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ep phase")
    parser.add_argument("id")
    parser.add_argument("--note", default="")
    args = parser.parse_args(argv)
    project = _project()
    project.set_phase(args.id)
    project.save()
    name = dict(PHASES)[args.id]
    verdict.write(project, summary=args.note or f"{name}…")
    _say(f"ok   {name}" + (f" — {args.note}" if args.note else ""))
    return 0


def cmd_targets(argv: list[str]) -> int:
    argparse.ArgumentParser(prog="ep targets").parse_args(argv)
    for name, spec in ff.PRESETS.items():
        print(f"{name:<12} {spec['lufs']:>6g} LUFS  ± {spec['tolerance']:g} LU   true peak "
              f"{spec['true_peak']:g} dBTP")
        print(f"             {spec['why']}")
        print()
    return 0


def cmd_set(argv: list[str]) -> int:
    if not argv:
        raise SystemExit("miss `ep set` takes key=value pairs, e.g. ep set title='Episode 14' target.preset=aes-speech")
    project = _project()
    for pair in argv:
        if "=" not in pair:
            raise SystemExit(f"miss '{pair}' is not key=value")
        key, raw = pair.split("=", 1)
        node = project.data
        parts = key.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = raw
        node[parts[-1]] = value
        _say(f"ok   {key} = {json.dumps(value, ensure_ascii=False)}")
    project.save()
    verdict.write(project, summary=checks.summarise(project, [])[1])
    return 0


def cmd_peaks(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ep peaks")
    parser.add_argument("source")
    parser.add_argument("dest")
    args = parser.parse_args(argv)
    count = ff.write_peaks(args.source, args.dest)
    _say(f"ok   {count} buckets → {args.dest}")
    return 0


# --------------------------------------------------------------------------- selftest & demo

def cmd_selftest(argv: list[str]) -> int:
    """Two seconds of tone through the whole pipeline: the check doctor runs."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "raw").mkdir()
        tone = root / "raw" / "tone.wav"
        ff.ffmpeg(["-y", "-f", "lavfi", "-i", "sine=f=220:d=2:r=44100", "-ac", "1",
                   "-c:a", "pcm_s16le", str(tone)])
        project = Project(root, blank("Self test"))
        project["sources"] = [{"id": "tone", "path": "raw/tone.wav", "role": "voice",
                               "offsetSec": 0.0, "probe": ff.probe(tone).as_dict()}]
        project["chapters"] = [{"start": 0, "title": "Self test"}]
        project.save()
        render_mod.render(project, log=lambda *a: None)
        project.save()
        deliver_mod.deliver(project, log=lambda *a: None)
        mp3 = next(iter((root / "dist").glob("*.mp3")), None)
        assert mp3 and mp3.stat().st_size > 1000, "no mp3 came out"
        info = ff.ffprobe_json(mp3, "-show_chapters")
        assert len(info.get("chapters") or []) == 1, "the mp3 has no chapter"
        loud = ff.measure(project.work / "master.wav")
        assert abs(loud.integrated - (-16.0)) <= 1.5, f"levelling landed at {loud.integrated}"
    _say("ok   selftest passed: tone → cleaned → levelled → MP3 with a chapter")
    return 0


def cmd_demo_build(argv: list[str]) -> int:
    """Produce the worked example a new workspace opens on. Run once, at install."""
    if len(argv) != 2:
        raise SystemExit("miss usage: ep demo-build <source-audio> <destination-folder>")
    src, dest = Path(argv[0]), Path(argv[1])
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "raw").mkdir(exist_ok=True)
    (dest / "art").mkdir(exist_ok=True)
    clip = dest / "raw" / "to-write-or-not-to-write.mp3"
    # The first 105 seconds: the title, LibriVox's own credit, and the opening of the essay.
    # Long enough to be a real episode shape, short enough that the pane opens instantly.
    ff.ffmpeg(["-y", "-t", "105", "-i", str(src), "-c:a", "copy", str(clip)])
    cover = dest / "art" / "cover.png"
    _demo_cover(cover)

    project = Project(dest, blank())
    project["example"] = True
    project["title"] = "To Write or Not To Write"
    project["show"] = "Episode Ready — worked example"
    project["author"] = "Susan Andrews Rice · read for LibriVox"
    project["summary"] = (
        "A worked example, so this pane is not empty before your first recording. The audio is a "
        "public-domain LibriVox reading of Susan Andrews Rice's 1892 essay; it arrived at -23.1 LUFS with a "
        "-0.7 dBFS true peak, and Episode Ready cut the dead air, levelled it to Apple's -16 LUFS, "
        "chaptered it, transcribed it and wrote these notes. Put your own recording in raw/ and ask "
        "for the episode you want."
    )
    project["artwork"] = "art/cover.png"
    project["target"] = {"preset": "apple"}
    project["output"] = {"sampleRate": 44100, "channels": 1, "mp3Kbps": 96, "aacKbps": 96,
                         "formats": ["mp3"]}
    project["transcript"] = {"model": "base.en", "language": "en",
                             "vocabulary": ["To Write or Not To Write", "Susan Andrews Rice",
                                            "LibriVox", "The Writer"]}
    project.save()

    project["sources"] = [{"id": "reading", "path": "raw/to-write-or-not-to-write.mp3",
                           "role": "voice", "gainDb": 0, "offsetSec": 0.0,
                           "probe": ff.probe(clip).as_dict()}]
    render_mod.propose_cuts(project, log=lambda *a: None)
    project.save()
    render_mod.render(project, log=lambda *a: None)
    duration = float(project["render"]["duration"])
    result = asr.transcribe(project.work / "master.wav", model="base.en", language="en",
                            vocabulary=project["transcript"]["vocabulary"], log=lambda *a: None)
    (dest / "transcript.json").write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n",
                                          encoding="utf-8")
    # Chapters land on a sentence, not on a percentage: the same rule the skill teaches.
    def at(phrase: str, fraction: float) -> float:
        hit = next((float(s["start"]) for s in result["segments"]
                    if phrase.lower() in str(s["text"]).lower()), None)
        if hit is not None:
            return round(hit, 2)
        starts = [float(s["start"]) for s in result["segments"]]
        return round(min(starts, key=lambda s: abs(s - duration * fraction)), 2) if starts else 0.0
    project["chapters"] = [
        {"start": 0.0, "title": "Title and credits"},
        {"start": at("clamoring", 0.30), "title": "Thoughts clamouring for utterance"},
        {"start": at("two literary factions", 0.62), "title": "The two factions"},
    ]
    project.save()
    (dest / "shownotes.md").write_text(_demo_notes(project, duration), encoding="utf-8")
    project.set_phase("deliver")
    project.save()
    deliver_mod.deliver(project, log=lambda *a: None)
    findings = checks.run(project, deep=False, log=lambda *a: None)
    ready, summary = checks.summarise(project, findings)
    project.save()
    verdict.write(project, summary=summary, findings=findings, ready=ready, done=ready,
                  artifact=f"dist/{project.base_name()}.mp3")
    (dest / "dist" / "report.md").write_text(
        deliver_mod.report(project, deliver_mod.ordered_chapters(project, duration),
                           (project.get("delivered") or {}).get("files") or [], findings),
        encoding="utf-8")
    _say(f"ok   demo episode built: {summary}")
    return 0


def _demo_cover(dest: Path) -> None:
    """A plain, honest cover made by the toolchain itself — no stock art, no borrowed mark."""
    ff.ffmpeg([
        "-y", "-f", "lavfi", "-i", "color=c=0x101418:s=3000x3000",
        "-f", "lavfi", "-i", "color=c=0xE8703A:s=3000x3000",
        "-filter_complex",
        "[1:v]geq=lum='if(lt(hypot(X-1500,Y-1500),1020)*gt(hypot(X-1500,Y-1500),992),255,0)':cb=128:cr=128[ring];"
        "[0:v][ring]overlay=0:0:format=rgb,"
        "drawbox=x=1180:y=1180:w=640:h=640:color=0xE8703A@1:t=fill,"
        "format=rgb24[out]",
        "-map", "[out]", "-frames:v", "1", str(dest),
    ])


def _demo_notes(project: Project, duration: float) -> str:
    chapters = project.get("chapters") or []
    lines = [
        f"# {project['title']}",
        "",
        project["summary"],
        "",
        "## Chapters",
        "",
    ]
    for chapter in chapters:
        lines.append(f"- **{deliver_mod.clock(chapter['start'])}** — {chapter['title']}")
    lines += [
        "",
        "## What happened to this file",
        "",
        "- Read in from `raw/`, measured: **-23.1 LUFS**, true peak **-0.7 dBFS**, 22.05 kHz mono.",
        "- Dead air shortened, leaving a third of a second of air at every join.",
        "- High-passed, de-noised, de-essed and gently compressed.",
        "- Levelled in two passes to Apple Podcasts' **-16 LUFS** with a **-1 dBTP** ceiling.",
        "- Transcribed with Whisper `base.en`, chaptered, tagged, and encoded into `dist/`.",
        "",
        "## Credit",
        "",
        "The recording is *To Write or Not To Write* by Susan Andrews Rice, read for "
        "[LibriVox](https://librivox.org) in Short Nonfiction Collection Vol. 013 and in the public "
        "domain. It is here as an example; delete `raw/` and put your own recording in its place.",
        "",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
