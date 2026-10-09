#!/usr/bin/env python3
"""Rebuild os/connectors/catalog.json and its icons from the Grid connector gateway.

The gateway (GET /v1/grid/connectors) is the list the Grid app shows. Its `dcr`
services sign in from the computer; its `app` services sign in through the
gateway. An `app` service whose MCP server also allows dynamic client
registration is signed in from the computer instead (checked here, live).

    python3 os/tools/update-connector-catalog.py            # needs `grid login` / `harness login`
    python3 os/tools/update-connector-catalog.py rows.json  # from a saved GET /v1/grid/connectors

Icons are fetched once into os/connectors/web/icons (64 px PNG via `sips` or
ImageMagick when available), so the page never loads anything from the network.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / "connectors"
sys.path.insert(0, str(ROOT))
import gateway  # noqa: E402
import oauth  # noqa: E402

ICONS = ROOT / "web/icons"


def rows():
    if len(sys.argv) > 1:
        data = json.loads(Path(sys.argv[1]).read_text())
        return data["connectors"] if isinstance(data, dict) else data
    return gateway.call("connectors")["connectors"]


def local_sign_in(url):
    try:
        meta = oauth.probe(url)
    except Exception:
        return False
    return meta["kind"] == "oauth" and bool(meta.get("registration_endpoint")) and meta["s256"]


def icon(code, url):
    if any((ICONS / (code + ext)).exists() for ext in (".png", ".svg")) or not url:
        return
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(request, timeout=20).read()
    except OSError as error:
        print(f"{code}: no icon ({error})", file=sys.stderr)
        return
    if data.lstrip().startswith(b"<svg") or b"<svg" in data[:300]:
        (ICONS / (code + ".svg")).write_bytes(data)
        return
    with tempfile.TemporaryDirectory() as folder:
        source, target = Path(folder) / "source", ICONS / (code + ".png")
        source.write_bytes(data)
        if shutil.which("sips"):
            subprocess.run(["sips", "-s", "format", "png", "-Z", "64", str(source), "--out", str(target)],
                           check=True, capture_output=True)
        elif shutil.which("magick"):
            subprocess.run(["magick", str(source) + "[0]", "-resize", "64x64>", str(target)], check=True)
        else:
            raise SystemExit("Install ImageMagick (or run on macOS) to resize icons.")


def main():
    old = {item["code"]: item for item in json.loads((ROOT / "catalog.json").read_text())["connectors"]}
    items = []
    for row in sorted(rows(), key=lambda r: r["code"]):
        code, url = row["code"], row.get("mcp_url") or ""
        auth = row.get("auth_type")
        if auth == "app" and url and local_sign_in(url):
            auth = "dcr"
        if auth not in ("app", "dcr"):
            continue
        description = row.get("description") or old.get(code, {}).get("description") or ""
        item = {"code": code, "label": row["label"], "auth": auth, "description": description}
        if url:
            item["mcp_url"] = url
        items.append(item)
        icon(code, row.get("image_url"))
        print(f"{auth:3} {code}")
    note = old and json.loads((ROOT / "catalog.json").read_text()).get("_note")
    (ROOT / "catalog.json").write_text(json.dumps({"_note": note, "connectors": items}, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
