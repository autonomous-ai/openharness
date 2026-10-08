"""Per-user Intern-format credentials. No engine-specific copies or cloud sync."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import urllib.request

SERVICES = {
    "gmail": "Gmail", "google_calendar": "Google Calendar", "google_drive": "Google Drive",
    "github": "GitHub", "notion": "Notion", "linear": "Linear", "asana": "Asana",
    "figma": "Figma", "figma-api": "Figma API", "facebook": "Facebook", "ahrefs": "Ahrefs",
}
MAX_BYTES = 65536


class StoreError(Exception):
    """Safe, credential-free diagnostic."""


def directory():
    base = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    return Path(os.environ.get("CONNECTOR_CONFIGS_DIR", str(base / "harness-os/connections")))


def validate_code(code):
    if code not in SERVICES:
        raise StoreError("Unknown connection.")
    return code


def private_directory(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise StoreError("Connections must be stored in your own directory, without a symlink.")
    root.chmod(0o700)


def read_private(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise StoreError("Cannot read connection settings.")
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > MAX_BYTES):
            raise StoreError("Connection settings must be private, regular files owned by you.")
        try:
            data = json.loads(handle.read(MAX_BYTES + 1))
        except (ValueError, OSError):
            raise StoreError("Cannot read connection settings.")
    if not isinstance(data, dict):
        raise StoreError("Invalid connection settings.")
    return data


def write_private(path, data):
    private_directory(path.parent)
    raw = (json.dumps(data, indent=2) + "\n").encode()
    if len(raw) > MAX_BYTES:
        raise StoreError("Connection settings are too large.")
    fd, name = tempfile.mkstemp(prefix=".incoming-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


@contextlib.contextmanager
def locked(root):
    private_directory(root)
    fd = os.open(root / ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, "r+") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise StoreError("Invalid connection lock.")
        # Serialize credential changes across agents running as this user.
        deadline = time.monotonic() + 35
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise StoreError("Another connection operation is still running. Try again.")
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)


def clean_entry(entry):
    if not isinstance(entry, dict):
        raise StoreError("Invalid connection.")
    result = {}
    for key in ("access_token", "api_key", "refresh_token", "token_type", "client_id", "user_email", "auth_type"):
        value = entry.get(key, "")
        if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise StoreError("Invalid connection fields.")
        if value:
            result[key] = value
    if result.get("auth_type", "oauth") not in ("pat", "oauth"):
        raise StoreError("Unsupported authentication type.")
    if not (result.get("access_token") or result.get("api_key")):
        raise StoreError("No access token was supplied.")
    for key in ("expires_at", "obtained_at"):
        value = entry.get(key, 0)
        if type(value) is not int or value < 0:
            raise StoreError("Invalid connection expiry.")
        result[key] = value
    scopes = entry.get("scopes", [])
    if not isinstance(scopes, list) or len(scopes) > 100 or any(not isinstance(s, str) or len(s) > 1024 for s in scopes):
        raise StoreError("Invalid connection permissions.")
    result["scopes"] = scopes
    result["refresh"] = entry.get("refresh") is True
    creds = entry.get("credentials", {})
    if not isinstance(creds, dict):
        raise StoreError("Invalid connection metadata.")
    result["credentials"] = {k: v for k, v in creds.items() if k in ("page_id", "email") and isinstance(v, str) and len(v) < 1024}
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Store:
    def __init__(self, root=None):
        self.root = directory() if root is None else Path(root)

    def path(self, code):
        return self.root / (validate_code(code) + "_access_tokens.json")

    def load(self, code):
        if self.root.is_symlink():
            raise StoreError("Connection storage must not be a symlink.")
        data = read_private(self.path(code))
        if data is None:
            return None
        entries = data.get("connectors")
        if not isinstance(entries, dict):
            raise StoreError("Invalid connection settings.")
        entry = entries.get(code)
        return clean_entry(entry)

    def save(self, code, entry):
        path = self.path(code)
        entry = clean_entry(entry)
        with locked(self.root):
            write_private(path, {"connectors": {code: entry}})

    def disconnect(self, code):
        path = self.path(code)
        with locked(self.root):
            path.unlink(missing_ok=True)

    def ready(self, code):
        with locked(self.root):
            entry = self.load(code)
            if not entry:
                raise StoreError("Not connected. Open harness connections to connect an account.")
            expires = entry["expires_at"]
            if expires and expires <= time.time():
                raise StoreError("This account has expired. Reconnect it in Connections.")
            return entry

    def status(self, code):
        entry = self.load(code)
        if not entry:
            return {"connector": code, "name": SERVICES[code], "state": "not_connected", "scopes": []}
        expires = entry["expires_at"]
        return {
            "connector": code, "name": SERVICES[code],
            "state": "expired" if expires and expires <= time.time() else "connected",
            "account": entry.get("user_email") or entry["credentials"].get("email", ""),
            "auth_type": entry.get("auth_type", "oauth"), "scopes": entry["scopes"],
            "expires_at": expires or None,
            "auto_refresh": False,  # Browser authorization and renewal are not enabled yet.
        }
