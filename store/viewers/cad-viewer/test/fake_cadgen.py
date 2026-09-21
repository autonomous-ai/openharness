"""A stand-in for the `cadgen` release, just the parts pane_client.py and the scripts read: an
importable package whose `_runtime/viewer/` holds a built client, and the dist-info that
`importlib.metadata.version("cadgen")` answers from. Nothing of the real release is copied."""
from __future__ import annotations

import tempfile
from pathlib import Path

VERSION = "0.5.1"

# The shape of the release's index.html head: the anchor pane_client.py inserts after.
INDEX_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>text-to-cad</title>
    <script type="module" src="./assets/index.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
"""


def make_site(index_html: str | None = INDEX_HTML, version: str = VERSION) -> Path:
    """A directory to put on sys.path (or PYTHONPATH) that provides `cadgen` at `version`."""
    site = Path(tempfile.mkdtemp(prefix="fake-cadgen-site-"))
    package = site / "cadgen"
    viewer = package / "_runtime" / "viewer"
    (viewer / "assets").mkdir(parents=True)
    (package / "__init__.py").write_text(f'__version__ = "{version}"\n', encoding="utf-8")
    (viewer / "assets" / "index.js").write_bytes(b"console.log('the release client')\n")
    (viewer / "assets" / "logo.png").write_bytes(bytes(range(256)))
    if index_html is not None:
        (viewer / "index.html").write_text(index_html, encoding="utf-8")
    info = site / f"cadgen-{version}.dist-info"
    info.mkdir()
    (info / "METADATA").write_text(f"Metadata-Version: 2.1\nName: cadgen\nVersion: {version}\n", encoding="utf-8")
    return site
