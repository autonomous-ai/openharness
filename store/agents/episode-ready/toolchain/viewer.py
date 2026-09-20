"""The Episode Ready pane: one loopback HTTP server per agent.

    GET  /                     the page
    GET  /viewer/<file>        its script and style
    GET  /state.json           the whole pane in one object: project, verdict, transcript,
                               notes, contour, deliverables, and what is stale
    GET  /peaks/<which>        the waveform, as EPWF bytes (master | before)
    GET  /media/<which>        the audio itself, with Range so the browser can seek
    GET  /file/<path>          any file in the workspace: the artwork, a deliverable to download
    GET  /events               server-sent events: change, job
    POST /save                 chapters, transcript, notes or cuts, straight into the workspace
    POST /render               re-render (and re-deliver, if there was a delivery) in the background

Every save writes the same files the agent reads next turn, keeps the previous version under
`.harness/history/`, and refuses to overwrite a file that changed underneath it.
"""
from __future__ import annotations

import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from ep import checks as ep_checks
from ep import verdict as ep_verdict
from ep.project import Project, plan_hash

PACKAGE = Path(os.environ["EPISODE_PACKAGE"]).resolve()
WORKSPACE = Path(os.environ["HARNESS_WORKSPACE"]).resolve()
PORT = int(os.environ["HARNESS_VIEWER_PORT"])
PAGE = PACKAGE / "toolchain" / "viewer"
EP = PACKAGE / "toolchain" / "ep"
HOST = "127.0.0.1"

IGNORED_DIRS = {".harness", ".git", ".claude", ".agents", "node_modules", "__pycache__", ".venv"}
PAGE_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
              ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'none'")


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- listeners

class Hub:
    def __init__(self) -> None:
        self.clients: set[queue.Queue] = set()
        self.lock = threading.Lock()

    def add(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=64)
        with self.lock:
            self.clients.add(q)
        return q

    def drop(self, q: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(q)

    def send(self, event: str, data: dict) -> None:
        payload = f"event: {event}\ndata: {json.dumps(data)}\n\n"
        with self.lock:
            targets = list(self.clients)
        for q in targets:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass


HUB = Hub()


# --------------------------------------------------------------------------- the one background job

class Job:
    """One job at a time, so a person leaning on Re-render cannot start five ffmpegs."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state = {"running": False, "step": "", "log": [], "ok": None, "at": ""}

    def snapshot(self) -> dict:
        return dict(self.state, log=list(self.state["log"])[-14:])

    def start(self, steps: list[list[str]], label: str) -> bool:
        with self.lock:
            if self.state["running"]:
                return False
            self.state = {"running": True, "step": label, "log": [], "ok": None, "at": now()}
        threading.Thread(target=self._run, args=(steps, label), daemon=True).start()
        return True

    def _run(self, steps: list[list[str]], label: str) -> None:
        ok = True
        try:
            for step in steps:
                self.state["step"] = step[1] if len(step) > 1 else label
                HUB.send("job", self.snapshot())
                proc = subprocess.Popen(step, cwd=str(WORKSPACE), stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, text=True)
                assert proc.stdout is not None
                for line in proc.stdout:
                    line = line.rstrip()
                    if line:
                        self.state["log"].append(line)
                        HUB.send("job", self.snapshot())
                if proc.wait() != 0:
                    ok = False
                    break
        except Exception as exc:  # the pane must say what happened, not die quietly
            self.state["log"].append(f"miss {exc}")
            ok = False
        self.state["running"] = False
        self.state["ok"] = ok
        self.state["step"] = "done" if ok else "failed"
        HUB.send("job", self.snapshot())
        HUB.send("change", {"path": "episode.json"})


JOB = Job()


# --------------------------------------------------------------------------- reading the workspace

def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def revision(path: Path) -> str:
    try:
        stat = path.stat()
        return f"{stat.st_mtime_ns}:{stat.st_size}"
    except OSError:
        return ""


def deliverables() -> list[dict]:
    dist = WORKSPACE / "dist"
    if not dist.is_dir():
        return []
    out = []
    for path in sorted(dist.iterdir()):
        if path.is_file() and not path.name.startswith("."):
            out.append({"name": path.name, "bytes": path.stat().st_size,
                        "href": f"/file/dist/{path.name}"})
    return out


def before_path(episode: dict) -> Path:
    """What the A/B plays as "before": the mixed session, or — with one source — that file itself."""
    named = (episode.get("render") or {}).get("before")
    if named:
        candidate = (WORKSPACE / named).resolve()
        if WORKSPACE in candidate.parents and candidate.is_file():
            return candidate
    return WORKSPACE / "work" / "before.wav"


def state() -> dict:
    episode = read_json(WORKSPACE / "episode.json", {})
    verdict = read_json(WORKSPACE / ".harness" / "verdict.json", None)
    transcript = read_json(WORKSPACE / "transcript.json", None)
    notes_path = WORKSPACE / "shownotes.md"
    notes = notes_path.read_text(encoding="utf-8") if notes_path.exists() else ""
    contour = read_json(WORKSPACE / "work" / "contour.json", {"step": 0.5, "values": []})
    master = WORKSPACE / "work" / "master.wav"
    before = before_path(episode)
    project_rev = revision(WORKSPACE / "episode.json")
    rendered = (episode.get("render") or {}).get("planHash")
    stale = bool(master.exists() and rendered and rendered != plan_hash(episode))
    art = episode.get("artwork") or ""
    return {
        "episode": episode,
        "rev": project_rev,
        "transcriptRev": revision(WORKSPACE / "transcript.json"),
        "notesRev": revision(notes_path),
        "verdict": verdict,
        "transcript": transcript,
        "notes": notes,
        "contour": contour,
        "files": deliverables(),
        "hasMaster": master.exists(),
        "hasBefore": before.exists() and (WORKSPACE / "work" / "before.peaks").exists(),
        "masterMtime": master.stat().st_mtime if master.exists() else 0,
        "beforeMtime": before.stat().st_mtime if before.exists() else 0,
        "artwork": f"/file/{art}" if art and (WORKSPACE / art).exists() else "",
        "stale": stale,
        "job": JOB.snapshot(),
        "workspace": WORKSPACE.name,
    }


def keep_history(path: Path) -> None:
    if not path.exists():
        return
    folder = WORKSPACE / ".harness" / "history"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(path, folder / f"{stamp}-{path.name}")
    keep = sorted(folder.glob(f"*-{path.name}"))
    for old in keep[:-20]:
        old.unlink(missing_ok=True)


def write_atomic(path: Path, text: str) -> None:
    keep_history(path)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------- saves

def merge_clips(clips: list[dict]) -> list[dict]:
    out: list[dict] = []
    for clip in sorted(clips, key=lambda c: float(c["in"])):
        if out and float(clip["in"]) - float(out[-1]["out"]) < 0.01:
            out[-1]["out"] = max(float(out[-1]["out"]), float(clip["out"]))
        else:
            out.append({"in": round(float(clip["in"]), 3), "out": round(float(clip["out"]), 3)})
    return [c for c in out if c["out"] - c["in"] > 0.02]


def apply_save(body: dict) -> dict:
    kind = body.get("kind")
    project_path = WORKSPACE / "episode.json"
    if kind in ("chapters", "meta", "cuts"):
        if body.get("rev") and body["rev"] != revision(project_path):
            return {"conflict": True, "state": state(),
                    "message": "episode.json changed while you were editing"}
        project = read_json(project_path, {})
        if kind == "chapters":
            chapters = []
            for raw in body.get("chapters") or []:
                title = str(raw.get("title") or "").strip()
                chapters.append({"start": round(max(0.0, float(raw.get("start") or 0.0)), 2),
                                 "title": title or "Chapter"})
            project["chapters"] = sorted(chapters, key=lambda c: c["start"])
        elif kind == "meta":
            for key in ("title", "show", "summary", "author", "link"):
                if key in body:
                    project[key] = str(body[key])
        elif kind == "cuts":
            index = int(body.get("index", -1))
            removed = list(project.get("removed") or [])
            if not 0 <= index < len(removed):
                return {"error": f"there is no removed range {index}"}
            gone = removed.pop(index)
            clips = list(project.get("voice") or [])
            clips.append({"in": float(gone["start"]), "out": float(gone["end"])})
            project["voice"] = merge_clips(clips)
            project["removed"] = removed
        project["updatedAt"] = now()
        write_atomic(project_path, json.dumps(project, indent=2, ensure_ascii=False) + "\n")
        return {"ok": True, "state": state()}

    if kind == "transcript":
        path = WORKSPACE / "transcript.json"
        if body.get("rev") and body["rev"] != revision(path):
            return {"conflict": True, "state": state(),
                    "message": "transcript.json changed while you were editing"}
        transcript = read_json(path, None)
        if transcript is None:
            return {"error": "there is no transcript yet"}
        index = int(body.get("index", -1))
        segments = transcript.get("segments") or []
        if not 0 <= index < len(segments):
            return {"error": f"there is no cue {index}"}
        segments[index]["text"] = str(body.get("text") or "").strip()
        segments[index]["edited"] = True
        write_atomic(path, json.dumps(transcript, indent=1, ensure_ascii=False) + "\n")
        return {"ok": True, "state": state()}

    if kind == "notes":
        path = WORKSPACE / "shownotes.md"
        if body.get("rev") and body["rev"] != revision(path):
            return {"conflict": True, "state": state(),
                    "message": "shownotes.md changed while you were editing"}
        write_atomic(path, str(body.get("text") or ""))
        return {"ok": True, "state": state()}

    return {"error": f"unknown save '{kind}'"}


# --------------------------------------------------------------------------- watching

# --------------------------------------------------------------------------- judging on every save

_JUDGE_LOCK = threading.Lock()


def judge() -> None:
    """Re-run the whole evaluation and rewrite the verdict, so the pane's header moves when the
    agent — or the person, editing here — saves something, without anyone running a command."""
    if JOB.state.get("running"):
        return  # `ep check` is already the last step of the job
    if not _JUDGE_LOCK.acquire(blocking=False):
        return
    try:
        project = Project.load(WORKSPACE)
        if not (WORKSPACE / "episode.json").exists():
            return
        findings = ep_checks.run(project, deep=False, log=lambda *a: None)
        ready, summary = ep_checks.summarise(project, findings)
        artifact = None
        for candidate in sorted((WORKSPACE / "dist").glob("*.mp3")):
            artifact = f"dist/{candidate.name}"
            break
        ep_verdict.write(project, summary=summary, findings=findings, ready=ready,
                         artifact=artifact or "work/master.wav", done=ready)
    except Exception as exc:
        print(f"[episode-ready:viewer] the check could not run: {exc}")
    finally:
        _JUDGE_LOCK.release()


def watch_workspace() -> None:
    """Poll the workspace and push one change per burst. Polling rather than a native watcher:
    it is a few hundred files, it costs nothing, and it behaves the same on every platform."""
    previous: dict[str, float] = {}
    first = True
    while True:
        current: dict[str, float] = {}
        for root, dirs, files in os.walk(WORKSPACE):
            dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
            for name in files:
                if name.startswith(".") or name.endswith(".part"):
                    continue
                path = Path(root) / name
                try:
                    current[str(path)] = path.stat().st_mtime
                except OSError:
                    continue
        # .harness/ is ignored above, but two files in it are the pane's business: the verdict,
        # and the answer a fresh reader leaves behind.
        for extra in (WORKSPACE / ".harness" / "verdict.json",
                      WORKSPACE / ".harness" / "review" / "result.json"):
            try:
                current[str(extra)] = extra.stat().st_mtime
            except OSError:
                pass
        if not first and current != previous:
            changed = [p for p, m in current.items() if previous.get(p) != m]
            # Anything but the verdict itself is worth judging again; the verdict changing is the
            # judgement landing, and re-running on it would never stop.
            if any(not p.endswith("verdict.json") for p in changed):
                threading.Thread(target=judge, daemon=True).start()
            HUB.send("change", {"path": Path(changed[0]).name if changed else ""})
        previous = current
        first = False
        time.sleep(0.7)


# --------------------------------------------------------------------------- the server

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "EpisodeReady"

    def log_message(self, *_args) -> None:  # the pane's log is not the agent's business
        pass

    # -------------------------------------------------- helpers

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.send_header("content-security-policy", CSP)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload: dict, code: int = 200) -> None:
        self._send(code, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")

    def _not_found(self) -> None:
        self._send(404, b"not found", "text/plain; charset=utf-8")

    def _inside(self, rel: str) -> Path | None:
        try:
            full = (WORKSPACE / unquote(rel).lstrip("/")).resolve()
        except (OSError, ValueError, UnicodeDecodeError):
            return None
        if full == WORKSPACE or WORKSPACE not in full.parents:
            return None
        return full if full.is_file() else None

    # -------------------------------------------------- GET

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._get()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self._send(500, b"the viewer hit an error; see the terminal", "text/plain")
            except Exception:
                pass

    do_HEAD = do_GET

    def _get(self) -> None:
        url = urlparse(self.path)
        path = url.path

        if path == "/" or path.startswith("/viewer/"):
            name = "index.html" if path == "/" else path[len("/viewer/"):]
            full = (PAGE / name).resolve()
            if PAGE not in full.parents or full.suffix not in PAGE_TYPES or not full.is_file():
                return self._not_found()
            return self._send(200, full.read_bytes(), PAGE_TYPES[full.suffix])

        # Browsers ask for this whether or not the page links an icon, and an unanswered request
        # is a console error in every screenshot anyone takes of the pane.
        if path == "/favicon.ico":
            mark = PAGE / "mark.svg"
            if mark.is_file():
                return self._send(200, mark.read_bytes(), "image/svg+xml")
            self.send_response(204)
            self.send_header("content-length", "0")
            self.end_headers()
            return

        if path == "/state.json":
            return self._json(state())

        if path.startswith("/peaks/"):
            which = path[len("/peaks/"):]
            if which not in ("master", "before"):
                return self._not_found()
            full = WORKSPACE / "work" / f"{which}.peaks"
            if not full.is_file():
                return self._not_found()
            return self._send(200, full.read_bytes(), "application/octet-stream")

        if path.startswith("/media/"):
            which = path[len("/media/"):]
            if which not in ("master", "before"):
                return self._not_found()
            if which == "master":
                return self._serve_range(WORKSPACE / "work" / "master.wav", "audio/wav")
            full = before_path(read_json(WORKSPACE / "episode.json", {}))
            ctype = mimetypes.guess_type(full.name)[0] or "audio/wav"
            return self._serve_range(full, ctype)

        if path.startswith("/file/"):
            full = self._inside(path[len("/file/"):])
            if full is None:
                return self._not_found()
            ctype = mimetypes.guess_type(full.name)[0] or "application/octet-stream"
            if full.suffix.lower() in (".wav", ".mp3", ".m4a", ".flac"):
                return self._serve_range(full, ctype)
            return self._send(200, full.read_bytes(), ctype)

        if path == "/events":
            return self._events()

        return self._not_found()

    def _serve_range(self, full: Path, ctype: str) -> None:
        """Byte ranges, so the browser can seek in an hour-long master without loading it."""
        if not full.is_file():
            return self._not_found()
        size = full.stat().st_size
        header = self.headers.get("range", "")
        start, end = 0, size - 1
        partial = False
        match = re.match(r"bytes=(\d*)-(\d*)", header)
        if match and (match.group(1) or match.group(2)):
            if match.group(1):
                start = int(match.group(1))
                if match.group(2):
                    end = min(int(match.group(2)), size - 1)
            else:
                start = max(0, size - int(match.group(2)))
            if start >= size:
                self.send_response(416)
                self.send_header("content-range", f"bytes */{size}")
                self.send_header("content-length", "0")
                self.end_headers()
                return
            partial = True
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("content-type", ctype)
        self.send_header("accept-ranges", "bytes")
        self.send_header("content-length", str(length))
        self.send_header("cache-control", "no-store")
        if partial:
            self.send_header("content-range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with full.open("rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(262_144, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _events(self) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-store")
        self.send_header("connection", "keep-alive")
        self.end_headers()
        q = HUB.add()
        try:
            self.wfile.write(b": hello\n\n")
            self.wfile.flush()
            while True:
                try:
                    self.wfile.write(q.get(timeout=20).encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ValueError):
            pass
        finally:
            HUB.drop(q)

    # -------------------------------------------------- POST

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json({"error": "bad request"}, 400)
        url = urlparse(self.path)
        try:
            if url.path == "/save":
                result = apply_save(body)
                if result.get("ok"):
                    HUB.send("change", {"path": "saved"})
                return self._json(result, 409 if result.get("conflict") else 200)
            if url.path == "/render":
                steps = [[str(EP), "render"]]
                if (WORKSPACE / "dist").is_dir() and any((WORKSPACE / "dist").iterdir()):
                    steps.append([str(EP), "deliver"])
                steps.append([str(EP), "check"])
                started = JOB.start(steps, "re-rendering")
                return self._json({"started": started, "job": JOB.snapshot()})
        except Exception as exc:
            traceback.print_exc()
            return self._json({"error": str(exc)}, 500)
        return self._json({"error": "not found"}, 404)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        """A browser closing a keep-alive socket is not an error, and a page of traceback in the
        viewer's log hides the ones that are."""
        import sys

        kind = sys.exc_info()[0]
        if kind in (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            return
        super().handle_error(request, client_address)


def main() -> None:
    threading.Thread(target=watch_workspace, daemon=True).start()
    server = Server((HOST, PORT), Handler)
    print(f"[episode-ready:viewer] listening on http://{HOST}:{PORT}/ (workspace: {WORKSPACE})")
    server.serve_forever()


if __name__ == "__main__":
    main()
