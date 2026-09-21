"""Harness's screening room, backed by OpenMontage's real Backlot state.

No generation or shell execution is exposed over HTTP. The only writes are
viewer notes, export copies, and Harness's readiness verdict, inside this workspace.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
from datetime import datetime, timezone

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
import uvicorn

ROOT = Path(__file__).resolve().parent
WORKSPACE = Path(os.environ["HARNESS_WORKSPACE"]).resolve()
PROJECTS = WORKSPACE / "projects"
PORT = int(os.environ.get("HARNESS_VIEWER_PORT", "4750"))
TOKEN = secrets.token_urlsafe(32)
os.environ["OPENMONTAGE_PROJECTS_DIR"] = str(PROJECTS)

import backlot.server as backlot  # noqa: E402
import backlot.state as board_state  # noqa: E402
from backlot.state import load_board_state  # noqa: E402

backlot.THUMB_CACHE_DIR = WORKSPACE / ".harness" / "film-thumbnails"
app = backlot.create_app()
_probes: dict[tuple, dict | None] = {}
_notes_lock = asyncio.Lock()
MEDIA = {
    ".mp4",
    ".webm",
    ".mov",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".wav",
    ".mp3",
    ".m4a",
    ".ogg",
}


def read_json(path: Path, default=None):
    try:
        contained(path, WORKSPACE)
        if path.stat().st_size > 4 * 1024 * 1024:
            return default
        value = json.loads(path.read_text())
        return value if default is None or isinstance(value, type(default)) else default
    except (OSError, ValueError, HTTPException):
        return default


def contained(path: Path, parent: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(parent.resolve()):
        raise HTTPException(403, "Path is outside this production")
    return resolved


def project_dir(project: str) -> Path:
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}", project):
        raise HTTPException(400, "Invalid production")
    contained(PROJECTS, WORKSPACE)
    path = contained(PROJECTS / project, PROJECTS)
    if not path.is_dir():
        raise HTTPException(404, "Production not found")
    return path


def atomic_json(path: Path, value):
    contained(path, WORKSPACE)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        temporary.write_text(json.dumps(value, indent=2) + "\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def active_project() -> str | None:
    config = read_json(WORKSPACE / "film.json", {})
    chosen = config.get("project") if isinstance(config, dict) else None
    if isinstance(chosen, str):
        project_dir(chosen)
        return chosen
    projects = [p.name for p in safe_projects()]
    return projects[0] if projects else None


def safe_projects() -> list[Path]:
    projects = []
    for entry in sorted(PROJECTS.glob("*")):
        try:
            projects.append(project_dir(entry.name))
        except HTTPException:
            continue
    return projects


# Backlot remains the production reader. Bound its JSON reads and library to
# this workspace too; a symlink must not expose a different local project.
board_state._read_json = lambda path: read_json(path, {}) or None
_backlot_read_events = board_state.read_events


def workspace_events(directory, **kwargs):
    try:
        contained(Path(directory) / "events.jsonl", WORKSPACE)
        return _backlot_read_events(directory, **kwargs)
    except HTTPException:
        return []


board_state.read_events = workspace_events
backlot._safe_project_dir = project_dir
backlot._cached_summaries = lambda: [
    board_state.summarize_project(p) for p in safe_projects()
]


def probe(path: Path) -> dict | None:
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    if key in _probes:
        return _probes[key]
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=12,
            check=True,
        )
        data = json.loads(result.stdout)
        video = next(s for s in data["streams"] if s.get("codec_type") == "video")
        duration = float(data["format"]["duration"])
        if not math.isfinite(duration) or duration <= 0 or not video.get("width"):
            raise ValueError("Video is empty")
        info = {
            "duration": duration,
            "width": video["width"],
            "height": video["height"],
            "audio": any(s.get("codec_type") == "audio" for s in data["streams"]),
            "revision": f"{stat.st_mtime_ns:x}-{stat.st_size:x}",
        }
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError):
        info = None
    if len(_probes) > 100:
        _probes.clear()
    _probes[key] = info
    return info


def renders_for(project: str, board: dict) -> list[dict]:
    directory = project_dir(project)
    valid = []
    for item in board["media"]["renders"][:30]:
        rel = item["path"]
        if ".partial" in rel or Path(rel).name.startswith("."):
            continue
        try:
            path = contained(directory / rel, directory)
            info = probe(path)
            if info:
                valid.append({**item, **info, "name": path.stem.replace("-", " ")})
        except (OSError, HTTPException):
            continue
    return valid


def studio_state() -> dict:
    project = active_project()
    if not project:
        return {
            "project_id": None,
            "title": "Your next film",
            "renders": [],
            "notes": [],
            "token": TOKEN,
        }
    directory = project_dir(project)
    state = load_board_state(directory)
    for scene in (state.get("storyboard") or {}).get("scenes", []):
        visual = scene.get("visual")
        if visual and visual.get("exists") and visual.get("path"):
            try:
                stat = contained(directory / visual["path"], directory).stat()
                visual["revision"] = f"{stat.st_mtime_ns:x}-{stat.st_size:x}"
            except (OSError, HTTPException):
                visual["exists"] = False
    state["renders"] = renders_for(project, state)
    state["notes"] = [
        note
        for note in read_json(directory / "review-notes.json", [])
        if isinstance(note, dict)
        and isinstance(note.get("text"), str)
        and isinstance(note.get("render"), str)
        and isinstance(note.get("revision"), str)
        and isinstance(note.get("seconds"), (float, int))
        and math.isfinite(note["seconds"])
    ]
    state["token"] = TOKEN
    state["starter"] = bool(
        read_json(directory / "project.json", {}).get("harness_starter")
    )
    progress = read_json(directory / "render-progress.json", {})
    if isinstance(progress, dict) and progress.get("status") == "rendering":
        try:
            pid = int(progress.get("pid", 0))
            if pid <= 0:
                raise ProcessLookupError()
            os.kill(pid, 0)
        except (OSError, ValueError):
            progress = {
                **progress,
                "status": "failed",
                "message": "Render interrupted. Your previous cut is still available.",
            }
    state["render_progress"] = progress
    ready = bool(state["renders"]) and progress.get("status") not in {
        "failed",
        "rendering",
    }
    summary = (
        "Film ready to watch"
        if ready
        else progress.get("message") or "Your production is taking shape"
    )[:200]
    newest = state["renders"][0] if state["renders"] else None
    verdict = {
        "spec": 1,
        "ready": ready,
        "summary": summary,
        "findings": [{"severity": "error", "message": summary}]
        if progress.get("status") == "failed"
        else [],
    }
    if newest:
        verdict["artifact"] = f"projects/{project}/{newest['path']}"
    current = read_json(WORKSPACE / ".harness/verdict.json", {})
    if any(current.get(k) != v for k, v in verdict.items()):
        atomic_json(
            WORKSPACE / ".harness/verdict.json",
            {**verdict, "updatedAt": datetime.now(timezone.utc).isoformat()},
        )
    return state


@app.middleware("http")
async def local_only(request: Request, call_next):
    host = request.headers.get("host", "")
    allowed = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
    if host not in allowed or request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"detail": "Local viewer only"}, status_code=403)
    origin = request.headers.get("origin")
    if origin and origin != f"http://{host}":
        return JSONResponse(
            {"detail": "Origin does not match this viewer"}, status_code=403
        )
    if (
        request.method not in {"GET", "HEAD"}
        and request.headers.get("x-film-token") != TOKEN
    ):
        return JSONResponse(
            {"detail": "Refresh the viewer before trying again"}, status_code=403
        )
    parts = request.url.path.strip("/").split("/")
    try:
        if parts[0] in {"media", "thumb"} and len(parts) >= 3:
            directory = project_dir(parts[1])
            target = contained(directory / "/".join(parts[2:]), directory)
            if target.suffix.lower() not in MEDIA:
                raise HTTPException(403, "This file is not media")
        elif parts[:2] == ["api", "project"] and len(parts) >= 3:
            project_dir(parts[2])
    except HTTPException as error:
        return JSONResponse({"detail": error.detail}, status_code=error.status_code)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/studio")
async def studio():
    return HTMLResponse(
        (ROOT / "ui/index.html").read_text(), headers={"Cache-Control": "no-store"}
    )


@app.get("/studio/{asset}")
async def studio_asset(asset: str):
    if asset not in {"studio.css", "studio.js"}:
        raise HTTPException(404)
    return FileResponse(ROOT / "ui" / asset, headers={"Cache-Control": "no-cache"})


@app.get("/api/studio")
async def state():
    return await asyncio.to_thread(studio_state)


async def body_json(request: Request) -> dict:
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 8192:
            raise HTTPException(413, "Note is too long")
    try:
        body = json.loads(data)
        if not isinstance(body, dict):
            raise ValueError()
        return body
    except ValueError:
        raise HTTPException(400, "Invalid request")


def selected_render(body: dict) -> tuple[Path, dict]:
    project = body.get("project")
    if not isinstance(project, str):
        raise HTTPException(400, "Choose a production")
    directory = project_dir(project)
    board = load_board_state(directory)
    render = next(
        (
            item
            for item in renders_for(project, board)
            if item["path"] == body.get("path")
            and item["revision"] == body.get("revision")
        ),
        None,
    )
    if not render:
        raise HTTPException(
            409, "This cut changed. Select the new version and try again."
        )
    return directory, render


@app.post("/api/studio/notes")
async def add_note(request: Request):
    body = await body_json(request)
    async with _notes_lock:
        directory, render = await asyncio.to_thread(selected_render, body)
        text = body.get("text")
        seconds = body.get("seconds")
        if (
            not isinstance(text, str)
            or not text.strip()
            or len(text) > 2000
            or not isinstance(seconds, (int, float))
            or not math.isfinite(seconds)
            or not 0 <= seconds <= render["duration"] + 0.1
        ):
            raise HTTPException(400, "Add a note at a moment in the film")
        notes = read_json(directory / "review-notes.json", [])
        if not isinstance(notes, list) or len(notes) >= 1000:
            raise HTTPException(
                409, "Review notes need to be archived before adding more"
            )
        note = {
            "id": secrets.token_hex(8),
            "render": render["path"],
            "revision": render["revision"],
            "seconds": round(seconds, 3),
            "text": text.strip(),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        atomic_json(directory / "review-notes.json", [*notes, note])
        backlot.hub.publish(directory.name)
        return note


@app.post("/api/studio/export")
async def export(request: Request):
    body = await body_json(request)
    directory, render = await asyncio.to_thread(selected_render, body)
    source = contained(directory / render["path"], directory)
    exports = contained(WORKSPACE / "exports", WORKSPACE)
    exports.mkdir(exist_ok=True)
    filename = f"{directory.name}-{source.stem}-{secrets.token_hex(3)}{source.suffix}"
    target = exports / filename

    def copy():
        with source.open("rb") as incoming, target.open("xb") as outgoing:
            stat = os.fstat(incoming.fileno())
            if f"{stat.st_mtime_ns:x}-{stat.st_size:x}" != render["revision"]:
                raise HTTPException(
                    409, "This cut changed. Select the new version and try again."
                )
            shutil.copyfileobj(incoming, outgoing)
            after = os.fstat(incoming.fileno())
            if (stat.st_mtime_ns, stat.st_size) != (after.st_mtime_ns, after.st_size):
                raise HTTPException(
                    409, "This cut changed during export. Try the new version."
                )

    try:
        await asyncio.to_thread(copy)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return {"file": f"exports/{filename}", "download": f"/export/{filename}"}


@app.get("/export/{filename}")
async def download(filename: str):
    exports = contained(WORKSPACE / "exports", WORKSPACE)
    path = contained(exports / filename, exports)
    if not path.is_file() or path.suffix.lower() not in {".mp4", ".webm", ".mov"}:
        raise HTTPException(404)
    return FileResponse(path, filename=path.name)


if __name__ == "__main__":
    contained(PROJECTS, WORKSPACE)
    PROJECTS.mkdir(exist_ok=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning", access_log=False)
