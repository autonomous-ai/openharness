#!/usr/bin/env python3
"""Pool measured observations, not percentiles, from a published data directory."""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path


def distribution(values):
    values = sorted(values)
    return {
        "samples": len(values),
        **{name: values[math.ceil(len(values) * q) - 1]
           for name, q in (("p50Ms", .5), ("p95Ms", .95), ("p99Ms", .99))},
        "maxMs": values[-1],
    }


def summarize(root):
    groups = defaultdict(list)
    files = defaultdict(set)
    resources = []
    for path in sorted(root.glob("*.json")):
        data = json.loads(path.read_text())
        if data.get("success") is False:
            raise ValueError(f"Failed run must be reviewed separately: {path.name}")
        if data.get("kind") == "release_core_framework_dispatch_to_raster":
            key_prefix = ("desktop", str(data["terminals"]),
                          str(data["seedLinesPerTerminal"]))
            for row in data["observations"]:
                if row["phase"] != "measured":
                    continue
                key = (*key_prefix, row["load"], row["operation"])
                groups[key].append(row["readyRasterMicros"] / 1000)
                files[key].add(path.name)
        elif data.get("schema") == 3 and "controlObservations" in data:
            if data["failedControlRequests"] or not data["cleanup"]["deleted"]:
                raise ValueError(f"Incomplete terminal run: {path.name}")
            for row in data["observations"]:
                if row["phase"] != "measured":
                    continue
                mode = row["modeAfter"] if row["modeBefore"] == row["modeAfter"] else "transition"
                key = ("terminal", data["label"], mode, row["load"])
                groups[key].append(row["elapsedMs"])
                files[key].add(path.name)
            for row in data["controlObservations"]:
                if row["phase"] == "measured":
                    key = ("control", data["label"], row["route"])
                    groups[key].append(row["elapsedMs"])
                    files[key].add(path.name)
        elif "physicalFootprintMiBMedian" in data.get("summary", {}):
            resources.append({"file": path.name, "label": data["label"],
                              **data["summary"]})
    return {"latency": [{"workload": list(key), "files": sorted(files[key]),
                         **distribution(values)}
                        for key, values in sorted(groups.items())],
            "resources": resources}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(args.directory), indent=2))
