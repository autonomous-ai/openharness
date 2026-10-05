#!/usr/bin/env python3
"""Exercise real publication preconditions using tiny, run-owned GCS fixtures.

Requires GitHub run/attempt IDs. Never accepts a production metadata path, and
always removes only its own fixture prefix. No application is built or released.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).with_name("tests")))
from desktop_publication_fixture import artifact_upload_script, make_parts, publisher


def must_reject(operation):
    try:
        operation()
    except (ValueError, RuntimeError):
        return
    raise AssertionError("unsafe publication unexpectedly succeeded")


def main():
    bucket, = sys.argv[1:]
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not re.fullmatch(r"[a-z0-9._-]+", bucket) or not run.isdigit() or not attempt.isdigit():
        raise ValueError("requires a bucket and numeric GitHub run/attempt IDs")
    prefix = f"harness/desktop/.publication-check/{run}-{attempt}"
    base = f"gs://{bucket}/{prefix}"
    uri = f"{base}/metadata.json"
    try:
        with tempfile.TemporaryDirectory(prefix="desktop-publication-check-") as folder:
            root = Path(folder)
            parts = root / "parts"
            for version in ("0.0.1", "0.0.3"):
                entries = make_parts(parts, version, f"https://storage.googleapis.com/{bucket}/{prefix}/{version}")
                files = [str(parts / key) for key in entries]
                publisher.gcloud("storage", "cp", *files, f"{base}/{version}/", "--if-generation-match=0")
                publisher.publish(uri, version, parts, allow_initialize=True)
                receipt = publisher.verification.verify(version, f"https://storage.googleapis.com/{bucket}/{prefix}/metadata.json")
                assert receipt["status"] == "passed", receipt
                print(f"PASS: publish and verify all six {version} fixtures", flush=True)

            live, generation = publisher.read_live(uri)
            for version in ("0.0.2", "0.0.3"):
                make_parts(parts, version, "https://fixture.invalid/never-uploaded")
                must_reject(lambda: publisher.publish(uri, version, parts))
            assert publisher.read_live(uri) == (live, generation)
            print("PASS: late older and duplicate releases preserve the current version", flush=True)

            make_parts(parts, "0.0.4", "https://fixture.invalid/never-uploaded")
            (parts / "linux-arm64.json").unlink()
            must_reject(lambda: publisher.publish(uri, "0.0.4", parts))
            assert publisher.read_live(uri) == (live, generation)
            print("PASS: incomplete platform sets never change the manifest", flush=True)

            # An external writer wins after the publisher reads. The stale writer
            # must get a real GCS precondition failure and preserve those changes.
            concurrent = dict(live, fixture_concurrent_write=True)
            publisher.write_manifest(uri, concurrent, generation)
            must_reject(lambda: publisher.write_manifest(uri, live, generation))
            assert publisher.read_live(uri)[0] == concurrent
            print("PASS: stale generation cannot overwrite a concurrent writer", flush=True)

            # Use the production shell helper AND each actual upload call site.
            # Bypass the advisory exists check to exercise the atomic race guard.
            payload = root / "artifact"
            for script, variable in (("upload-desktop.sh", "ZIP"), ("upload-desktop.sh", "DMG"), ("upload-desktop-linux.sh", "OUTPUT")):
                payload.write_text("original fixture bytes")
                path = f"{prefix}/immutable-{variable}"
                env = dict(os.environ, **{variable: str(payload)}, GCS_BUCKET=bucket, GCS_PATH=path, DMG_GCS_PATH=path)
                command = ["bash", "-eu", "-c", artifact_upload_script(script, variable)]
                subprocess.run(command, env=env, check=True, capture_output=True, text=True, timeout=90)
                payload.write_text("replacement fixture bytes")
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=90)
                assert result.returncode != 0, result.stdout
                assert publisher.gcloud("storage", "cat", f"gs://{bucket}/{path}") == "original fixture bytes"
            print("PASS: macOS ZIP/DMG and Linux upload commands refuse immutable overwrites", flush=True)
        if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(summary, "a") as stream:
                stream.write("Desktop publication contract passed against disposable GCS fixtures: six-platform publication/downloads, superseded and duplicate versions, incomplete builds, concurrent manifest writes, and immutable artifacts.\n")
    finally:
        # The prefix is constructed above from numeric run/attempt IDs, never user
        # input or the production metadata_path. An empty/root cleanup is impossible.
        publisher.gcloud("storage", "rm", "--recursive", base + "/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
