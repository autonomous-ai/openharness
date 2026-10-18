#!/usr/bin/env python3
"""New email -> Fo -> the round device.

Polls one IMAP folder (Gmail with an app password), turns each new unseen message into a short text
(sender, subject, plain-text body cut to 2,000 characters, and what to do with it) and hands it to one
long-lived harness: the cloud agent Fo ("Fo inbox"), or with --engine claude a local Claude Code harness
("Mail inbox"). The harness's reply ends its turn, so the device beeps and files a notice with the recap.

It talks to the Harness daemon on this computer over its loopback WebSocket
(ws://127.0.0.1:18473/api/local-ws), the same socket `harness new` uses. Python's standard library has
no WebSocket client, so a minimal RFC 6455 client is below.

Standard library only. It stores no mail on disk: state.json keeps the harness id and the UIDs handled.
"""
from __future__ import annotations

import argparse
import base64
import email
import email.header
import email.utils
import html
import html.parser
import imaplib
import json
import os
import re
import socket
import ssl
import struct
import subprocess
import sys
import time
import uuid
from typing import Any, Callable, Optional

BODY_LIMIT = 2000
DEFAULT_PORT = 18473
LOCAL_WS_PATH = "/api/local-ws"
HARNESS_NAMES = {"fo": "Fo inbox", "claude": "Mail inbox"}
# How many handled UIDs state.json keeps per folder: enough to never see one twice, small enough to read.
UID_MEMORY = 5000

INSTRUCTION = (
    "A new email arrived. Answer in one short paragraph first: summarise it in one sentence and say what I "
    "should do about it (reply, archive, add to calendar, ...). That first paragraph is what my small round "
    "screen shows, so keep it short.\n"
    "If it is job-search mail (an application sent, a reply from a company, an interview invitation), update "
    "today's counts and START your answer with exactly one line in this form, then a blank line, then the "
    "paragraph:\n"
    "GLANCE applied=<n> replies=<n> interviews=<n> goal=10\n"
    "(plain text, no bold, no code block; whole numbers 0-9999). The counts are running totals:\n"
    "- applied: applications I have sent; a company confirming it received N applications counts all N;\n"
    "- replies: messages from a company or recruiter that answer an application (a confirmation of receipt "
    "is not a reply);\n"
    "- interviews: interviews scheduled or proposed."
)


# ---------------------------------------------------------------------------------------------------------------
# Mail -> text
# ---------------------------------------------------------------------------------------------------------------

class _TextExtractor(html.parser.HTMLParser):
    """The visible text of an HTML body: no scripts, styles or head; block tags become line breaks."""

    SKIP = {"script", "style", "head", "title", "noscript"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "blockquote", "hr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skipping = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in self.SKIP:
            self.skipping += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: Any) -> None:
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP:
            self.skipping = max(0, self.skipping - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skipping:
            # HTML whitespace, newlines included, is one space; only block tags break lines.
            self.parts.append(re.sub(r"\s+", " ", data))


def html_to_text(markup: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(markup)
        parser.close()
    except Exception:  # A broken document still yields what was read.
        pass
    return tidy("".join(parser.parts))


def tidy(text: str) -> str:
    """Collapse runs of spaces and blank lines; strip each line."""
    text = html.unescape(text).replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ")
    lines = [re.sub(r"[ \t\f\v]+", " ", line).strip() for line in text.split("\n")]
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


def decode_header(value: Optional[str]) -> str:
    """An RFC 2047 header (=?UTF-8?B?...?=) as plain text."""
    if not value:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(value))).strip()
    except Exception:
        return value.strip()


def _part_text(part: email.message.Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def body_text(msg: email.message.Message) -> str:
    """The message's plain-text body: text/plain when there is one, else its HTML stripped. Attachments skipped."""
    plain: list[str] = []
    rich: list[str] = []
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.is_multipart():
            continue
        if (part.get_content_disposition() or "") == "attachment":
            continue
        kind = part.get_content_type()
        if kind == "text/plain":
            plain.append(_part_text(part))
        elif kind == "text/html":
            rich.append(_part_text(part))
    if any(p.strip() for p in plain):
        return tidy("\n\n".join(plain))
    return html_to_text("\n".join(rich))


def cut(text: str, limit: int = BODY_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def mail_summary(raw: bytes) -> dict[str, str]:
    """Sender, subject and body (cut to BODY_LIMIT) of one RFC 822 message."""
    msg = email.message_from_bytes(raw)
    sender = decode_header(msg.get("From"))
    name, address = email.utils.parseaddr(sender)
    return {
        "from": f"{name} <{address}>" if name and address else (address or sender),
        "subject": decode_header(msg.get("Subject")) or "(no subject)",
        "date": decode_header(msg.get("Date")),
        "body": cut(body_text(msg)),
    }


def mail_to_text(raw: bytes) -> str:
    """The words sent to the harness for one message."""
    m = mail_summary(raw)
    lines = [INSTRUCTION, "", f"From: {m['from']}", f"Subject: {m['subject']}"]
    if m["date"]:
        lines.append(f"Date: {m['date']}")
    lines += ["", m["body"] or "(empty body)"]
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------------------------------------------

def load_state(path: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}
    if not isinstance(state, dict):
        state = {}
    state.setdefault("agents", {})      # engine -> agent id
    state.setdefault("folders", {})     # folder -> {"uidvalidity": str, "handled": [uid, ...]}
    return state


def save_state(path: str, state: dict[str, Any]) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)


def folder_state(state: dict[str, Any], folder: str, uidvalidity: str) -> dict[str, Any]:
    """The folder's record; a changed UIDVALIDITY means the server renumbered it, so old UIDs mean nothing."""
    entry = state["folders"].get(folder)
    if not entry or entry.get("uidvalidity") != uidvalidity:
        entry = {"uidvalidity": uidvalidity, "handled": []}
        state["folders"][folder] = entry
    return entry


def is_handled(entry: dict[str, Any], uid: str) -> bool:
    return uid in entry["handled"]


def mark_handled(entry: dict[str, Any], uid: str) -> None:
    if uid not in entry["handled"]:
        entry["handled"].append(uid)
    del entry["handled"][:-UID_MEMORY]


def load_env(path: str) -> dict[str, str]:
    """KEY=VALUE lines; # comments; optional quotes. The real environment wins."""
    values: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key.strip()] = value
    except FileNotFoundError:
        pass
    for key in {*values, "IMAP_HOST", "IMAP_USER", "IMAP_APP_PASSWORD", "IMAP_FOLDER", "POLL_SECONDS"}:
        if key in os.environ:
            values[key] = os.environ[key]
    return values


# ---------------------------------------------------------------------------------------------------------------
# The daemon's loopback WebSocket (a minimal RFC 6455 client: text frames, masked, no extensions)
# ---------------------------------------------------------------------------------------------------------------

class DaemonError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


class WebSocket:
    def __init__(self, host: str, port: int, path: str, timeout: float = 10.0) -> None:
        try:
            self.sock = socket.create_connection((host, port), timeout=timeout)
        except OSError as error:
            raise DaemonError("DAEMON_UNREACHABLE", f"Harness is not running on port {port} ({error}). Run `harness start`.")
        key = base64.b64encode(os.urandom(16)).decode()
        # No Origin header: the daemon refuses any (a browser always sends one).
        request = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(request.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise DaemonError("DAEMON_UNREACHABLE", "The daemon closed the connection during the handshake.")
            head += chunk
        head, self.buffer = head.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101 " not in status + " ":
            raise DaemonError("DAEMON_REFUSED", status)

    def send(self, text: str) -> None:
        data = text.encode()
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 1 << 16:
            header.append(0x80 | 126)
            header += struct.pack("!H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", n)
        mask = os.urandom(4)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n: int) -> bytes:
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise DaemonError("DISCONNECTED", "The daemon connection closed.")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def _control(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        self.sock.sendall(bytes([0x80 | opcode, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self) -> str:
        """The next whole text message; answers pings, skips binary (terminal) frames."""
        message = b""
        kind = None
        while True:
            b1, b2 = self._read(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if b2 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                raise DaemonError("DISCONNECTED", f"closed {code} {payload[2:].decode(errors='replace')}".strip())
            if opcode == 0x9:
                self._control(0xA, payload[:125])
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                kind, message = opcode, payload
            elif opcode == 0x0:
                message += payload
            if fin:
                if kind == 0x1:
                    return message.decode(errors="replace")
                message, kind = b"", None

    def close(self) -> None:
        try:
            self._control(0x8, struct.pack("!H", 1000))
            self.sock.close()
        except OSError:
            pass


def this_machine_id() -> str:
    """The id this daemon serves under: `harness machines list --json` (the current one), else the auth session."""
    try:
        out = subprocess.run(["harness", "machines", "list", "--json"], capture_output=True, text=True, timeout=20).stdout
        for line in out.splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            rows = row if isinstance(row, list) else row.get("machines", [row]) if isinstance(row, dict) else []
            for each in rows:
                if isinstance(each, dict) and each.get("current") and each.get("machineId"):
                    return str(each["machineId"])
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        with open(os.path.expanduser("~/.harness/auth/session.json"), encoding="utf-8") as f:
            machine = json.load(f).get("machineId")
        if machine:
            return str(machine)
    except (OSError, json.JSONDecodeError):
        pass
    raise DaemonError("NOT_SIGNED_IN", "Could not find this machine's id. Run `harness login`, then `harness start`.")


class Daemon:
    """One session with the daemon: select this machine as a tool, then ask one request at a time."""

    def __init__(self, port: int = DEFAULT_PORT, machine_id: Optional[str] = None, timeout: float = 200.0) -> None:
        self.ws = WebSocket("127.0.0.1", port, LOCAL_WS_PATH)
        self.ws.sock.settimeout(timeout)
        self.ws.send(json.dumps({"type": "machine_select", "payload": {
            "machineId": machine_id or this_machine_id(), "localProtocolVersion": 1, "tool": True}}))
        while True:
            frame = json.loads(self.ws.recv())
            if frame.get("type") == "connected":
                return
            if frame.get("type") == "machine_select_error":
                raise DaemonError(str(frame.get("payload", {}).get("error", "MACHINE_UNAVAILABLE")))

    def request(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        self.ws.send(json.dumps({"type": kind, "payload": {**payload, "requestId": request_id}}))
        while True:
            try:
                frame = json.loads(self.ws.recv())
            except socket.timeout:
                raise DaemonError("TIMEOUT", f"Harness did not answer {kind} in time.")
            body = frame.get("payload") or {}
            if isinstance(body, dict) and body.get("requestId") == request_id:
                if body.get("error") is not None:
                    raise DaemonError(str(body["error"]), str(body.get("detail") or ""))
                return body

    def tell(self, kind: str, payload: dict[str, Any]) -> None:
        """A frame the daemon does not answer (`message`)."""
        self.ws.send(json.dumps({"type": kind, "payload": payload}))

    def close(self) -> None:
        self.ws.close()


# ---------------------------------------------------------------------------------------------------------------
# The harness
# ---------------------------------------------------------------------------------------------------------------

def fo_connected(daemon: Daemon) -> bool:
    agents = daemon.request("cloud_agents", {}).get("agents", [])
    return any(a.get("id") == "fo" and a.get("connected") for a in agents)


def live_agents(daemon: Daemon) -> dict[str, dict[str, Any]]:
    """Every harness this daemon lists, by id."""
    reply = daemon.request("agents_list", {})
    rows = reply.get("agents") or []
    return {str(a["id"]): a for a in rows if isinstance(a, dict) and a.get("id") and a.get("status") != "stopped"}


def create_harness(daemon: Daemon, engine: str, text: str) -> str:
    """A new harness with [text] as its first task; its agent id."""
    creation = str(uuid.uuid4())
    payload: dict[str, Any] = {"engine": engine, "name": HARNESS_NAMES[engine], "prompt": text, "creationId": creation}
    if engine == "claude":
        # A project folder Harness makes (~/harnesses/mail-inbox): Harness answers Claude Code's
        # "trust this folder?" for it, where a folder we name would wait for the person.
        payload.update({"projectSource": "new", "projectName": "mail-inbox"})
    reply = daemon.request("agent_create", payload)
    # A local launch may be held a moment (pending): asked after, as `harness new` does.
    for _ in range(60):
        if reply.get("state") not in ("pending", "unconfirmed"):
            break
        time.sleep(2)
        reply = daemon.request("agent_create_status", {"creationId": creation})
    if reply.get("state") not in (None, "created"):
        failure = reply.get("failure") or {}
        raise DaemonError(str(failure.get("code") or reply.get("state")), str(failure.get("detail") or ""))
    agent = reply.get("agent") or {}
    agent_id = agent.get("id") or agent.get("agentId") or reply.get("agentId")
    if not agent_id:
        raise DaemonError("UNCONFIRMED", f"agent_create answered without an agent: {json.dumps(reply)[:300]}")
    return str(agent_id)


def send_words(daemon: Daemon, engine: str, agent_id: str, text: str) -> None:
    if engine == "fo":
        daemon.request("cloud_send", {"agentId": agent_id, "text": text})
    else:
        # Typed into the pane, as the app's prompt box does; the daemon does not answer this frame.
        daemon.tell("message", {"agentId": agent_id, "content": text})


def fo_reply(daemon: Daemon, agent_id: str, after: int, timeout: float = 180.0) -> Optional[str]:
    """Fo's next words after message [after] of its conversation, or None when it says nothing in time."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        reply = daemon.request("cloud_transcript", {"agentId": agent_id})
        messages = reply.get("messages") or []
        total = int(reply.get("total") or len(messages))
        new = messages[len(messages) - (total - after):] if total > after else []
        said = [m.get("text", "") for m in new if m.get("from") == "agent"]
        if said:
            return said[-1]
        time.sleep(3)
    return None


def transcript_length(daemon: Daemon, agent_id: str) -> int:
    reply = daemon.request("cloud_transcript", {"agentId": agent_id})
    return int(reply.get("total") or len(reply.get("messages") or []))


def deliver(daemon: Daemon, state: dict[str, Any], state_path: str, engine: str, text: str,
            log: Callable[[str], None] = print) -> None:
    """Hand [text] to the long-lived harness: created on the first email, written to afterwards."""
    agent_id = state["agents"].get(engine)
    if agent_id and agent_id not in live_agents(daemon):
        log(f"{HARNESS_NAMES[engine]} ({agent_id}) is gone; starting a new one.")
        agent_id = None
    before = 0
    if agent_id:
        if engine == "fo":
            before = transcript_length(daemon, agent_id)
        send_words(daemon, engine, agent_id, text)
        log(f"Sent to {HARNESS_NAMES[engine]} ({agent_id}).")
    else:
        agent_id = create_harness(daemon, engine, text)
        state["agents"][engine] = agent_id
        save_state(state_path, state)
        log(f"Started {HARNESS_NAMES[engine]} ({agent_id}).")
    if engine == "fo":
        # Waiting keeps one email per turn: words sent while Fo works cut short the look for its reply.
        answer = fo_reply(daemon, agent_id, before)
        log(f"Fo: {answer}" if answer else "Fo has not answered yet; its reply still reaches the device.")
    else:
        # One email per turn here too: the next words wait until Claude's turn has ended.
        log("Claude finished its turn." if wait_idle(daemon, agent_id) else "Claude is still working; moving on.")


def wait_idle(daemon: Daemon, agent_id: str, timeout: float = 300.0) -> bool:
    """True once the harness has worked and is idle again (or never started working within 20 s)."""
    deadline, seen_working, began = time.time() + timeout, False, time.time()
    while time.time() < deadline:
        row = live_agents(daemon).get(agent_id) or {}
        activity = row.get("activity") or {}
        # "working" is a lease: it holds for validForMs unless renewed, so an expired one is idle.
        working = (activity.get("state") == "working" and float(activity.get("validForMs") or 0) > 0) \
            or (row.get("launch") or {}).get("state") == "starting"
        seen_working = seen_working or working
        if not working and (seen_working or time.time() - began > 20):
            return True
        time.sleep(3)
    return False


# ---------------------------------------------------------------------------------------------------------------
# IMAP
# ---------------------------------------------------------------------------------------------------------------

def poll_once(config: dict[str, str], state: dict[str, Any], state_path: str, engine: str, port: int,
              mark_read: bool) -> int:
    folder = config.get("IMAP_FOLDER") or "INBOX"
    imap = imaplib.IMAP4_SSL(config["IMAP_HOST"], ssl_context=ssl.create_default_context())
    handled = 0
    try:
        imap.login(config["IMAP_USER"], config["IMAP_APP_PASSWORD"])
        status, data = imap.select(f'"{folder}"', readonly=not mark_read)
        if status != "OK":
            raise RuntimeError(f"Cannot open folder {folder}: {data}")
        uidvalidity = (imap.response("UIDVALIDITY")[1] or [b"0"])[0]
        entry = folder_state(state, folder, uidvalidity.decode() if isinstance(uidvalidity, bytes) else str(uidvalidity))
        status, data = imap.uid("search", None, "UNSEEN")
        uids = [u.decode() for u in (data[0] or b"").split()] if status == "OK" else []
        fresh = [u for u in uids if not is_handled(entry, u)]
        if not fresh:
            return 0
        daemon = Daemon(port)
        try:
            for uid in fresh:
                # BODY.PEEK leaves the message unread.
                status, parts = imap.uid("fetch", uid, "(BODY.PEEK[])")
                raw = next((p[1] for p in parts or [] if isinstance(p, tuple)), None)
                if status != "OK" or raw is None:
                    continue
                print(f"New mail {uid}: {mail_summary(raw)['subject']}")
                deliver(daemon, state, state_path, engine, mail_to_text(raw))
                mark_handled(entry, uid)
                save_state(state_path, state)
                if mark_read:
                    imap.uid("store", uid, "+FLAGS", "(\\Seen)")
                handled += 1
        finally:
            daemon.close()
    finally:
        try:
            imap.logout()
        except Exception:
            pass
    return handled


def main(argv: Optional[list[str]] = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="New email -> Fo -> the round device.")
    parser.add_argument("--engine", choices=["fo", "claude"], default="fo", help="Fo in the cloud (default) or a local Claude Code harness")
    parser.add_argument("--env", default=os.path.join(here, ".env"), help="config file (default: .env beside this script)")
    parser.add_argument("--state", default=os.path.join(here, "state.json"), help="harness id and handled UIDs")
    parser.add_argument("--port", type=int, default=int(os.environ.get("HARNESS_PORT", DEFAULT_PORT)), help="the daemon's port")
    parser.add_argument("--mark-read", action="store_true", help="mark each handled message read")
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    parser.add_argument("--dry-run-message", metavar="FILE",
                        help="no IMAP: send one RFC 822 message from FILE ('-' for stdin) through the same path")
    parser.add_argument("--print-only", action="store_true", help="with --dry-run-message: print the text, send nothing")
    parser.add_argument("--check", action="store_true", help="say whether the daemon answers and Fo is connected, then exit")
    args = parser.parse_args(argv)

    try:
        if args.check:
            daemon = Daemon(args.port)
            try:
                ok = fo_connected(daemon)
                print("Fo is connected." if ok else "NOT_CONNECTED: Fo is not connected. Settings ▸ Connectors ▸ Add custom, https://mcp.api.wajo.ai/fo")
                return 0 if ok else 3
            finally:
                daemon.close()

        if args.dry_run_message:
            raw = sys.stdin.buffer.read() if args.dry_run_message == "-" else open(args.dry_run_message, "rb").read()
            text = mail_to_text(raw)
            if args.print_only:
                print(text)
                return 0
            state = load_state(args.state)
            daemon = Daemon(args.port)
            try:
                if args.engine == "fo" and not fo_connected(daemon):
                    raise DaemonError("NOT_CONNECTED", "Fo is not connected. Connect it, or run with --engine claude.")
                deliver(daemon, state, args.state, args.engine, text)
            finally:
                daemon.close()
            return 0

        config = load_env(args.env)
        missing = [k for k in ("IMAP_HOST", "IMAP_USER", "IMAP_APP_PASSWORD") if not config.get(k)]
        if missing:
            print(f"Missing in {args.env}: {', '.join(missing)} (copy .env.example to .env)", file=sys.stderr)
            return 2
        every = max(10, int(config.get("POLL_SECONDS") or 30))
        if args.engine == "fo":
            daemon = Daemon(args.port)
            try:
                if not fo_connected(daemon):
                    raise DaemonError("NOT_CONNECTED", "Fo is not connected. Connect it, or run with --engine claude.")
            finally:
                daemon.close()
        print(f"Watching {config.get('IMAP_FOLDER') or 'INBOX'} of {config['IMAP_USER']} every {every} s -> {HARNESS_NAMES[args.engine]}. Ctrl-C stops.")
        while True:
            state = load_state(args.state)
            try:
                poll_once(config, state, args.state, args.engine, args.port, args.mark_read)
            except (imaplib.IMAP4.error, OSError, RuntimeError) as error:
                print(f"Poll failed: {error}", file=sys.stderr)
            if args.once:
                return 0
            time.sleep(every)
    except DaemonError as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
