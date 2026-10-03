"""Shared fixture data for local contract tests and the disposable GCS check."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("desktop_publisher", ROOT / "scripts/publish-desktop-manifest.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def make_parts(directory, version, base_url):
    directory.mkdir(parents=True, exist_ok=True)
    entries = {}
    for name, keys in publisher.PARTS.items():
        part = {}
        for key in sorted(keys):
            payload = f"Publication contract fixture: {version} {key}\n".encode()
            part[key] = dict(version=version, url=f"{base_url}/{key}",
                             size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
            (directory / key).write_bytes(payload)
        (directory / name).write_text(json.dumps(part))
        entries.update(part)
    return entries


def artifact_upload_script(script_name, variable):
    """Exercise the actual helper AND upload invocation, without building an app."""
    source = (ROOT / "desktop/scripts" / script_name).read_text()
    function = "gcs_cp() {" + source.split("gcs_cp() {", 1)[1].split("\n}", 1)[0] + "\n}\n"
    invocation = next(line for line in source.splitlines() if line.startswith(f'gcs_cp "${variable}" '))
    return function + invocation + "\n"
