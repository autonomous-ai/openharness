#!/usr/bin/env python3
"""Check a Windows desktop zip has the install's exact shape (desktop spec §3.3), before anything uploads it.

Usage: check-windows-zip.py <zip> <version>. Exit 0 when it is a complete install for <version>; otherwise one
`error:` line and a non-zero exit. Shared by the staging publisher and the release upload
(publish-desktop-windows-staging.sh, upload-desktop-windows.sh), so both refuse the same zips.
"""
import stat
import sys
import zipfile

path, version = sys.argv[1:3]
try:
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len({name.casefold() for name in names}):
            sys.exit(f"error: {path} has duplicate entries")
        for info in infos:
            name = info.filename
            parts = name.rstrip("/").split("/")
            if (not name or name.startswith("/") or "\\" in name or
                    any(part in ("", ".", "..") or any(c in part for c in '<>:"|?*') for part in parts)):
                sys.exit(f"error: {path} has an unsafe entry {name!r}")
            if parts[0] not in ("Harness.exe", "Harness.ico", "current", "app") or (
                    parts[0] != "app" and (len(parts) != 1 or info.is_dir())) or (
                    parts[0] == "app" and len(parts) == 1 and not info.is_dir()) or (
                    parts[0] == "app" and len(parts) > 1 and parts[1] != version) or (
                    parts[:2] == ["app", version] and len(parts) == 2 and not info.is_dir()):
                sys.exit(f"error: {path} has an unexpected entry {name!r}")
            if any(part.lower() == ".started" for part in parts):
                sys.exit(f"error: {path} contains an inherited .started marker")
            kind = stat.S_IFMT(info.external_attr >> 16)
            if kind not in ((0, stat.S_IFDIR) if info.is_dir() else (0, stat.S_IFREG)):
                sys.exit(f"error: {path} contains a non-file entry {name!r}")
        required = ("Harness.exe", "Harness.ico", "current",
                    f"app/{version}/harness-desktop.exe", f"app/{version}/harness_pipe_io.dll")
        for name in required:
            if name not in names or archive.getinfo(name).is_dir() or archive.getinfo(name).file_size == 0:
                sys.exit(f"error: {path} has no {name}")
        current = archive.read("current").decode("utf-8-sig")
        if current not in (version, version + "\n", version + "\r\n"):
            sys.exit(f"error: {path} says current is '{current.strip()}', not {version}")
        bad = archive.testzip()
        if bad is not None:
            sys.exit(f"error: {path} has a corrupt entry {bad}")
except (OSError, ValueError, UnicodeError, RuntimeError, zipfile.BadZipFile) as error:
    sys.exit(f"error: {path} is not a valid install zip: {error}")
