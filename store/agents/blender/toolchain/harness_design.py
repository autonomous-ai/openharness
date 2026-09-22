"""Project-authored controls for Blender's Shape Lab. No Blender import is needed here."""
from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import Path


def _relative(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) >= 300 or value.startswith("/") or any(not p or p.startswith(".") for p in value.split("/")) or "\\" in value:
        raise ValueError(f"Expected a relative project path: {value}")
    return value


def validate_value(control: dict, value):
    kind = control["type"]
    if kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{control['label']} must be a finite number")
        if value < control["min"] or value > control["max"] or (kind == "integer" and int(value) != value):
            raise ValueError(f"{control['label']} must be between {control['min']} and {control['max']}")
    elif kind == "boolean":
        if not isinstance(value, bool):
            raise ValueError(f"{control['label']} must be true or false")
    elif kind == "choice":
        if value not in control["options"] or not isinstance(value, str):
            raise ValueError(f"{control['label']} must be one of its declared choices")
    return value


def parameters(definitions: dict, *, title: str = "Explore this design", sources: list[str] | None = None,
               output: str = "out/model.glb") -> dict:
    """Declare meaningful controls in source, then return the chosen values.

    Normal builds read design-values.json. Shape Lab snapshots only the declared source files
    and runs that snapshot in its own directory, with different values and renders skipped.
    Keep local imports and assets within `sources`; use relative paths for generated output.
    """
    workspace = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
    entry = Path(sys.argv[0]).resolve().relative_to(workspace).as_posix()
    if not isinstance(definitions, dict) or not 1 <= len(definitions) <= 16:
        raise ValueError("Declare between one and sixteen design controls")
    controls = []
    for key, definition in definitions.items():
        if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", key) or not isinstance(definition, dict):
            raise ValueError("Design control names use lowercase letters, numbers and underscores")
        control = {"id": key, "type": definition.get("type", "number"),
                   "label": str(definition.get("label", key.replace("_", " ").title()))[:80],
                   "description": str(definition.get("description", ""))[:200],
                   "unit": str(definition.get("unit", ""))[:16], "default": definition["default"]}
        if control["type"] in ("number", "integer"):
            for name in ("min", "max", "step"):
                control[name] = definition.get(name, 1 if name == "step" else None)
                if isinstance(control[name], bool) or not isinstance(control[name], (int, float)) or not math.isfinite(control[name]):
                    raise ValueError(f"{key}: min, max and step must be finite numbers")
            if control["min"] >= control["max"] or control["step"] <= 0:
                raise ValueError(f"{key}: declare a positive step and an increasing range")
            if control["type"] == "integer" and any(int(control[k]) != control[k] for k in ("min", "max", "step")):
                raise ValueError(f"{key}: integer controls need integer bounds and step")
        elif control["type"] == "choice":
            options = definition.get("options")
            if not isinstance(options, list) or not 2 <= len(options) <= 12 or any(not isinstance(v, str) or not 1 <= len(v) <= 80 for v in options) or len(set(options)) != len(options):
                raise ValueError(f"{key}: declare two to twelve distinct text choices")
            control["options"] = options
        elif control["type"] != "boolean":
            raise ValueError(f"{key}: unsupported control type")
        validate_value(control, control["default"])
        controls.append(control)
    chosen = {}
    values_file = workspace / "design-values.json"
    if values_file.exists():
        if values_file.stat().st_size > 16384:
            raise ValueError("design-values.json is too large")
        record = json.loads(values_file.read_text())
        if not isinstance(record, dict) or record.get("spec") != 1 or not isinstance(record.get("values"), dict):
            raise ValueError("design-values.json needs spec: 1 and a values object")
        chosen = record["values"]
        unknown = set(chosen) - set(definitions)
        if unknown:
            raise ValueError(f"Unknown design values: {', '.join(sorted(unknown))}")
    values = {c["id"]: validate_value(c, chosen.get(c["id"], c["default"])) for c in controls}
    if sources is None:
        parent = Path(entry).parent.as_posix()
        sources = [entry if parent == "." else parent]
        if (workspace / "assets").is_dir() and "assets" not in sources:
            sources.append("assets")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 16:
        raise ValueError("Declare one to sixteen source files or folders")
    sources = [_relative(source) for source in sources]
    if any(source.split("/")[0] in ("out", "node_modules", "venv", "_harness_tools") for source in sources):
        raise ValueError("Declare project source files, outside output and dependency folders")
    if not any(entry == source or entry.startswith(source + "/") for source in sources):
        raise ValueError("The entry script must be included in sources")
    output = _relative(output)
    if not output.startswith("out/") or Path(output).suffix not in (".glb", ".gltf") or output.startswith("out/designs/"):
        raise ValueError("The design output must be a glTF file under out/, outside out/designs/")
    manifest = {"spec": 1, "kind": "blender-parameters", "title": str(title)[:100],
                "entry": entry, "sources": sources, "output": output, "controls": controls}
    harness = workspace / ".harness"
    harness.mkdir(exist_ok=True)
    target = harness / "design.json"
    encoded = json.dumps(manifest, indent=2) + "\n"
    if not target.exists() or target.read_text() != encoded:
        temporary = harness / ".design.json.tmp"
        temporary.write_text(encoded)
        os.replace(temporary, target)
    return values
