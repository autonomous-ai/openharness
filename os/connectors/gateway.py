"""The Autonomous connector gateway, for services that do not let a computer
register itself (Grid's `app` path). The gateway holds the service's OAuth app;
this computer starts a sign-in, polls for its one-time result and stores the
token like any other. It needs the Grid session `harness login` keeps in
~/.grid/credentials.toml, as the Harness CLI's model catalog does.
"""
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

import connection_store as store

TIMEOUT = 20
DEFAULT_API = "https://api-grid.autonomous.ai"
_OPENER = urllib.request.build_opener(store.NoRedirect, urllib.request.ProxyHandler({}))


class GatewayError(store.StoreError):
    pass


def credentials_path():
    configured = os.environ.get("GRID_HOME")
    home = Path(configured).expanduser() if configured else Path.home() / ".grid"
    return home / "credentials.toml"


def session():
    """(api_url, session_token) from the top table of credentials.toml, or None."""
    try:
        top = re.split(r"^\s*\[", credentials_path().read_text(), maxsplit=1, flags=re.M)[0]
    except OSError:
        return None

    def value(name):
        match = re.search(rf'^\s*{name}\s*=\s*("(?:[^"\\]|\\.)*"|\'[^\']*\')\s*$', top, re.M)
        if not match:
            return ""
        raw = match.group(1)
        try:
            return json.loads(raw) if raw[0] == '"' else raw[1:-1]
        except ValueError:
            return ""

    token = value("session_token")
    if not token:
        return None
    base = value("api_url") or os.environ.get("GRID_CONTROL_PLANE_URL") or DEFAULT_API
    store.clean_url(base)
    return base.rstrip("/"), token


def call(path, body=None):
    found = session()
    if not found:
        raise GatewayError("Sign in to Harness first (harness login) to connect this service.")
    base, token = found
    request = urllib.request.Request(f"{base}/v1/grid/{path}", method="POST" if body is not None else "GET",
                                     data=json.dumps(body).encode() if body is not None else None, headers={
                                         "Authorization": "Bearer " + token, "Accept": "application/json",
                                         "Content-Type": "application/json", "User-Agent": "Harness-Connections"})
    try:
        with _OPENER.open(request, timeout=TIMEOUT) as response:
            data = json.loads(response.read(store.MAX_BYTES))
    except urllib.error.HTTPError as error:
        with error:
            if error.code in (401, 403):
                raise GatewayError("Your Harness sign-in has expired. Run harness login, then try again.")
            raise GatewayError(f"The connector service answered {error.code}. Try again shortly.")
    except (urllib.error.URLError, OSError, ValueError):
        raise GatewayError("Could not reach the connector service. Check the connection and try again.")
    if not isinstance(data, dict):
        raise GatewayError("The connector service sent an unexpected answer.")
    return data


def available():
    """{code: row} the gateway offers to this account; empty when signed out or offline."""
    try:
        rows = call("connectors").get("connectors")
    except GatewayError:
        return {}
    return {row["code"]: row for row in rows or [] if isinstance(row, dict) and isinstance(row.get("code"), str)}


def token_from(payload, previous=None):
    access = payload.get("access_token")
    if not isinstance(access, str) or not access:
        raise GatewayError("The connector service did not return a token.")
    expires = payload.get("expires_at")
    token = {"access_token": access, "token_type": payload.get("token_type") or "Bearer",
             "refresh_token": payload.get("refresh_token") or "",
             "expires_at": expires if type(expires) is int and expires > 0 else 0,
             "scope": payload.get("scope") if isinstance(payload.get("scope"), str) else "",
             "account_name": payload.get("account_name") or (previous or {}).get("account_name", ""),
             "source": "gateway", "obtained_at": int(time.time())}
    if payload.get("refresh") is True or (payload.get("refresh") is None and token["refresh_token"]):
        token["refresh"] = True
    mcp = payload.get("mcp_entry")
    if isinstance(mcp, dict) and mcp.get("url"):
        token["mcp_entry"] = {"url": mcp["url"], "headers": mcp.get("headers") or {"Authorization": store.bearer(token)}}
    return token


class SignIn:
    def __init__(self, code):
        self.code = code

    def prepare(self):
        started = call("connectors/start", {"connector": self.code})
        self.pickup = started.get("pickup_code")
        url = started.get("authorize_url")
        if not isinstance(self.pickup, str) or not isinstance(url, str) or not url.startswith("https://"):
            raise GatewayError("The connector service could not start this sign-in.")
        self.interval = min(max(int(started.get("poll_interval") or 2), 1), 60)
        self.expires = min(max(int(started.get("expires_in") or 600), 30), 3600)
        return url

    def wait(self, cancelled=lambda: False):
        deadline = time.monotonic() + self.expires
        while time.monotonic() < deadline and not cancelled():
            result = call("connectors/poll", {"pickup_code": self.pickup})
            status = result.get("status")
            if status == "ready":
                return token_from(result)
            if status in ("failed", "expired", "consumed"):
                raise GatewayError(result.get("error") or "The sign-in did not finish. Try again.")
            if status != "pending":
                raise GatewayError("The connector service sent an unexpected answer.")
            time.sleep(self.interval)
        raise GatewayError("The sign-in was not finished in time.")


def refresh(code, token):
    # The gateway holds the refresh token and the app's secret. A refused session
    # keeps the stored token, as Grid does: signing in again fixes it.
    return token_from(call("connectors/refresh", {"connector": code}), previous=token)


def disconnect(code):
    try:
        call("connectors/disconnect", {"connector": code})
    except GatewayError:
        pass  # Forgetting it here is what was asked; the gateway copy expires on its own.
