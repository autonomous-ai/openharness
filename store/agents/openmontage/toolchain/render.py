"""Render through OpenMontage, publish an immutable cut only after ffprobe passes."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

from lib.events import emit_event
from tools.video.video_compose import VideoCompose


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2, default=str) + "\n")
    temporary.replace(path)


def update_snapshots(project: Path, movie: Path, duration: float) -> list[str]:
    """Refresh the animation storyboard from this verified cut, one still per scene."""
    warnings = []
    try:
        plan = json.loads((project / "artifacts/scene_plan.json").read_text())
        scenes = plan.get("scenes", [])
        if not isinstance(scenes, list):
            raise ValueError("scene_plan.scenes must be a list")
        snapshots = project / "snapshots"
        if not snapshots.resolve().is_relative_to(project):
            raise ValueError("Snapshots must stay inside the production")
        snapshots.mkdir(exist_ok=True)
        for scene in scenes[:100]:
            scene_id = str(scene.get("id", ""))
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", scene_id):
                continue
            start, end = float(scene["start_seconds"]), float(scene["end_seconds"])
            if (
                not all(math.isfinite(t) for t in (start, end))
                or not 0 <= start < end <= duration + 0.1
            ):
                continue
            partial = snapshots / f".{scene_id}-{os.getpid()}.jpg"
            try:
                subprocess.run(
                    [
                        "ffmpeg",
                        "-v",
                        "error",
                        "-y",
                        "-ss",
                        str((start + end) / 2),
                        "-i",
                        str(movie),
                        "-frames:v",
                        "1",
                        "-vf",
                        "scale=640:-2",
                        str(partial),
                    ],
                    check=True,
                    capture_output=True,
                    timeout=30,
                )
                partial.replace(snapshots / f"{scene_id}.jpg")
            finally:
                partial.unlink(missing_ok=True)
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
    ) as error:
        warnings.append(f"Film rendered; storyboard stills need attention: {error}")
    return warnings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project")
    parser.add_argument("--scale", type=float, default=1.0)
    args = parser.parse_args()
    workspace = Path(os.environ.get("HARNESS_WORKSPACE", os.getcwd())).resolve()
    config = json.loads((workspace / "film.json").read_text())
    project_id = args.project or config["project"]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}", project_id):
        raise ValueError("Invalid project id")
    project = (workspace / "projects" / project_id).resolve()
    if not project.is_relative_to(workspace) or not project.is_dir():
        raise ValueError("Production must exist inside this workspace")
    if not 0.1 <= args.scale <= 2:
        raise ValueError("Scale must be between 0.1 and 2")
    lock = (project / ".render.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("A render is already running for this production")
    renders = project / "renders"
    renders.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = f"cut-{stamp}-{secrets.token_hex(2)}"
    temporary = renders / f".{name}.partial.mp4"
    output = renders / f"{name}.mp4"
    status = project / "render-progress.json"
    composer = Path(os.environ["OPENMONTAGE_ROOT"]) / "remotion-composer"
    staging = Path(tempfile.mkdtemp(prefix=".harness-film-", dir=composer))
    now = datetime.now(timezone.utc).isoformat()
    write(
        status,
        {
            "status": "rendering",
            "message": "Rendering the next cut",
            "pid": os.getpid(),
            "startedAt": now,
        },
    )
    emit_event(
        project, {"event": "start", "tool": "harness_film_render", "run_id": name}
    )
    try:
        edit = json.loads((project / "artifacts/edit_decisions.json").read_text())
        if (
            edit.get("render_runtime") != "remotion"
            or edit.get("composition_mode") != "atelier"
        ):
            raise ValueError(
                "montage render is the Remotion atelier path. Use the upstream tool for other approved runtimes; do not silently change the production plan."
            )
        source = (project / edit["bespoke"]["entry"]).resolve()
        if not source.is_relative_to(project) or not source.is_file():
            raise ValueError("Composition entry must be inside this production")
        # Upstream's default staging key is only the project slug. Two workspaces
        # named alike must never share mutable render sources, so use a per-run copy.
        shutil.copytree(
            source.parent,
            staging / "src",
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(
                "node_modules", ".git", "renders", "__pycache__"
            ),
        )
        bespoke = {
            **edit["bespoke"],
            "entry": str(staging / "src" / source.name),
            "scale": args.scale,
            "concurrency": 2,
            "crf": 18,
        }
        public = project / "public"
        if public.is_dir():
            bespoke["public_dir"] = str(public)
        props = project / "composition/props.json"
        if props.is_file():
            bespoke["props_path"] = str(props)
        manifest_path = project / "artifacts/asset_manifest.json"
        manifest = (
            json.loads(manifest_path.read_text())
            if manifest_path.is_file()
            else {"version": "1.0", "assets": []}
        )
        result = VideoCompose().execute(
            {
                "operation": "render",
                "output_path": str(temporary),
                "edit_decisions": {**edit, "bespoke": bespoke},
                "asset_manifest": manifest,
            }
        )
        if not result.success:
            raise RuntimeError(result.error or "OpenMontage render failed")
        info = json.loads(
            subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_streams",
                    "-show_format",
                    "-of",
                    "json",
                    str(temporary),
                ],
                text=True,
            )
        )
        video = next(s for s in info["streams"] if s.get("codec_type") == "video")
        if float(info["format"]["duration"]) <= 0 or not video.get("width"):
            raise RuntimeError("Rendered file has no playable video")
        # Validate decoding, not just a container header.
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(temporary), "-f", "null", "-"],
            check=True,
            capture_output=True,
            timeout=180,
        )
        temporary.replace(output)
        report = {
            "version": "1.0",
            "output_path": str(output.relative_to(project)),
            "duration_seconds": float(info["format"]["duration"]),
            "width": video["width"],
            "height": video["height"],
            "has_audio": any(s.get("codec_type") == "audio" for s in info["streams"]),
            "verification": "ffprobe and complete FFmpeg decode",
            "upstream_review": result.data,
        }
        report["warnings"] = update_snapshots(
            project, output, report["duration_seconds"]
        )
        for warning in report["warnings"]:
            print(f"warn {warning}", file=sys.stderr)
        write(project / "artifacts/render_report.json", report)
        write(
            status,
            {
                "status": "ready",
                "message": "Cut ready to watch",
                "output": report["output_path"],
                "finishedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
        emit_event(
            project,
            {
                "event": "finish",
                "tool": "harness_film_render",
                "run_id": name,
                "success": True,
                "cost_usd": 0,
            },
        )
        print(
            f"ok   {output}\nok   {video['width']} × {video['height']} · {report['duration_seconds']:.1f}s · fully decoded"
        )
    except BaseException as error:
        write(
            status,
            {
                "status": "failed",
                "message": str(error)[-1800:] or "Render interrupted",
                "finishedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
        emit_event(
            project,
            {
                "event": "error",
                "tool": "harness_film_render",
                "run_id": name,
                "error": str(error)[-1000:],
            },
        )
        raise
    finally:
        temporary.unlink(missing_ok=True)
        shutil.rmtree(staging, ignore_errors=True)
        lock.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Render failed: {error}", file=sys.stderr)
        sys.exit(1)
