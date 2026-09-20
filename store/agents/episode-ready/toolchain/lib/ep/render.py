"""Turning the plan into audio.

Four passes, in this order, because that is the order a studio works in and because peak control
has to come after filtering (AESTD1008 §7B: filtering adds overshoot, so the limiter goes last):

  1. **before**   every voice source summed at its offset, untouched — what the person handed in,
                  so the pane can A/B against it
  2. **session**  each source repaired once and matched to the others in level, then summed:
                  one timeline of the recording as it happened
  3. **assemble** the kept ranges of that session joined, with the music placed over the top and
                  ducked under speech
  4. **level**    two passes of loudnorm onto the target, then the master

One pass of loudnorm lands about 1.5 LU off the target; two lands inside Apple's ±1 dB. Never one.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from . import ff
from .project import Project, plan_hash

#: Equal-power joins at every splice: short enough to be inaudible, long enough to kill the click.
JOIN_FADE = 0.012
#: Voice sources are matched to each other at this working level before the final normalisation,
#: with plain gain so nobody's dynamics get squashed twice.
WORKING_LUFS = -19.0


def fmt_hms(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h, rem = divmod(int(round(seconds)), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _relative(project: Project, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path(project.root).resolve()))
    except ValueError:
        return str(path)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- repair

def clean_chain(settings: dict, *, noise_floor_db: float | None = None) -> str:
    """The repair chain for one voice. Gentle by default: over-processing is the usual failure —
    a gate that eats word endings, a denoiser that leaves a metallic voice.

    Two things about `afftdn` that only show up when you measure it. Its `nf` is the noise floor
    it assumes, so it has to be told this recording's own, not a constant: on a track with a
    -50 dBFS floor, `nf=-35` reached -52.8 dBFS and `nf=-50` reached -56.6. And `tn=1` (noise
    tracking) *weakens* it on the stationary hiss of a room — it adapts the estimate and under-
    reduces. Tracking is for noise that changes; a room does not.
    """
    parts: list[str] = []
    hp = settings.get("highpassHz")
    if hp:
        parts.append(f"highpass=f={int(hp)}")
    if settings.get("declip"):
        parts.append("adeclip")
    if settings.get("declick"):
        parts.append("adeclick")
    nr = settings.get("denoise")
    if nr:
        floor = settings.get("noiseFloorDb", noise_floor_db)
        nf = -35.0 if floor is None else max(-80.0, min(-20.0, float(floor)))
        chain = f"afftdn=nr={float(nr):g}:nf={nf:g}"
        if settings.get("trackNoise"):
            chain += ":tn=1"
        parts.append(chain)
    gate = settings.get("gateDb")
    if gate is not None:
        parts.append(f"agate=threshold={10 ** (float(gate) / 20):.6f}:ratio=2:attack=10:release=250")
    de = settings.get("deesser")
    if de:
        parts.append(f"deesser=i={float(de):g}")
    comp = settings.get("compressor") or {}
    if comp:
        parts.append(
            "acompressor=threshold={t}dB:ratio={r}:attack={a}:release={rel}:makeup={m}".format(
                t=comp.get("thresholdDb", -20), r=comp.get("ratio", 3),
                a=comp.get("attackMs", 15), rel=comp.get("releaseMs", 250),
                m=comp.get("makeupDb", 2)))
    return ",".join(parts)


def _fingerprint(path: Path, settings: dict, extra: str = "") -> str:
    stat = path.stat()
    blob = json.dumps(settings, sort_keys=True) + f"|{stat.st_size}|{int(stat.st_mtime)}|{extra}"
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def clean_source(project: Project, source: dict, *, log=print) -> Path:
    """Repair one source into work/clean-<id>.wav, reusing it when nothing has changed."""
    src = project.abs_path(source["path"])
    settings = {**project.get("clean", {}), **(source.get("clean") or {})}
    rate = int(project.get("output", {}).get("sampleRate", 44100))
    floor = (source.get("probe") or {}).get("noiseFloorDb")
    stamp = _fingerprint(src, settings, extra=f"r{rate}|nf{floor}")
    dest = project.work / f"clean-{source['id']}.wav"
    marker = project.work / f"clean-{source['id']}.stamp"
    if dest.exists() and marker.exists() and marker.read_text().strip() == stamp:
        return dest
    chain = clean_chain(settings, noise_floor_db=floor)
    log(f"     cleaning {source['id']} ({Path(source['path']).name})")
    ff.ffmpeg(["-y", "-i", str(src), "-af", f"{chain + ',' if chain else ''}aresample={rate}",
               "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s24le", str(dest)])
    marker.write_text(stamp)
    return dest


def match_gain(source: dict, cleaned: Path) -> float:
    """Plain gain bringing this voice to the working level, so two speakers sit together.

    Capped so the loudest peak keeps a decibel of room; the final limiter is not a level tool.
    """
    loud = ff.measure(cleaned)
    if loud.integrated <= -69:
        return 0.0
    gain = WORKING_LUFS - loud.integrated
    headroom = -1.0 - (loud.true_peak + gain)
    if headroom < 0:
        gain += headroom
    return round(gain + float(source.get("gainDb") or 0.0), 2)


# --------------------------------------------------------------------------- the session

def _mix(inputs: list[tuple[str, float, float]], dest: Path, rate: int, *, limit: bool) -> None:
    """Sum some files, each delayed to its offset and given a gain."""
    graph: list[str] = []
    labels: list[str] = []
    for i, (_, offset, gain) in enumerate(inputs):
        steps = [f"aresample={rate}", "aformat=channel_layouts=mono"]
        if abs(gain) > 0.01:
            steps.append(f"volume={gain:.2f}dB")
        if offset > 0:
            steps.append(f"adelay={int(offset * 1000)}:all=1")
        graph.append(f"[{i}:a]{','.join(steps)}[s{i}]")
        labels.append(f"[s{i}]")
    if len(labels) > 1:
        graph.append(f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0[sum]")
        last = "[sum]"
    else:
        last = labels[0]
    graph.append(f"{last}alimiter=limit=0.97:level=false[out]" if limit else f"{last}anull[out]")
    args = ["-y"]
    for path, _, _ in inputs:
        args += ["-i", path]
    args += ["-filter_complex", ";".join(graph), "-map", "[out]",
             "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s24le", str(dest)]
    ff.ffmpeg(args)


def build_session(project: Project, *, log=print) -> Path:
    """Every voice source repaired, matched and laid at its offset: one timeline to cut."""
    rate = int(project.get("output", {}).get("sampleRate", 44100))
    voices = project.voice_sources()
    if not voices:
        raise SystemExit("miss episode.json names no voice source — put the recording in raw/ and "
                         "run `ep intake`")
    parts: list[tuple[str, float, float]] = []
    for source in voices:
        cleaned = clean_source(project, source, log=log)
        gain = match_gain(source, cleaned)
        source["matchGainDb"] = gain
        parts.append((str(cleaned), float(source.get("offsetSec") or 0.0), gain))
    dest = project.work / "session.wav"
    if len(voices) > 1:
        spread = max(abs(p[2]) for p in parts)
        log(f"     matching {len(voices)} voices (up to {spread:.1f} dB apart) and mixing the session")
    _mix(parts, dest, rate, limit=True)
    return dest


def build_before(project: Project, *, log=print) -> Path | None:
    """The 'before' side of the pane's A/B: the recording as it arrived.

    With one source that is the file itself — no point writing a 13 MB copy of it. With several,
    they are summed at their offsets with nothing done to them.
    """
    voices = project.voice_sources()
    if not voices:
        return None
    if len(voices) == 1 and not float(voices[0].get("offsetSec") or 0.0):
        return project.abs_path(voices[0]["path"])
    rate = int(project.get("output", {}).get("sampleRate", 44100))
    dest = project.work / "before.wav"
    stamp = project.work / "before.stamp"
    key = hashlib.sha256(
        "|".join(f"{s['path']}:{s.get('offsetSec', 0)}" for s in voices).encode()).hexdigest()[:16]
    if dest.exists() and stamp.exists() and stamp.read_text().strip() == key:
        return dest
    _mix([(str(project.abs_path(s["path"])), float(s.get("offsetSec") or 0.0), 0.0) for s in voices],
         dest, rate, limit=False)
    stamp.write_text(key)
    return dest


# --------------------------------------------------------------------------- the edit

def assemble(project: Project, session: Path, *, log=print) -> Path:
    """The kept ranges joined, the music over the top, ducked under the voices."""
    rate = int(project.get("output", {}).get("sampleRate", 44100))
    clips = project.voice_clips()
    if not clips:
        raise SystemExit("miss there is nothing to assemble: the edit keeps no part of the session")

    inputs: list[str] = [str(session)]
    music_index: dict[str, int] = {}
    music_items = list(project.get("music") or [])
    for item in music_items:
        source = project.source(item["source"])
        if source is None:
            raise SystemExit(f"miss a music cue names a source that is not in episode.json: "
                             f"{item['source']}")
        if source["id"] not in music_index:
            music_index[source["id"]] = len(inputs)
            inputs.append(str(project.abs_path(source["path"])))

    graph: list[str] = []
    labels: list[str] = []
    for i, clip in enumerate(clips):
        start, end = float(clip["in"]), float(clip["out"])
        length = end - start
        fade = min(JOIN_FADE, length / 3)
        steps = [f"atrim=start={start:.4f}:end={end:.4f}", "asetpts=N/SR/TB",
                 f"afade=t=in:st=0:d={fade:.4f}",
                 f"afade=t=out:st={max(0.0, length - fade):.4f}:d={fade:.4f}"]
        # A microphone further away loses presence before it loses level, so matching the level
        # of a distant speaker leaves them sounding duller than everyone else. A peaking lift
        # around 4.5 kHz is what an editor reaches for, and it has to be per range because one
        # room mic carries every speaker.
        presence = float(clip.get("presenceDb") or 0.0)
        if abs(presence) > 0.05:
            steps.append(f"equalizer=f=4500:width_type=o:width=1.8:g={presence:.2f}")
        warmth = float(clip.get("warmthDb") or 0.0)
        if abs(warmth) > 0.05:
            steps.append(f"equalizer=f=220:width_type=o:width=1.4:g={warmth:.2f}")
        gain = float(clip.get("gainDb") or 0.0)
        if abs(gain) > 0.01:
            steps.append(f"volume={gain:.2f}dB")
        graph.append(f"[0:a]{','.join(steps)}[v{i}]")
        labels.append(f"[v{i}]")

    offset = float(project.get("voiceOffset") or 0.0)
    graph.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[voicecat]")
    graph.append(f"[voicecat]adelay={int(offset * 1000)}:all=1[voice]"
                 if offset > 0 else "[voicecat]anull[voice]")

    ducking = [m for m in music_items if m.get("duck", True)]
    if ducking:
        graph.append(f"[voice]asplit={len(ducking) + 1}[voiceout]"
                     + "".join(f"[duck{i}]" for i in range(len(ducking))))
        mix_labels = ["[voiceout]"]
    else:
        mix_labels = ["[voice]"]

    duck_n = 0
    for i, item in enumerate(music_items):
        source = project.source(item["source"])
        length = float(item["out"]) - float(item["in"])
        if length <= 0:
            continue
        steps = [f"atrim=start={float(item['in']):.4f}:end={float(item['out']):.4f}",
                 "asetpts=N/SR/TB", f"aresample={rate}", "aformat=channel_layouts=mono"]
        fade_in, fade_out = float(item.get("fadeIn") or 0.0), float(item.get("fadeOut") or 0.0)
        if fade_in > 0:
            steps.append(f"afade=t=in:st=0:d={fade_in:.3f}")
        if fade_out > 0:
            steps.append(f"afade=t=out:st={max(0.0, length - fade_out):.3f}:d={fade_out:.3f}")
        gain = float(item.get("gainDb") or 0.0)
        if abs(gain) > 0.01:
            steps.append(f"volume={gain:.2f}dB")
        at = float(item.get("at") or 0.0)
        if at > 0:
            steps.append(f"adelay={int(at * 1000)}:all=1")
        graph.append(f"[{music_index[source['id']]}:a]{','.join(steps)}[m{i}]")
        if item.get("duck", True):
            graph.append(
                f"[m{i}][duck{duck_n}]sidechaincompress="
                f"threshold={10 ** (float(item.get('duckThresholdDb', -30)) / 20):.5f}:"
                f"ratio={float(item.get('duckRatio', 8)):g}:attack=25:release=450:makeup=1[md{i}]")
            duck_n += 1
            mix_labels.append(f"[md{i}]")
        else:
            mix_labels.append(f"[m{i}]")

    if len(mix_labels) > 1:
        graph.append(f"{''.join(mix_labels)}amix=inputs={len(mix_labels)}:duration=longest:"
                     f"normalize=0[mixed]")
        final = "[mixed]"
    else:
        final = mix_labels[0]
    graph.append(f"{final}aresample={rate},alimiter=limit=0.97:level=false[out]")

    dest = project.work / "assembled.wav"
    args = ["-y"]
    for path in inputs:
        args += ["-i", path]
    args += ["-filter_complex", ";".join(graph), "-map", "[out]",
             "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s24le", str(dest)]
    log(f"     assembling {len(labels)} range(s)"
        + (f" and {len(music_items)} music cue(s)" if music_items else ""))
    ff.ffmpeg(args)
    return dest


def level(project: Project, assembled: Path, *, log=print) -> tuple[Path, ff.Loudness]:
    """Two passes of loudnorm onto the target, then measure what actually came out."""
    target = ff.target_from(project.get("target"))
    rate = int(project.get("output", {}).get("sampleRate", 44100))
    log(f"     measuring for {target.name} ({target.lufs:g} LUFS, true peak {target.true_peak:g} dBTP)")
    measured = ff.measure_two_pass(assembled, "", target)
    chain = (f"{target.loudnorm()}"
             f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
             f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
             f":offset={measured['target_offset']}:linear=true")
    dest = project.work / "master.wav"
    log("     levelling")
    ff.ffmpeg(["-y", "-i", str(assembled), "-af", f"{chain},aresample={rate}",
               "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s24le", str(dest)])
    return dest, ff.measure(dest)


def render(project: Project, *, log=print) -> dict:
    """Repair, mix, cut, level, and draw the waveforms the pane shows."""
    before = build_before(project, log=log)
    session = build_session(project, log=log)
    assembled = assemble(project, session, log=log)
    master, loud = level(project, assembled, log=log)
    log("     drawing the waveform")
    ff.write_peaks(master, project.work / "master.peaks")
    if before is not None:
        peaks = project.work / "before.peaks"
        if not peaks.exists() or peaks.stat().st_mtime < before.stat().st_mtime:
            ff.write_peaks(before, peaks)
    (project.work / "contour.json").write_text(
        json.dumps({"step": 0.5, "values": ff.loudness_contour(master)}), encoding="utf-8")
    duration = float(ff.ffprobe_json(master, "-show_format").get("format", {}).get("duration") or 0.0)
    target = ff.target_from(project.get("target"))
    result = {
        "master": "work/master.wav",
        "before": _relative(project, before) if before else None,
        "sessionDuration": round(project.session_duration(), 3),
        "duration": round(duration, 3),
        "measured": loud.as_dict(),
        "target": target.as_dict(),
        "inTolerance": abs(loud.integrated - target.lufs) <= target.tolerance,
        "truePeakOk": loud.true_peak <= target.true_peak + 0.05,
        "renderedAt": _now(),
        "planHash": plan_hash(project.data),
    }
    project["render"] = result
    return result


# --------------------------------------------------------------------------- cuts

def propose_cuts(project: Project, *, max_gap: float = 1.2, keep: float = 0.35,
                 head_trim: bool = True, log=print) -> dict:
    """Read the silence out of the *session* and turn it into kept ranges.

    Silence on the session means nobody is speaking, so a cut takes the gap out of every track at
    once. Gaps are shortened to `keep` seconds of breathing room rather than removed outright: a
    join with no air left in it is how you can hear that a machine did the edit.
    """
    session = project.work / "session.wav"
    if not session.exists():
        session = build_session(project, log=log)
    duration = float(ff.ffprobe_json(session, "-show_format").get("format", {}).get("duration") or 0.0)
    # The threshold sits above this recording's own room tone and below its speech, or a hissy
    # track reads as continuous talking and nothing is ever cut.
    level = ff.levels(session)
    threshold = level.threshold()
    log(f"     room tone {level.floor_db:.0f} dBFS, speech {level.speech_db:.0f} dBFS, "
        f"so silence is quieter than {threshold:g} dBFS")
    spans = level.silences(min_seconds=0.4)
    voice: list[dict] = []
    removed: list[dict] = []
    cursor = 0.0
    for start, end in spans:
        if end - start < max_gap:
            continue
        at_head, at_tail = start <= 0.05, end >= duration - 0.05
        if at_head and head_trim:
            cut_from, cut_to = 0.0, max(0.0, end - keep)
        elif at_tail:
            cut_from, cut_to = min(duration, start + keep), duration
        else:
            pad = keep / 2
            cut_from, cut_to = start + pad, max(start + pad, end - pad)
        if cut_to - cut_from < 0.15:
            continue
        if cut_from > cursor:
            voice.append({"in": round(cursor, 3), "out": round(cut_from, 3)})
        removed.append({"start": round(cut_from, 3), "end": round(cut_to, 3), "reason": "dead air"})
        cursor = cut_to
    if cursor < duration:
        voice.append({"in": round(cursor, 3), "out": round(duration, 3)})
    voice = [c for c in voice if c["out"] - c["in"] > 0.05]
    project["voice"] = voice
    project["removed"] = removed
    saved = sum(r["end"] - r["start"] for r in removed)
    log(f"     {len(removed)} gap(s), {fmt_hms(saved)} of dead air out; "
        f"{fmt_hms(duration - saved)} kept in {len(voice)} range(s)")
    return {"clips": len(voice), "removed": len(removed), "secondsRemoved": round(saved, 2)}
