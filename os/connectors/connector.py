#!/usr/bin/env python3
# Adapted for Harness OS from Autonomous Intern, Apache-2.0.
# Upstream revision and changes: README.md in this directory.
"""Call a linked service without putting its credential in shell arguments.

The agent names a connector, a method and a URL; this helper reads the token
from the device's connector config, attaches it, sends the request, and prints
the response body. Tokens stay out of routine tool output. This is not a
security boundary against arbitrary code running as the same Unix user.

Usage:
  harness connections                     Open the Connectors page
  harness connections connect <code>      Sign in from the terminal
  harness connections list [--json]
  harness connections info <code>
  harness connections disconnect <code>
  harness connections refresh [<code>]    Renew tokens that are due
  harness connections sync                Give agents their connections again
  harness connections call <code> <METHOD> <url> [options]

Options for `call`:
  --query K=V        URL query parameter, URL-encoded for you (repeatable)
  --json BODY        JSON request body; `-` reads it from stdin
  --data K=V         form field, sent application/x-www-form-urlencoded (repeatable)
  --form K=V         multipart field; `K=@/path` uploads a file (repeatable)
  --header K:V       extra request header (repeatable; Authorization is refused)
  --token-param NAME send the credential as query parameter NAME instead of a
                     header (repeatable; only for endpoints that reject the header)

Exit codes: 0 success (2xx) · 1 HTTP error or network failure · 2 usage error ·
3 not connected / unusable credential · 4 host not allowed for this connector.
On any failure nothing is written to stdout, so a following `| jq` sees empty
input instead of an error body it could mistake for an empty result.
"""
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
import connection_store as store

CONFIGS_DIR = store.directory()
TIMEOUT_SECONDS = 60
MAX_RESPONSE_BYTES = 8 * 1024 * 1024

# Official API hosts per connector. A credential is only ever sent to one of
# these (exact host or a subdomain of it). A connector that is not listed is
# refused: the helper never sends a credential to a host it cannot vouch for.
# Services signed in through the connector gateway hold an ordinary OAuth token
# for their REST API. A service signed in from this computer (MCP OAuth) holds a
# token for its MCP server instead: agents use it through their MCP tools.
OFFICIAL_HOSTS = {
    "gmail": ("googleapis.com",),
    "google_calendar": ("googleapis.com",),
    "google_drive": ("googleapis.com",),
    "google_bigquery": ("googleapis.com",),
    "github": ("api.github.com",),
    "slack": ("slack.com",),
    "asana": ("app.asana.com",),
    "hubspot": ("api.hubapi.com",),
    "pagerduty": ("api.pagerduty.com",),
    "microsoft_365": ("graph.microsoft.com",),
}

# Connectors whose API only accepts the credential as a query parameter on
# some endpoints. None of the current services need it.
TOKEN_PARAM_CODES = ()

# Files that may be uploaded with `--form K=@path`: media and documents only,
# never from a directory that holds credentials or device configuration.
UPLOAD_SUFFIXES = (
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
    ".mp4", ".mov", ".webm", ".mp3", ".m4a", ".wav", ".ogg",
    ".pdf", ".txt", ".md", ".csv",
)
UPLOAD_FORBIDDEN_DIRS = tuple(str(p.resolve()) for p in (
    CONFIGS_DIR, Path.home() / ".ssh", Path.home() / ".gnupg",
    Path.home() / ".config", Path.home() / ".local/share", Path.home() / ".harness",
    Path.home() / ".codex", Path.home() / ".claude", Path("/etc"), Path("/proc"), Path("/sys"),
))
UPLOAD_ALLOWED_DIRS = ()


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fmt_time(ts):
    """Local time plus the zone, so nobody reads a UTC stamp as local."""
    if not ts:
        return "never"
    return time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(int(ts)))


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        raise Failure(3, f"cannot read {path.name}: {type(e).__name__}")


def vault():
    return store.Store(CONFIGS_DIR)


def cmd_list(as_json=False):
    """Discover the same per-user connections regardless of the current agent."""
    try:
        tokens = vault().tokens()
    except store.StoreError as e:
        print(f"verification failed: {e}", file=sys.stderr)
        return 3
    records = [vault().status(code, token) for code, token in sorted(tokens.items())]
    if as_json:
        print(json.dumps(records))
    elif not records:
        print("no connectors linked")
    for record in [] if as_json else records:
        print(describe(record))
    return 0


def describe(record):
    how = "MCP tools" if record["tools"] else "harness connections call"
    parts = [record.get("account"), how]
    return f"{record['connector']}: {record['state']} (" + ", ".join(p for p in parts if p) + ")"


def cmd_info(code):
    token = vault().token(code)
    if not token:
        raise Failure(3, f"{code}: not connected")
    record = vault().status(code, token)
    expires = int(token.get("expires_at") or 0)
    info = {
        "connector": code,
        "name": record["name"],
        "state": record["state"],
        "account": record.get("account", ""),
        "signed_in_through": "Harness account" if token.get("source") == "gateway" else "this computer",
        "scopes": record["scopes"],
        "agent_tools": record["tools"],
        "rest_call": code in OFFICIAL_HOSTS and token.get("source") == "gateway",
        "auto_refresh": record["auto_refresh"],
        "expires": "not reported" if not expires else fmt_time(expires),
        "obtained": fmt_time(token.get("obtained_at")),
    }
    print(json.dumps(info, indent=2))
    return 0


def host_allowed(code, host):
    allowed = OFFICIAL_HOSTS.get(code)
    if not allowed:
        return False
    return any(host == h or host.endswith("." + h) for h in allowed)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would re-send the Authorization header
    (and a credential in the query) to wherever the Location points."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def upload_path(raw):
    """Resolve an `@path` upload and refuse anything that is not plain media or
    a document outside the device's credential and configuration folders."""
    path = Path(raw).expanduser()
    try:
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise Failure(2, f"cannot read upload {raw}")
    text = str(real)
    allowed_dir = any(text == d or text.startswith(d + "/") for d in UPLOAD_ALLOWED_DIRS)
    forbidden_dir = any(text == d or text.startswith(d + "/") for d in UPLOAD_FORBIDDEN_DIRS)
    if (forbidden_dir and not allowed_dir) or not real.is_file():
        raise Failure(2, f"refusing to upload {raw}: not a media file the helper may send")
    if real.suffix.lower() not in UPLOAD_SUFFIXES or path.suffix.lower() not in UPLOAD_SUFFIXES:
        raise Failure(2, f"refusing to upload {raw}: only {', '.join(UPLOAD_SUFFIXES)} files")
    return real


def pair(value, sep, flag):
    if sep not in value:
        raise Failure(2, f"{flag} expects K{sep}V, got {value!r}")
    k, v = value.split(sep, 1)
    return k.strip(), v if sep == "=" else v.strip()


def multipart(fields):
    boundary = uuid.uuid4().hex
    chunks = []
    for key, value in fields:
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"'
        if value.startswith("@"):
            path = upload_path(value[1:])
            try:
                content = path.read_bytes()
            except OSError as e:
                raise Failure(2, f"cannot read upload {path}: {type(e).__name__}")
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            head += f'; filename="{path.name}"\r\nContent-Type: {ctype}'
        else:
            content = value.encode()
        chunks += [head.encode() + b"\r\n\r\n", content, b"\r\n"]
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def parse_call_args(args):
    opts = {"query": [], "json": None, "data": [], "form": [], "header": [], "token_param": []}
    i = 0
    while i < len(args):
        flag = args[i]
        if i + 1 >= len(args):
            raise Failure(2, f"{flag} needs a value")
        value = args[i + 1]
        if flag == "--query":
            opts["query"].append(pair(value, "=", flag))
        elif flag == "--data":
            opts["data"].append(pair(value, "=", flag))
        elif flag == "--form":
            opts["form"].append(pair(value, "=", flag))
        elif flag == "--header":
            opts["header"].append(pair(value, ":", flag))
        elif flag == "--json":
            opts["json"] = sys.stdin.read() if value == "-" else value
        elif flag == "--token-param":
            opts["token_param"].append(value)
        else:
            raise Failure(2, f"unknown option {flag}")
        i += 2
    if sum(bool(x) for x in (opts["json"] is not None, opts["data"], opts["form"])) > 1:
        raise Failure(2, "use only one of --json, --data, --form")
    return opts


def cmd_call(code, method, url, args, *, entry_override=None):
    opts = parse_call_args(args)
    method = method.upper()

    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise Failure(4, f"refusing {url!r}: only https:// URLs are allowed")
    if parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443):
        raise Failure(4, f"refusing {url!r}: no user info or custom port in the URL")
    if code not in OFFICIAL_HOSTS:
        raise Failure(4, f"{code}: the helper has no official API host for this connector — use its MCP tools if it has them")
    if not host_allowed(code, parsed.hostname):
        allowed = ", ".join(OFFICIAL_HOSTS[code])
        raise Failure(4, f"refusing to send the {code} credential to {parsed.hostname}; allowed: {allowed}")
    if opts["token_param"] and code not in TOKEN_PARAM_CODES:
        raise Failure(2, f"--token-param is only for {', '.join(TOKEN_PARAM_CODES)}")

    entry = entry_override if entry_override is not None else vault().ready(code)
    if entry.get("source") not in (None, "gateway"):
        raise Failure(3, f"{code}: this account's token is for its MCP server; use the agent's {code} tools")
    token = entry.get("access_token")
    if not token:
        raise Failure(3, f"{code}: linked but no usable credential stored")

    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True) + opts["query"]
    for name in opts["token_param"]:
        query.append((name, token))
    full_url = urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), "")
    )

    headers = {"Accept": "application/json", "User-Agent": "Harness-Connections"}
    for k, v in opts["header"]:
        if k.lower() in ("authorization", "host", "proxy-authorization", "cookie"):
            raise Failure(2, f"do not pass {k}; the helper sets it (or it is not allowed)")
        headers[k] = v
    if not opts["token_param"]:
        headers["Authorization"] = store.bearer(entry)

    body = None
    if opts["json"] is not None:
        body = opts["json"].encode()
        headers.setdefault("Content-Type", "application/json")
    elif opts["data"]:
        body = urllib.parse.urlencode(opts["data"]).encode()
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    elif opts["form"]:
        body, headers["Content-Type"] = multipart(opts["form"])

    req = urllib.request.Request(full_url, data=body, method=method, headers=headers)
    try:
        with _OPENER.open(req, timeout=TIMEOUT_SECONDS) as resp:
            out = resp.read(MAX_RESPONSE_BYTES + 1)
            if len(out) > MAX_RESPONSE_BYTES:
                raise Failure(1, "Response is too large. Use a smaller page size.")
            status = resp.status
    except urllib.error.HTTPError as e:
        detail = e.read(MAX_RESPONSE_BYTES).decode("utf-8", "replace")
        print(f"HTTP {e.code} from {parsed.hostname}", file=sys.stderr)
        if 300 <= e.code < 400:
            print("redirect not followed: the credential is only sent to the official host", file=sys.stderr)
        elif detail.strip():
            print(scrub_entry(detail, entry), file=sys.stderr)
        if e.code == 401:
            expires = int(entry.get("expires_at") or 0)
            print(
                f"credential: expires {fmt_time(expires) if expires else 'not reported'}; "
                "reconnect in harness connections",
                file=sys.stderr,
            )
        return 1
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        print(f"request to {parsed.hostname} failed: {type(reason).__name__}", file=sys.stderr)
        return 1

    text = out.decode("utf-8", "replace")
    if text:
        sys.stdout.write(scrub_entry(text, entry))
        if not text.endswith("\n"):
            sys.stdout.write("\n")
    elif status == 204:
        print("{}")
    return 0


def scrub_entry(text, entry):
    for field in ("access_token", "refresh_token", "api_key"):
        text = scrub(text, entry.get(field))
    return text


def scrub(text, token):
    if not token:
        return text
    for form in {token, urllib.parse.quote(token, safe=""), urllib.parse.quote_plus(token)}:
        text = text.replace(form, "[credential]")
    return text


def main(argv):
    try:
        if argv in (["list"], ["list", "--json"]):
            return cmd_list("--json" in argv)
        if len(argv) == 2 and argv[0] == "info":
            return cmd_info(argv[1])
        if len(argv) >= 4 and argv[0] == "call":
            return cmd_call(argv[1], argv[2], argv[3], argv[4:])
        if len(argv) == 2 and argv[0] == "disconnect":
            vault().disconnect(argv[1])
            print("Disconnected on this computer. Revoke access at the provider to remove it elsewhere.")
            return 0
        print(__doc__.split("\n\n", 2)[2], file=sys.stderr)
        return 2
    except Failure as e:
        print(str(e), file=sys.stderr)
        return e.code
    except store.StoreError as e:
        print(str(e), file=sys.stderr)
        return 3
    except BrokenPipeError:
        raise
    except Exception as e:  # never let a traceback echo request details
        print(f"connector helper failed: {type(e).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
        sys.stdout.flush()
    except BrokenPipeError:
        # The reader (e.g. a failing `| jq`) closed the pipe; its own error is
        # the one worth showing, not a Python traceback.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        code = 1
    sys.exit(code)
