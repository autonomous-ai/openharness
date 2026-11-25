#!/usr/bin/env python3
"""A synthetic speech-like signal, so the voice gate's tests need no recorded voice.

    python3 devices/harness-device/firmware/test/voice_signal.py   # prints table(), fails unless it equals TABLE

Levels are as the dial's ES7210 records them at its old top gain of 37.5 dB. A lower gain scales the signal before
the ADC, as the chip's PGA does, so loud speech that clips at 37.5 dB can come through whole at 30 dB.
table_signal() is the design doc's own script (docs/plans/2026-11-25-dial-voice-clip-and-touch-design.md): it must
stay as written, because TABLE is that doc's table and pins it to the digit.
"""

import math
import random

RATE = 16000


def scale(gain_db): return 10 ** ((gain_db - 37.5) / 20)
def laplacian(rng, n): return [rng.choice((-1, 1)) * rng.expovariate(1.0) for _ in range(n)]  # E|x| = 1
def adc(x, k=1.0): return [max(-32768, min(32767, round(v * k))) for v in x]


def rms(x): return math.sqrt(sum(v * v for v in x) / len(x))


def table_signal():  # 4 s, a 4 Hz syllable envelope, a pause each 2 s
    n = RATE * 4
    env = [max(0.0, math.sin(2 * math.pi * 4 * i / RATE)) ** 2 * (0 if (i // (RATE // 2)) % 4 == 3 else 1) for i in range(n)]
    return [e * v for e, v in zip(env, laplacian(random.Random(7), n))]


def table():
    """(RMS at 37.5 dB, gain, peak, RMS, clipped samples per mille) for each level and gain of the design doc."""
    x = table_signal()
    rows = []
    for t in (2800, 4200, 5000, 5458):
        for g in (37.5, 30, 27):
            y = adc(x, t / rms(x) * scale(g))
            clipped = sum(1 for v in y if v in (32767, -32768))
            rows.append((t, g, max(abs(v) for v in y), round(rms(y)), round(1000 * clipped / len(y), 2)))
    return rows


TABLE = [
    (2800, 37.5, 32768, 2790, 0.16), (2800, 30, 19375, 1181, 0), (2800, 27, 13717, 836, 0),
    (4200, 37.5, 32768, 4096, 1.45), (4200, 30, 29063, 1771, 0), (4200, 27, 20575, 1254, 0),
    (5000, 37.5, 32768, 4775, 3.2), (5000, 30, 32767, 2108, 0.02), (5000, 27, 24494, 1493, 0),
    (5458, 37.5, 32768, 5140, 4.22), (5458, 30, 32768, 2300, 0.05), (5458, 27, 26737, 1629, 0),
]

FLOOR, VOICE = 141, 1750  # the dial's self-noise, RMS about 200 at 37.5 dB; speech whose 20 ms frames' 90th percentile is about 2400


def sources():  # float samples at 37.5 dB, before the ADC
    rng = random.Random(2511); s = lambda sec: round(sec * RATE)
    floor = lambda n: [FLOOR * v for v in laplacian(rng, n)]
    voice = lambda n: [VOICE * (0.6 + 0.4 * math.sin(math.pi * 4 * i / RATE) ** 2) * v for i, v in enumerate(laplacian(rng, n))]
    words = [0.0] * s(0.15) + voice(s(0.4)) + [0.0] * s(0.1) + voice(s(0.4)) + [0.0] * s(0.15)
    room = floor(len(words))
    tap = floor(s(0.3))
    for i, v in enumerate(laplacian(rng, s(0.03))): tap[s(0.1) + i] += 12000 * math.exp(-i / s(0.005)) * v
    noise = floor(s(0.3))
    return {'speech': [r + w for r, w in zip(room, words)], 'loud': [r + 2.5 * w for r, w in zip(room, words)],
            'noise': noise, 'tap': tap}


def clips():
    """The shared clips in file order. The 30 dB clips scale the signal before the ADC, as the PGA does: loud30 is
    not loud37 scaled."""
    src = sources()
    return {
        'speech37': adc(src['speech']), 'speech30': adc(src['speech'], scale(30)),
        'loud37': adc(src['loud']), 'loud30': adc(src['loud'], scale(30)),
        'noise37': adc(src['noise']), 'noise30': adc(src['noise'], scale(30)),
        'tap37': adc(src['tap']),
    }


def main():
    rows = table()
    for row in rows:
        print('\t'.join(str(v) for v in row))
    if rows != TABLE:
        print("does not match the design doc's table")
        return 1
    print("matches the design doc's table")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
