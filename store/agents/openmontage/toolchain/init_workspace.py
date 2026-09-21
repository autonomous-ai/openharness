from pathlib import Path
import json
import os
import math
import struct
import wave

from lib.checkpoint import init_project

workspace = Path.cwd()
package = (
    Path(os.environ["OPENMONTAGE_PACKAGE"])
    if os.environ.get("OPENMONTAGE_PACKAGE")
    else Path(__file__).resolve().parent.parent
)
project = workspace / "projects" / "afterglow"
if not (project / "project.json").exists():
    init_project(
        "afterglow",
        title="Afterglow",
        pipeline_type="animation",
        pipeline_dir=workspace / "projects",
    )
    marker = json.loads((project / "project.json").read_text())
    marker["harness_starter"] = True
    (project / "project.json").write_text(json.dumps(marker, indent=2) + "\n")
audio = project / "public/afterglow.wav"
if not audio.exists():
    audio.parent.mkdir(parents=True, exist_ok=True)
    # An original, deterministic ambient score. No downloaded recordings or API.
    rate = 24000
    samples = bytearray()
    for n in range(rate * 18):
        t = n / rate
        fade = min(1, t / 1.8, (18 - t) / 2)
        value = 0
        for i, frequency in enumerate((130.8128, 195.9977, 261.6256, 329.6276)):
            pulse = 0.72 + 0.28 * math.sin(t * 0.42 + i)
            value += (
                math.sin(2 * math.pi * frequency * t + 0.14 * math.sin(t * 1.2))
                * pulse
                / 13
            )
        value += (
            math.sin(2 * math.pi * 523.251 * t)
            * (max(0, math.sin(t * math.pi / 4.5)) ** 8)
            / 16
        )
        samples.extend(struct.pack("<h", int(value * fade * 28000)))
    with wave.open(str(audio), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(samples)
if not (workspace / ".openmontage").exists():
    (workspace / ".openmontage").symlink_to(
        package / "upstream", target_is_directory=True
    )
(workspace / ".harness").mkdir(exist_ok=True)
if not (workspace / "film.json").exists():
    (workspace / "film.json").write_text(
        json.dumps({"spec": 1, "project": "afterglow"}, indent=2) + "\n"
    )
print(
    "ok   Film studio ready · Afterglow is an editable starter, not a generated production"
)
