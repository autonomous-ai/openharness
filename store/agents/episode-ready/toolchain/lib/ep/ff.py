"""Everything that shells out to the package's own ffmpeg and ffprobe.

Nothing here assumes a binary on PATH: both come from the environment the `ep` wrapper sets.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import struct
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

FFMPEG = os.environ.get("EPISODE_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("EPISODE_FFPROBE", "ffprobe")

#: The waveform the pane draws is a min/max pair per bucket at this rate. 50/s is finer than a
#: 1600-pixel pane can show for anything under half an hour, and an hour of it is 360 KB.
PEAK_BUCKETS_PER_SECOND = 50
PEAKS_MAGIC = b"EPWF"


class FfError(RuntimeError):
    """ffmpeg said no. The message is ffmpeg's own last lines, not a stack trace."""


def run(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        tail = "\n".join(line for line in proc.stderr.strip().splitlines()[-6:])
        raise FfError(f"{Path(str(args[0])).name} failed:\n{tail}")
    return proc


def ffmpeg(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    return run([FFMPEG, "-hide_banner", "-nostdin", "-nostats", *args], check=check)


def ffprobe_json(path: str | Path, *extra: str) -> dict:
    proc = run([FFPROBE, "-v", "error", "-print_format", "json", *extra, str(path)])
    return json.loads(proc.stdout or "{}")


# --------------------------------------------------------------------------- measuring

@dataclass
class Loudness:
    """An ITU-R BS.1770 measurement, which is what this whole craft is judged by."""

    integrated: float
    lra: float
    true_peak: float
    threshold: float = 0.0

    def as_dict(self) -> dict:
        return {
            "lufs": round(self.integrated, 2),
            "lra": round(self.lra, 2),
            "truePeakDb": round(self.true_peak, 2),
        }


_SUMMARY = re.compile(
    r"I:\s*(-?[\d.]+|-inf)\s*LUFS.*?LRA:\s*(-?[\d.]+|-inf)\s*LU.*?Peak:\s*(-?[\d.]+|-inf)\s*dBFS",
    re.S,
)


def _num(text: str) -> float:
    return -70.0 if text.startswith("-inf") else float(text)


def measure(path: str | Path) -> Loudness:
    """Integrated loudness, loudness range and true peak, straight from ffmpeg's ebur128."""
    proc = ffmpeg(["-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"], check=False)
    text = proc.stderr
    match = _SUMMARY.search(text[text.rfind("Summary") :] if "Summary" in text else text)
    if not match:
        raise FfError(f"could not measure {Path(str(path)).name}: ffmpeg printed no ebur128 summary")
    return Loudness(_num(match.group(1)), _num(match.group(2)), _num(match.group(3)))


def measure_two_pass(path: str | Path, filters: str, target: "Target") -> dict:
    """Pass one of loudnorm: the measured values pass two needs. Returns ffmpeg's own JSON."""
    chain = f"{filters + ',' if filters else ''}{target.loudnorm()}:print_format=json"
    proc = ffmpeg(["-i", str(path), "-af", chain, "-f", "null", "-"], check=False)
    blocks = re.findall(r"\{[^{}]*\}", proc.stderr, re.S)
    for block in reversed(blocks):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        if "input_i" in data:
            return data
    tail = "\n".join(proc.stderr.strip().splitlines()[-6:])
    raise FfError(f"loudnorm printed no measurement for {Path(str(path)).name}:\n{tail}")


@dataclass
class Target:
    """Where the episode has to land, and how far off it is allowed to be."""

    name: str = "apple"
    lufs: float = -16.0
    tolerance: float = 1.0
    true_peak: float = -1.0
    lra_max: float = 11.0

    def loudnorm(self) -> str:
        return f"loudnorm=I={self.lufs}:TP={self.true_peak}:LRA={self.lra_max}"

    def as_dict(self) -> dict:
        return {
            "preset": self.name,
            "lufs": self.lufs,
            "tolerance": self.tolerance,
            "truePeakDb": self.true_peak,
            "lraMax": self.lra_max,
        }


#: The published targets, with the document each comes from. `ep targets` prints this.
PRESETS: dict[str, dict] = {
    "apple": {
        "lufs": -16.0,
        "tolerance": 1.0,
        "true_peak": -1.0,
        "lra_max": 11.0,
        "why": "Apple Podcasts: around -16 dB LKFS with a +/- 1 dB tolerance, true peak -1 dBFS, "
        "measured per ITU-R BS.1770-5 (podcasters.apple.com/support/893-audio-requirements)",
    },
    "aes-speech": {
        "lufs": -18.0,
        "tolerance": 1.0,
        "true_peak": -1.0,
        "lra_max": 9.0,
        "why": "AESTD1008.1.21-9 Table 1, 'Assorted' content with measurable speech: -18 LUFS, "
        "+1 LU, maximum true peak -1 dBTP at the codec input",
    },
    "spotify": {
        "lufs": -14.0,
        "tolerance": 1.0,
        "true_peak": -1.0,
        "lra_max": 11.0,
        "why": "Spotify normalises to -14 LUFS; delivering at -14 means no gain is applied",
    },
    "ebu-r128": {
        "lufs": -23.0,
        "tolerance": 0.5,
        "true_peak": -1.0,
        "lra_max": 15.0,
        "why": "EBU R128 broadcast: -23 LUFS +/- 0.5 LU, maximum true peak -1 dBTP",
    },
}


def target_from(spec: dict | None) -> Target:
    spec = dict(spec or {})
    preset = spec.get("preset", "apple")
    base = PRESETS.get(preset, PRESETS["apple"])
    return Target(
        name=preset,
        lufs=float(spec.get("lufs", base["lufs"])),
        tolerance=float(spec.get("tolerance", base["tolerance"])),
        true_peak=float(spec.get("truePeakDb", base["true_peak"])),
        lra_max=float(spec.get("lraMax", base["lra_max"])),
    )


# --------------------------------------------------------------------------- probing

@dataclass
class Probe:
    path: str
    duration: float
    sample_rate: int
    channels: int
    codec: str
    bit_rate: int = 0
    lufs: float = 0.0
    lra: float = 0.0
    true_peak: float = 0.0
    noise_floor_db: float = -120.0
    clipped_samples: int = 0
    silences: list[tuple[float, float]] = field(default_factory=list)
    error: str | None = None

    def as_dict(self) -> dict:
        return {
            "path": self.path,
            "duration": round(self.duration, 3),
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "codec": self.codec,
            "bitRate": self.bit_rate,
            "lufs": round(self.lufs, 2),
            "lra": round(self.lra, 2),
            "truePeakDb": round(self.true_peak, 2),
            "noiseFloorDb": round(self.noise_floor_db, 1),
            "clippedSamples": self.clipped_samples,
            "silences": [[round(a, 3), round(b, 3)] for a, b in self.silences],
        }


def probe(path: str | Path, *, silence_min: float = 0.4) -> Probe:
    path = Path(path)
    info = ffprobe_json(path, "-show_format", "-show_streams", "-select_streams", "a")
    streams = info.get("streams") or []
    if not streams:
        raise FfError(f"{path.name} has no audio stream ffmpeg can read")
    stream = streams[0]
    fmt = info.get("format") or {}
    duration = float(stream.get("duration") or fmt.get("duration") or 0.0)
    loud = measure(path)
    level = levels(path)
    silences = level.silences(min_seconds=silence_min)
    return Probe(
        path=str(path),
        duration=duration,
        sample_rate=int(stream.get("sample_rate") or 0),
        channels=int(stream.get("channels") or 0),
        codec=str(stream.get("codec_name") or "?"),
        bit_rate=int(float(stream.get("bit_rate") or fmt.get("bit_rate") or 0)),
        lufs=loud.integrated,
        lra=loud.lra,
        true_peak=loud.true_peak,
        noise_floor_db=level.floor_db,
        clipped_samples=level.clipped,
        silences=silences,
    )


@dataclass
class Levels:
    """One decode of a file, and everything level-related we ask of it.

    ffmpeg's own `silencedetect` measures a short moving average of the *instantaneous* amplitude,
    so hiss — whose peaks sit 10-12 dB above its RMS — reads as continuous signal and nothing is
    ever found. Measured on a track with a -43 dBFS RMS room tone, `silencedetect` at -40 dB found
    zero gaps where there were six. So the gaps are found here instead, from RMS windows, which is
    also what makes the threshold relative to *this* recording's room tone.
    """

    rms: list[float]
    hop: float
    floor_db: float
    speech_db: float
    clipped: int
    duration: float

    @property
    def snr(self) -> float:
        """How far the speech sits above the room tone. This, not the absolute floor, is what
        decides whether a listener hears hiss: a quiet recording levelled up brings its noise
        with it."""
        return round(self.speech_db - self.floor_db, 1)

    def threshold(self) -> float:
        """Quieter than this is silence: above this recording's room tone, below its speech."""
        return round(min(-28.0, max(-60.0, max(self.floor_db + 6.0, self.speech_db - 26.0))), 1)

    def silences(self, min_seconds: float = 0.4, threshold_db: float | None = None) -> list[tuple[float, float]]:
        limit = self.threshold() if threshold_db is None else threshold_db
        spans: list[tuple[float, float]] = []
        start: int | None = None
        for i, value in enumerate(self.rms):
            if value < limit:
                if start is None:
                    start = i
            elif start is not None:
                if (i - start) * self.hop >= min_seconds:
                    spans.append((start * self.hop, i * self.hop))
                start = None
        if start is not None and (len(self.rms) - start) * self.hop >= min_seconds:
            spans.append((start * self.hop, min(self.duration, len(self.rms) * self.hop)))
        return spans


_LEVELS_CACHE: dict[tuple[str, int, float], Levels] = {}


def levels(path: str | Path, *, hop: float = 0.1) -> Levels:
    """Decode once at 16 kHz mono and measure everything the level checks need."""
    path = Path(path)
    try:
        key = (str(path), path.stat().st_size, path.stat().st_mtime)
    except OSError:
        key = (str(path), 0, 0.0)
    cached = _LEVELS_CACHE.get(key)
    if cached is not None:
        return cached
    rate = 16000
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1",
         "-ar", str(rate), "-f", "s16le", "-"],
        capture_output=True,
    )
    raw = proc.stdout
    total = len(raw) // 2
    if not total:
        raise FfError(f"could not decode any audio from {path.name}")
    size = max(1, int(rate * hop))
    windows: list[float] = []
    clipped = 0
    for start in range(0, total - size + 1, size):
        chunk = struct.unpack_from(f"<{size}h", raw, start * 2)
        acc = 0.0
        for v in chunk:
            acc += float(v) * v
            if v >= 32700 or v <= -32700:
                clipped += 1
        mean = acc / size
        windows.append(-120.0 if mean <= 0 else 20.0 * math.log10(math.sqrt(mean) / 32768.0))
    ordered = sorted(windows)
    floor_db = ordered[max(0, len(ordered) // 20)] if ordered else -120.0
    speech_db = ordered[min(len(ordered) - 1, int(len(ordered) * 0.85))] if ordered else -120.0
    out = Levels(rms=windows, hop=hop, floor_db=round(floor_db, 1), speech_db=round(speech_db, 1),
                 clipped=clipped, duration=total / rate)
    _LEVELS_CACHE[key] = out
    return out


def noise_floor(path: str | Path) -> float:
    """dBFS of this recording's room tone: what a listener hears between the words."""
    return levels(path).floor_db


def clipped_samples(path: str | Path) -> int:
    """Samples sitting at the rails — a mic that was driven too hard."""
    return levels(path).clipped


def detect_silence(path: str | Path, noise_db: float | None = None,
                   min_seconds: float = 0.4) -> list[tuple[float, float]]:
    """The gaps, as (start, end) pairs. `noise_db` defaults to this recording's own threshold."""
    return levels(path).silences(min_seconds=min_seconds, threshold_db=noise_db)


# --------------------------------------------------------------------------- the waveform

def write_peaks(src: str | Path, dest: str | Path, *, buckets_per_second: int = PEAK_BUCKETS_PER_SECOND) -> int:
    """Min/max pairs for the pane's waveform: EPWF, one signed byte each, drawn straight to canvas.

    Computed here rather than in the browser because an hour of 44.1 kHz stereo is 600 MB of
    AudioBuffer and 360 KB of this.
    """
    rate = 8000
    proc = subprocess.Popen(
        [FFMPEG, "-hide_banner", "-nostdin", "-v", "error", "-i", str(src), "-ac", "1",
         "-ar", str(rate), "-f", "s16le", "-"],
        stdout=subprocess.PIPE,
    )
    per_bucket = max(1, rate // buckets_per_second)
    mins = bytearray()
    maxs = bytearray()
    carry = b""
    assert proc.stdout is not None
    while True:
        block = proc.stdout.read(per_bucket * 2 * 64)
        if not block:
            break
        block = carry + block
        usable = (len(block) // (per_bucket * 2)) * per_bucket * 2
        carry = block[usable:]
        for off in range(0, usable, per_bucket * 2):
            chunk = struct.unpack_from(f"<{per_bucket}h", block, off)
            lo, hi = min(chunk), max(chunk)
            mins.append((max(-127, lo // 258)) & 0xFF)
            maxs.append((min(127, hi // 258)) & 0xFF)
    proc.wait()
    count = len(mins)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with tmp.open("wb") as fh:
        fh.write(PEAKS_MAGIC)
        fh.write(struct.pack("<HHI", 1, buckets_per_second, count))
        pairs = bytearray(count * 2)
        pairs[0::2] = mins
        pairs[1::2] = maxs
        fh.write(pairs)
    tmp.replace(dest)
    return count


_SHORT_TERM = re.compile(r"lavfi\.r128\.S=(-?[\d.]+|-inf)")


def loudness_contour(path: str | Path, step: float = 0.5) -> list[float]:
    """Short-term (3 s) loudness every `step` seconds — the line drawn over the waveform."""
    proc = run(
        [FFPROBE, "-v", "error", "-f", "lavfi", "-i",
         f"amovie={_lavfi_escape(str(path))},ebur128=metadata=1",
         "-show_entries", "frame_tags=lavfi.r128.S", "-of", "compact=p=0:nk=1"],
        check=False,
    )
    values: list[float] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            values.append(-70.0 if line.startswith("-inf") else float(line))
        except ValueError:
            continue
    if not values:
        return []
    # ebur128 emits one frame per 100 ms; thin it to `step`.
    every = max(1, int(round(step / 0.1)))
    return [round(v, 2) for v in values[::every]]


def _lavfi_escape(path: str) -> str:
    return path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace(",", "\\,")


def band_balance(path: str | Path, start: float, duration: float) -> dict:
    """Speech level and tone for one stretch, so "is this speaker duller or further away?" is
    answered in the evidence instead of by hand.

    Two numbers a podcast editor actually uses: the speech level, and presence — how much energy
    sits at 3-10 kHz against the body of the voice at 300-1000 Hz. A microphone across the room
    loses presence before it loses level, so a stretch that is level-matched can still sound far
    away, and only this shows it.
    """
    def energy(low: int, high: int) -> float:
        proc = ffmpeg(["-ss", f"{max(0.0, start):.3f}", "-t", f"{duration:.3f}", "-i", str(path),
                       "-af", f"highpass=f={low}:poles=2,lowpass=f={high}:poles=2,volumedetect",
                       "-f", "null", "-"], check=False)
        match = re.search(r"mean_volume:\s*(-?[\d.]+) dB", proc.stderr)
        return float(match.group(1)) if match else -120.0

    body = energy(300, 1000)
    presence = energy(3000, 10000)
    # The level of *this stretch*, from the windows that fall inside it.
    measured = levels(path)
    first = int(max(0.0, start) / measured.hop)
    last = min(len(measured.rms), int((max(0.0, start) + duration) / measured.hop))
    window = [v for v in measured.rms[first:last] if v > -90]
    loud = sorted(window)[int(len(window) * 0.6):] if window else []
    return {
        "bodyDb": round(body, 1),
        "presenceDb": round(presence, 1),
        "presenceOverBody": round(presence - body, 1),
        "levelDb": round(sum(loud) / len(loud), 1) if loud else -120.0,
    }


def have_tools() -> list[str]:
    missing = []
    for name, binary in (("ffmpeg", FFMPEG), ("ffprobe", FFPROBE)):
        if not (Path(binary).exists() or shutil.which(binary)):
            missing.append(name)
    return missing
