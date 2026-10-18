#!/usr/bin/env python3
"""Renders `assets/sound/joined.wav`: the onboarding's one sound, when a computer joins.

Two soft glass notes a fifth apart — A5, then E6 110 ms later — each a sine with two quieter,
faster-dying inharmonic partials (the ring of struck glass rather than a beep), a 4 ms attack and
an exponential tail. Mono, 16-bit, 44.1 kHz, about a second: short enough for iOS's System Sound
Services, which play it under the Ring/Silent switch (`ios/Runner/AppDelegate.swift`,
`ChimeChannel`). See `lib/core/chime.dart` and `docs/research/2026-10-11-phone-onboarding`.

    python3 scripts/make_joined_chime.py          # writes assets/sound/joined.wav
"""

import math
import os
import struct
import sys
import wave

RATE = 44100
LENGTH = 1.0  # seconds
PEAK = 0.32  # soft: well under full scale, and the two notes overlap

# (start seconds, fundamental Hz, gain)
NOTES = [
    (0.000, 880.00, 1.00),  # A5
    (0.110, 1318.51, 0.85),  # E6 — a perfect fifth above
]

# Glass: the fundamental, and partials at struck-glass ratios that die out sooner.
PARTIALS = [
    (1.000, 1.00, 0.42),  # (ratio, gain, decay seconds)
    (2.756, 0.22, 0.16),
    (5.404, 0.08, 0.07),
]
ATTACK = 0.004
FADE_OUT = 0.08


def sample(t: float) -> float:
    value = 0.0
    for start, freq, gain in NOTES:
        local = t - start
        if local < 0:
            continue
        attack = min(1.0, local / ATTACK)
        for ratio, partial_gain, decay in PARTIALS:
            value += (
                gain
                * partial_gain
                * attack
                * math.exp(-local / decay)
                * math.sin(2 * math.pi * freq * ratio * local)
            )
    # The tail eased to silence, so the file never ends on a click.
    tail = LENGTH - t
    if tail < FADE_OUT:
        value *= max(0.0, tail / FADE_OUT)
    return value


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "assets", "sound", "joined.wav")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    frames = [sample(i / RATE) for i in range(int(RATE * LENGTH))]
    loudest = max(abs(v) for v in frames) or 1.0
    scale = PEAK / loudest
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(
            b"".join(struct.pack("<h", int(round(v * scale * 32767))) for v in frames)
        )
    sys.stdout.write(f"wrote {out}\n")


if __name__ == "__main__":
    main()
