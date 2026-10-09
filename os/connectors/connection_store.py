"""Per-user connection store: one private tokens.json shared by every local agent.

The token format follows Grid's ~/.grid/connectors/tokens.json, keyed by
connector code. Agents never read it: MCP clients reach a service through the
local bridge, and `harness connections call` reads a credential for one request.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import urllib.parse
import urllib.request

CATALOG_FILE = Path(__file__).parent / "catalog.json"
MAX_BYTES = 1024 * 1024
# A token is renewed this long before it expires, as Grid does.
REFRESH_MARGIN = 300
CODE = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}")


class StoreError(Exception):
    """Safe, credential-free diagnostic."""


def directory():
    base = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    return Path(os.environ.get("CONNECTOR_CONFIGS_DIR", str(base / "harness-os/connections")))


def load_catalog():
    with open(CATALOG_FILE) as handle:
        return {item["code"]: item for item in json.load(handle)["connectors"]}


CATALOG = load_catalog()
SERVICES = {code: item["label"] for code, item in CATALOG.items()}


def validate_code(code):
    if not isinstance(code, str) or not CODE.fullmatch(code):
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


def text(value, limit=8192):
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise StoreError("Invalid connection fields.")
    return value


def clean_headers(headers):
    if headers in (None, {}):
        return {}
    if not isinstance(headers, dict) or len(headers) > 20:
        raise StoreError("Invalid connection headers.")
    result = {}
    for name, value in headers.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", name):
            raise StoreError("Invalid connection headers.")
        result[name] = text(value)
    return result


def clean_url(url):
    url = text(url, 2048)
    parsed = urllib.parse.urlsplit(url)
    local = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if not (parsed.scheme == "https" or local) or not parsed.hostname or parsed.username or parsed.password:
        raise StoreError("Use an https:// address for the server.")
    return url


def clean_token(entry):
    """A tokens.json entry, as Grid writes it, with nothing unexpected kept."""
    if not isinstance(entry, dict):
        raise StoreError("Invalid connection.")
    result = {}
    for key in ("access_token", "refresh_token", "token_type", "scope", "account_name", "source", "issuer", "label"):
        value = text(entry.get(key))
        if value:
            result[key] = value
    if result.get("source", "dcr") not in ("dcr", "gateway", "custom"):
        raise StoreError("Unsupported connection source.")
    for key in ("expires_at", "obtained_at"):
        value = entry.get(key, 0)
        if type(value) is not int or value < 0:
            raise StoreError("Invalid connection expiry.")
        if value:
            result[key] = value
    for key in ("refresh", "needs_reconnect"):
        if entry.get(key) is True:
            result[key] = True
    mcp = entry.get("mcp_entry")
    if mcp:
        if not isinstance(mcp, dict):
            raise StoreError("Invalid connection server.")
        result["mcp_entry"] = {"url": clean_url(mcp.get("url")), "headers": clean_headers(mcp.get("headers"))}
    if not (result.get("access_token") or result.get("mcp_entry")):
        raise StoreError("No access token was supplied.")
    return result


def bearer(token):
    """The Authorization value for a token, its scheme normalised as Grid does."""
    scheme = token.get("token_type") or "Bearer"
    return ("Bearer" if scheme.lower() == "bearer" else scheme) + " " + token["access_token"]


def needs_refresh(token, now=None):
    expires = token.get("expires_at", 0)
    now = time.time() if now is None else now
    return bool(expires) and expires - REFRESH_MARGIN <= now and refreshable(token) and not token.get("needs_reconnect")


def refreshable(token):
    if token.get("source") == "gateway":
        return token.get("refresh") is True
    return bool(token.get("refresh_token"))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Store:
    """tokens.json (credentials), clients.json (registered OAuth clients, by issuer)."""

    def __init__(self, root=None):
        self.root = directory() if root is None else Path(root)

    def file(self, name):
        if self.root.is_symlink():
            raise StoreError("Connection storage must not be a symlink.")
        return read_private(self.root / name) or {}

    def tokens(self):
        data = self.file("tokens.json")
        result = {}
        for code, entry in data.items():
            if isinstance(code, str) and CODE.fullmatch(code):
                result[code] = clean_token(entry)
        return result

    def token(self, code):
        return self.tokens().get(validate_code(code))

    def put(self, code, entry):
        """Save one connection, replacing it. Call under locked()."""
        validate_code(code)
        data = self.file("tokens.json")
        data[code] = clean_token(entry)
        write_private(self.root / "tokens.json", data)

    def save(self, code, entry):
        with locked(self.root):
            self.put(code, entry)

    def disconnect(self, code):
        validate_code(code)
        with locked(self.root):
            data = self.file("tokens.json")
            if data.pop(code, None) is not None:
                write_private(self.root / "tokens.json", data)

    def client(self, issuer):
        entry = self.file("clients.json").get(issuer)
        return entry if isinstance(entry, dict) else None

    def save_client(self, issuer, client):
        with locked(self.root):
            data = self.file("clients.json")
            data[issuer] = client
            write_private(self.root / "clients.json", data)

    def label(self, code):
        if code in CATALOG:
            return CATALOG[code]["label"]
        token = self.token(code)
        return (token or {}).get("label") or code

    def status(self, code, token=None):
        token = token if token is not None else self.token(code)
        base = {"connector": code, "name": self.label(code)}
        if not token:
            return dict(base, state="not_connected")
        expires = token.get("expires_at", 0)
        expired = bool(expires) and expires <= time.time()
        state = "reconnect" if token.get("needs_reconnect") or (expired and not refreshable(token)) else "connected"
        return dict(base, state=state, account=token.get("account_name", ""), source=token.get("source", "dcr"),
                    scopes=(token.get("scope") or "").split(), expires_at=expires or None,
                    auto_refresh=refreshable(token), tools=bool(token.get("mcp_entry")))

    def ready(self, code):
        """A usable token for one request, renewed first when it is about to expire."""
        token = self.token(code)
        if not token:
            raise StoreError("Not connected. Open harness connections to connect an account.")
        if needs_refresh(token):
            import renew
            token = renew.refresh(self, code)
        expires = token.get("expires_at", 0)
        if token.get("needs_reconnect") or (expires and expires <= time.time()):
            raise StoreError("This account has expired. Reconnect it in Connections.")
        if not token.get("access_token"):
            raise StoreError("This connection has no account token.")
        return token

