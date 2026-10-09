"""Sign in to an MCP server from this computer: MCP OAuth with dynamic client
registration (RFC 7591), PKCE S256 and a 127.0.0.1 redirect — Grid's `dcr` path.

No client secret ships with Harness: each computer registers its own public
client with the service and keeps it in clients.json.
"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import connection_store as store

TIMEOUT = 15
SIGN_IN_SECONDS = 300
# Grid's preferred loopback ports, then any free one.
PORTS = (51789, 51790, 51791, 51792)
_OPENER = urllib.request.build_opener(store.NoRedirect, urllib.request.ProxyHandler({}))


class SignInError(store.StoreError):
    pass


def http(url, data=None, headers=None, method=None):
    """(status, headers, body) without following redirects or raising on HTTP errors."""
    request = urllib.request.Request(url, data=data, method=method, headers={
        "User-Agent": "Harness-Connections", "Accept": "application/json", **(headers or {})})
    try:
        with _OPENER.open(request, timeout=TIMEOUT) as response:
            return response.status, response.headers, response.read(store.MAX_BYTES)
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.headers, error.read(store.MAX_BYTES)
    except (urllib.error.URLError, OSError, ValueError):
        raise SignInError("Could not reach the service. Check the connection and try again.")


def json_of(body):
    try:
        data = json.loads(body)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def well_known(base, name, path=""):
    parsed = urllib.parse.urlsplit(base)
    return f"{parsed.scheme}://{parsed.netloc}/.well-known/{name}{path.rstrip('/')}"


def probe(url):
    """What signing in to this MCP server takes: {'kind': 'open'} or OAuth metadata."""
    url = store.clean_url(url)
    initialize = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "Harness", "version": "1"}}}).encode()
    status, headers, _ = http(url, initialize, {"Content-Type": "application/json",
                                                "Accept": "application/json, text/event-stream"})
    if 200 <= status < 300:
        return {"kind": "open"}
    if status not in (401, 403):
        raise SignInError(f"The server answered {status}. Check the address.")
    challenge = headers.get("WWW-Authenticate", "")
    match = re.search(r'resource_metadata="([^"]+)"', challenge)
    path = urllib.parse.urlsplit(url).path
    candidates = [match.group(1)] if match else []
    candidates += [well_known(url, "oauth-protected-resource", path), well_known(url, "oauth-protected-resource")]
    resource, issuer, scopes = url, None, []
    for candidate in candidates:
        status, _, body = http(candidate)
        meta = json_of(body) if status == 200 else None
        if meta and isinstance(meta.get("authorization_servers"), list) and meta["authorization_servers"]:
            issuer = meta["authorization_servers"][0]
            resource = meta.get("resource") or url
            scopes = [s for s in meta.get("scopes_supported") or [] if isinstance(s, str)]
            break
    issuer = issuer or "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(url))
    issuer_path = urllib.parse.urlsplit(issuer).path
    for candidate in (well_known(issuer, "oauth-authorization-server", issuer_path),
                      well_known(issuer, "openid-configuration", issuer_path),
                      issuer.rstrip("/") + "/.well-known/openid-configuration"):
        status, _, body = http(candidate)
        meta = json_of(body) if status == 200 else None
        if meta and meta.get("authorization_endpoint") and meta.get("token_endpoint"):
            for key in ("authorization_endpoint", "token_endpoint", "registration_endpoint"):
                if meta.get(key):
                    store.clean_url(meta[key])
            return {
                "kind": "oauth", "issuer": issuer, "resource": resource, "scopes": scopes,
                "authorization_endpoint": meta["authorization_endpoint"], "token_endpoint": meta["token_endpoint"],
                "registration_endpoint": meta.get("registration_endpoint"),
                "s256": "S256" in (meta.get("code_challenge_methods_supported") or ["S256"]),
                "auth_methods": meta.get("token_endpoint_auth_methods_supported") or ["client_secret_basic"],
            }
    raise SignInError("This server does not say how to sign in.")


class Callback(HTTPServer):
    """One sign-in's redirect target on 127.0.0.1."""

    def __init__(self, port):
        self.result = None
        self.done = threading.Event()
        super().__init__(("127.0.0.1", port), CallbackHandler)
        self.timeout = 1

    @property
    def redirect_uri(self):
        return f"http://127.0.0.1:{self.server_address[1]}/callback"


class CallbackHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/callback":
            self.send_error(404)
            return
        query = dict(urllib.parse.parse_qsl(parsed.query))
        self.server.result = query
        ok = "code" in query
        page = ("<!doctype html><meta charset=utf-8><title>Harness</title>"
                "<body style='font:16px ui-monospace,monospace;background:#11140f;color:#e7e8de;padding:48px'>"
                + ("<h1>Connected.</h1><p>You can close this tab and return to Harness.</p><script>setTimeout(()=>window.close(),800)</script>"
                   if ok else "<h1>Not connected.</h1><p>Return to Harness and try again.</p>")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(page)
        self.server.done.set()


def listen():
    for port in PORTS + (0,):
        try:
            return Callback(port)
        except OSError:
            continue
    raise SignInError("Could not open a local sign-in address.")


def pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def register(vault, meta, redirect_uri):
    """This computer's OAuth client for the issuer, registered once and reused."""
    known = vault.client(meta["issuer"])
    if known and known.get("redirect_uri") == redirect_uri and known.get("client_id"):
        return known
    if not meta.get("registration_endpoint"):
        raise SignInError("This service does not let a computer register itself.")
    status, _, body = http(meta["registration_endpoint"], json.dumps({
        "client_name": "Harness", "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
        "token_endpoint_auth_method": "none", "application_type": "native",
    }).encode(), {"Content-Type": "application/json"})
    data = json_of(body)
    if status not in (200, 201) or not data or not isinstance(data.get("client_id"), str):
        raise SignInError("The service refused to register Harness on this computer.")
    secret = data.get("client_secret") if isinstance(data.get("client_secret"), str) else ""
    method = data.get("token_endpoint_auth_method") or ("client_secret_basic" if secret else "none")
    client = {"client_id": data["client_id"], "client_secret": secret, "token_endpoint_auth_method": method,
              "authorization_endpoint": meta["authorization_endpoint"], "token_endpoint": meta["token_endpoint"],
              "redirect_uri": redirect_uri, "registered_at": int(time.time())}
    vault.save_client(meta["issuer"], client)
    return client


def token_request(client, form):
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    form = dict(form, client_id=client["client_id"])
    if client.get("client_secret"):
        if client.get("token_endpoint_auth_method") == "client_secret_post":
            form["client_secret"] = client["client_secret"]
        else:
            pair = f"{urllib.parse.quote(client['client_id'])}:{urllib.parse.quote(client['client_secret'])}"
            headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
    status, _, body = http(client["token_endpoint"], urllib.parse.urlencode(form).encode(), headers)
    data = json_of(body) or {}
    if status != 200 or not isinstance(data.get("access_token"), str):
        error = data.get("error") if isinstance(data.get("error"), str) else ""
        raise SignInError("invalid_grant" if error == "invalid_grant" else "The service did not issue a token.")
    return data


def token_from(data, mcp_url, issuer, previous=None):
    now = int(time.time())
    expires_in = data.get("expires_in")
    token = {
        "access_token": data["access_token"], "token_type": data.get("token_type") or "Bearer",
        "refresh_token": data.get("refresh_token") or (previous or {}).get("refresh_token", ""),
        "expires_at": now + int(expires_in) if isinstance(expires_in, (int, float)) and expires_in > 0 else 0,
        "scope": data.get("scope") if isinstance(data.get("scope"), str) else (previous or {}).get("scope", ""),
        "source": "dcr", "issuer": issuer, "obtained_at": now,
        "account_name": (previous or {}).get("account_name", ""),
    }
    token["mcp_entry"] = {"url": mcp_url, "headers": {"Authorization": store.bearer(token)}}
    if token["refresh_token"]:
        token["refresh"] = True
    return token


class SignIn:
    """One browser sign-in: prepare() returns the address to open, wait() the token."""

    def __init__(self, vault, mcp_url):
        self.vault, self.mcp_url = vault, store.clean_url(mcp_url)
        self.server = None

    def prepare(self):
        self.meta = probe(self.mcp_url)
        if self.meta["kind"] == "open":
            return None
        if not self.meta["s256"]:
            raise SignInError("This service does not support a secure sign-in from a computer.")
        self.server = listen()
        try:
            self.client = register(self.vault, self.meta, self.server.redirect_uri)
        except BaseException:
            self.server.server_close()
            raise
        self.verifier, challenge = pkce()
        self.state = secrets.token_urlsafe(24)
        query = {"response_type": "code", "client_id": self.client["client_id"], "redirect_uri": self.server.redirect_uri,
                 "state": self.state, "code_challenge": challenge, "code_challenge_method": "S256"}
        if self.meta.get("resource"):
            query["resource"] = self.meta["resource"]
        if self.meta.get("scopes"):
            query["scope"] = " ".join(self.meta["scopes"])
        separator = "&" if "?" in self.client["authorization_endpoint"] else "?"
        return self.client["authorization_endpoint"] + separator + urllib.parse.urlencode(query)

    def wait(self, cancelled=lambda: False):
        if self.server is None:
            return {"mcp_entry": {"url": self.mcp_url, "headers": {}}, "source": "dcr", "obtained_at": int(time.time())}
        try:
            deadline = time.monotonic() + SIGN_IN_SECONDS
            while not self.server.done.is_set():
                if time.monotonic() > deadline or cancelled():
                    raise SignInError("The sign-in was not finished in time.")
                self.server.handle_request()
        finally:
            self.server.server_close()
        result = self.server.result or {}
        if not secrets.compare_digest(result.get("state", ""), self.state):
            raise SignInError("The sign-in could not be confirmed. Try again.")
        if "code" not in result:
            raise SignInError("The sign-in was cancelled." if result.get("error") == "access_denied"
                              else "The service did not complete the sign-in.")
        form = {"grant_type": "authorization_code", "code": result["code"],
                "redirect_uri": self.server.redirect_uri, "code_verifier": self.verifier}
        if self.meta.get("resource"):
            form["resource"] = self.meta["resource"]
        return token_from(token_request(self.client, form), self.mcp_url, self.meta["issuer"])


def refresh(vault, token):
    """A renewed dcr token, through this computer's registered client."""
    client = vault.client(token.get("issuer", ""))
    if not client or not token.get("refresh_token"):
        raise SignInError("invalid_grant")
    mcp_url = token["mcp_entry"]["url"]
    form = {"grant_type": "refresh_token", "refresh_token": token["refresh_token"]}
    form["resource"] = mcp_url
    try:
        data = token_request(client, form)
    except SignInError as error:
        if str(error) != "invalid_grant":
            # A service may reject the resource parameter on refresh; ask once more without it.
            del form["resource"]
            data = token_request(client, form)
        else:
            raise
    return token_from(data, mcp_url, token["issuer"], previous=token)
