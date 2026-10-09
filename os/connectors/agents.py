"""Connected services, given to each agent as an MCP server on the local bridge.

Agent configs hold only a 127.0.0.1 bridge address; the bridge adds the
credential to each request (Grid's design). A renewed token therefore needs no
config change, and an agent that is already running keeps working.

Only entries Harness made are changed or removed: their names are recorded in
projections.json, so a server the user added by hand is never touched.
"""
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import tempfile

import connection_store as store

PORT = int(os.environ.get("HARNESS_CONNECTIONS_PORT", "51793"))
NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}")


def bridge_key(vault):
    """The capability in every bridge address, so only this user's agents can use it."""
    with store.locked(vault.root):
        data = vault.file("bridge.json")
        if not isinstance(data.get("key"), str) or len(data["key"]) < 32:
            data = {"key": secrets.token_urlsafe(32)}
            store.write_private(vault.root / "bridge.json", data)
        return data["key"]


def bridge_url(key, code):
    return f"http://127.0.0.1:{PORT}/{key}/{code}/mcp"


def home():
    return Path(os.environ.get("HOME") or Path.home())


def write_file(path, raw):
    """Replace a config atomically, keeping its permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(raw)
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


class JsonAgent:
    """An agent whose MCP servers are one JSON object in its config."""

    def __init__(self, name, binary, path, key, entry):
        self.name, self.binary, self.path, self.key, self.entry = name, binary, path, key, entry

    def installed(self):
        return self.path().exists() or shutil.which(self.binary) is not None

    def apply(self, wanted, owned):
        path = self.path()
        try:
            data = json.loads(path.read_text()) if path.exists() else {}
        except (OSError, ValueError):
            return owned  # A config with comments or a syntax error is left exactly as it is.
        if not isinstance(data, dict):
            return owned
        servers = data.get(self.key)
        if not isinstance(servers, dict):
            servers = {}
        result = set()
        for name in set(owned) - set(wanted):
            servers.pop(name, None)
        for name, url in wanted.items():
            if name in servers and name not in owned:
                continue  # The user's own server with this name.
            servers[name] = self.entry(url)
            result.add(name)
        if servers:
            data[self.key] = servers
        else:
            data.pop(self.key, None)
        write_file(path, json.dumps(data, indent=2) + "\n")
        return sorted(result)


class CodexAgent:
    name, binary = "codex", "codex"

    def path(self):
        return Path(os.environ.get("CODEX_HOME") or home() / ".codex") / "config.toml"

    def installed(self):
        return self.path().exists() or shutil.which(self.binary) is not None

    @staticmethod
    def header(name):
        return re.compile(r'^\s*\[\s*mcp_servers\s*\.\s*(?:' + name + '|"' + name + r'")\s*(?:\.[^\]]*)?\]\s*$')

    def apply(self, wanted, owned):
        path = self.path()
        try:
            lines = path.read_text().splitlines() if path.exists() else []
        except OSError:
            return owned
        drop = set(owned)
        kept, skipping = [], False
        for line in lines:
            if line.lstrip().startswith("["):
                skipping = any(self.header(re.escape(name)).match(line) for name in drop)
            if not skipping:
                kept.append(line)
        while kept and not kept[-1].strip():
            kept.pop()
        result = []
        for name, url in sorted(wanted.items()):
            if any(self.header(re.escape(name)).match(line) for line in kept):
                continue  # The user's own server with this name.
            kept += ["", f"[mcp_servers.{name}]", "url = " + json.dumps(url)]
            result.append(name)
        write_file(path, "\n".join(kept).lstrip("\n") + "\n" if kept else "")
        return result


def agents():
    config = Path(os.environ.get("XDG_CONFIG_HOME") or home() / ".config")
    return [
        JsonAgent("claude", "claude", lambda: home() / ".claude.json", "mcpServers",
                  lambda url: {"type": "http", "url": url}),
        CodexAgent(),
        JsonAgent("opencode", "opencode", lambda: config / "opencode/opencode.json", "mcp",
                  lambda url: {"type": "remote", "url": url, "enabled": True}),
    ]


def sync(vault):
    """Give every installed agent exactly the connections that have MCP tools."""
    tokens = vault.tokens()
    wanted = {code: None for code, token in tokens.items() if token.get("mcp_entry") and NAME.fullmatch(code)}
    if wanted:
        key = bridge_key(vault)
        wanted = {code: bridge_url(key, code) for code in wanted}
    with store.locked(vault.root):
        record = vault.file("projections.json")
        changed = {}
        for agent in agents():
            owned = [n for n in record.get(agent.name, []) if isinstance(n, str) and NAME.fullmatch(n)]
            if not owned and not wanted:
                continue
            if not agent.installed():
                continue
            changed[agent.name] = agent.apply(wanted, owned)
        record.update(changed)
        store.write_private(vault.root / "projections.json", record)
    return changed
