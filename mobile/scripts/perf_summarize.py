#!/usr/bin/env python3
"""Pool the phone benchmark's runs in a data directory into markdown tables.

    python3 mobile/scripts/perf_summarize.py docs/performance/2026-09-26-mobile-data

Pools individual observations — every measured interaction, every frame of a
window — across the runs in the directory, then takes nearest-rank
percentiles, the rule `desktop/tool/native_benchmark/summarize_results.py`
uses. Percentiles are never averaged. Warmups are excluded. Runs under
`failed/` are not read; review them separately.

`--label` restricts to files whose name starts with it (`baseline`, `after`).
"""
import argparse
import json
import math
from collections import defaultdict
from pathlib import Path


def pct(values, q):
    values = sorted(values)
    return values[math.ceil(len(values) * q) - 1]


def dist(values):
    if not values:
        return "—"
    return " / ".join(f"{pct(values, q):.1f}" for q in (.5, .95, .99)) + f" / {max(values):.1f}"


WINDOWS = [
    ("idle", "Idle, nothing streaming"),
    ("stream_redraw", "Reading: 8-row redraw @ 20 Hz"),
    ("stream_append", "Reading: ~60 wrapped lines/s appended"),
    ("scroll_read", "Scrolling back while redraw streams"),
    ("control_panel_redraw", "Control: bare TerminalPanel, redraw"),
]

INTERACTIONS = [
    ("find_open_tap", "idle", "Find: tap agent name"),
    ("find_open_tap", "redraw", "Find: tap agent name, while streaming"),
    ("find_open_swipe", "idle", "Find: swipe right (first = under finger, ready = release → settled)"),
    ("find_switch", "idle", "Find: tap another agent → its terminal"),
    ("mic_tap", "idle", "Mic: tap → listening face"),
    ("mic_tap", "redraw", "Mic: tap → listening, while streaming"),
    ("new_open_swipe", "idle", "New: swipe left → NewAgentPage"),
]


def load(root, label):
    runs = []
    for path in sorted(Path(root).glob("*.json")):
        if label and not path.name.startswith(label):
            continue
        data = json.loads(path.read_text())
        if data.get("kind") != "mobile_framework_dispatch_to_raster":
            continue
        if data.get("success") is not True:
            raise SystemExit(f"{path.name} is a failed run; move it to failed/ and review it")
        runs.append((path.name, data))
    return runs


def summarize(runs):
    out = []
    names = [name for name, _ in runs]
    out.append(f"Runs pooled: {len(runs)} ({', '.join(names)})\n")

    # Interactions: every measured observation, pooled.
    rows = defaultdict(lambda: defaultdict(list))
    for _, data in runs:
        for obs in data.get("observations", []):
            if obs["phase"] != "measured":
                continue
            key = (obs["operation"], obs["load"])
            rows[key]["first"].append(obs["firstRasterMicros"] / 1000)
            rows[key]["ready"].append(obs["readyRasterMicros"] / 1000)
            rows[key]["build"].append(obs["buildMicros"] / 1000)
            rows[key]["raster"].append(obs["rasterMicros"] / 1000)
            rows[key]["wait"].append(obs["waitForBuildMicros"] / 1000)
    out.append("### Interactions — framework dispatch → raster finish (ms, p50 / p95 / p99 / max)\n")
    out.append("| Interaction | n | First frame with result | Ready (animation done) | First frame: build | First frame: raster | Wait for build |")
    out.append("|---|---:|---:|---:|---:|---:|---:|")
    for op, load_name, title in INTERACTIONS:
        r = rows.get((op, load_name))
        if not r:
            continue
        out.append(
            f"| {title} | {len(r['first'])} | {dist(r['first'])} | {dist(r['ready'])} | "
            f"{dist(r['build'])} | {dist(r['raster'])} | {dist(r['wait'])} |"
        )
    out.append("")

    # Frame windows: every frame, pooled.
    out.append("### Frames while reading and scrolling (ms, p50 / p95 / p99 / max)\n")
    out.append("| Scenario | Frames | Frames/s | Build (UI) | Raster | Total span | Over 16.7 ms (total span) | Decoded kB/s | Session take per burst |")
    out.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for key, title in WINDOWS:
        build, raster, total = [], [], []
        seconds = 0.0
        decoded = 0.0
        takes = []
        for _, data in runs:
            scenario = data.get("scenarios", {}).get(key)
            if not scenario:
                continue
            frames = scenario["frames"]
            seconds += frames["windowMs"] / 1000
            for row in frames.get("raw", []):
                build.append(row[1] / 1000)
                raster.append(row[2] / 1000)
                total.append(row[4] / 1000)
            output = scenario.get("output")
            if output:
                decoded += output["decodedBytesPerSecond"] * frames["windowMs"] / 1000
                takes += [t / 1000 for t in output.get("sessionTakeRawUs", [])]
        if not seconds:
            continue
        over = sum(1 for t in total if t > 16.667)
        rate = f"{decoded / seconds / 1000:.1f}" if decoded else "—"
        out.append(
            f"| {title} | {len(total)} | {len(total) / seconds:.1f} | {dist(build)} | {dist(raster)} | "
            f"{dist(total)} | {over} ({(over / len(total) * 100) if total else 0:.1f}%) | {rate} | {dist(takes)} |"
        )
    out.append("")

    # Timeline rankings, per run (they are rankings, not timings).
    for name, data in runs:
        traces = data.get("traces") or {}
        for key, trace in traces.items():
            items = trace.get("bySelfTime")
            if not items:
                continue
            out.append(f"#### Hottest by self time — {key} ({name})\n")
            out.append("| Thread | Event | Count | Self ms | Inclusive ms | Max ms |")
            out.append("|---|---|---:|---:|---:|---:|")
            for item in items[:15]:
                out.append(
                    f"| {item['thread']} | `{item['name']}` | {item['count']} | {item['selfMs']:.1f} | "
                    f"{item['inclusiveMs']:.1f} | {item['maxInclusiveMs']:.1f} |"
                )
            out.append("")
    return "\n".join(out)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--label", default=None)
    args = parser.parse_args()
    print(summarize(load(args.directory, args.label)))
