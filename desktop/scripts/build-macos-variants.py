#!/usr/bin/env python3
"""Compile one universal app, derive both renderers and optionally publish them.

Publication requires an explicit per-run metadata prefix. The live Desktop
manifest is never written here. Both existing signing/notarization paths run,
in parallel, in separate local directories and remote manifest objects.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

DESKTOP = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, DESKTOP.parent / "scripts" / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


runner = module("validation_runner", "validate-change.py")
verification = module("desktop_verification", "verify-desktop-release.py")
VARIANTS = {"intel": "Harness-macos", "apple-silicon": "Harness-macos-arm64"}
MACOS_KEYS = tuple(key for key in verification.KEYS if key.startswith("desktop-macos"))


def object_prefix(value):
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", value) or value.startswith("/") or ".." in value.split("/"):
        raise argparse.ArgumentTypeError("prefix must be a literal GCS object directory")
    return value.rstrip("/")


def check(name, argv, timeout=900):
    return dict(name=name, argv=argv, timeout_seconds=timeout)


def phase(checks, desktop, output, receipt):
    results = runner.run_checks({"checks": checks}, desktop, output, jobs=2)
    # Dart defines can contain credentials. Never save command arguments or the
    # inherited environment in the timing artifact; the scripts mask define values.
    receipt["checks"].extend({key: value for key, value in result.items()
                              if key in {"name", "status", "started_at", "finished_at", "duration_seconds", "exit_code", "cleanup_error"}}
                             for result in results)
    for result in results:
        print(f"::group::{result['name']} ({result['status']})", flush=True)
        if result.get("log"):
            print(Path(result["log"]).read_text(errors="replace"), flush=True)
        if result.get("error"):
            print(result["error"], file=sys.stderr)
        print("::endgroup::", flush=True)
    if any(result["status"] != "passed" for result in results):
        raise RuntimeError("macOS phase failed; see the per-variant results")


def flutter_timings(path):
    """Keep only SDK target timings, never arbitrary diagnostic fields or argv."""
    try:
        data = json.loads(path.read_text())
        targets = data["targets"]
        if not isinstance(targets, list) or not targets:
            raise ValueError("no target timings")
        result = []
        for target in targets:
            name = target["name"]
            elapsed = target["elapsedMilliseconds"]
            if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", name)
                    or type(elapsed) is not int or elapsed < 0
                    or type(target["skipped"]) is not bool or type(target["succeeded"]) is not bool):
                raise ValueError("invalid target timing")
            result.append({key: target[key] for key in ("name", "elapsedMilliseconds", "skipped", "succeeded")})
        return dict(status="recorded", targets=result)
    except (OSError, ValueError, KeyError, TypeError):
        # Profiling is diagnostic, not an additional publication gate. The actual
        # build/signing/artifact checks still determine the coordinator's result.
        return dict(status="unavailable")


def build(version, defines, desktop, output, receipt):
    variant_script = str(desktop / "scripts/publish-macos-variant.sh")
    profile = output / "flutter-build.json"
    profile.unlink(missing_ok=True)
    try:
        phase([check("universal-build", ["bash", variant_script, "apple-silicon", version, "--build-only",
                                         f"--performance-measurement-file={profile}", *defines], 1800)],
              desktop, output, receipt)
    finally:
        receipt["flutter_build"] = flutter_timings(profile)
    source = desktop / "build/macos/Build/Products/Release/Harness.app"
    copies = []
    for variant in VARIANTS:
        bundle = output / variant / "Harness.app"
        if bundle.exists():
            shutil.rmtree(bundle)
        bundle.parent.mkdir(parents=True, exist_ok=True)
        # APFS clones keep independent files without rewriting the same app bytes.
        # ditto falls back to copying where cloning is unavailable.
        copies.append(check(f"copy-{variant}", ["ditto", "--clone", str(source), str(bundle)], 60))
    phase(copies, desktop, output, receipt)
    phase([check(f"renderer-{variant}", ["env", f"APP_BUNDLE={output / variant / 'Harness.app'}",
                                         "bash", variant_script, variant, version, "--no-build", "--build-only"], 120)
           for variant in VARIANTS], desktop, output, receipt)


def publication_checks(version, metadata_prefix, artifact_prefix, artifact_suffix, desktop, output):
    checks = []
    for variant, filename in VARIANTS.items():
        key = "desktop-macos" if variant == "intel" else "desktop-macos-arm64"
        checks.append(check(f"publish-{variant}", [
            "env", f"APP_BUNDLE={output / variant / 'Harness.app'}", f"OUTPUT_DIR={output / variant}",
            f"OTA_KEY={key}", f"DMG_KEY={key}-dmg",
            f"GCS_PATH={artifact_prefix}/{filename}{artifact_suffix}.zip",
            f"DMG_GCS_PATH={artifact_prefix}/{filename}{artifact_suffix}.dmg",
            f"METADATA_PATH={metadata_prefix}/macos-{variant}.json",
            "bash", str(desktop / "scripts/upload-desktop.sh"), "--no-build", version,
        ], 1800))
    return checks


def verify_downloads(version, prefix):
    bucket = os.environ.get("GCS_BUCKET", "s3-autonomous-upgrade-3")
    entries = {}
    for variant in VARIANTS:
        manifest, _ = verification.read_manifest(f"https://storage.googleapis.com/{bucket}/{prefix}/macos-{variant}.json", 20)
        entries.update(manifest)
    items = verification.entries_for_version(entries, version, keys=MACOS_KEYS)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda item: verification.verify_artifact(item, 90), items))
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--metadata-prefix", type=object_prefix, help="publish only to these separate per-variant manifests")
    parser.add_argument("--artifact-prefix", type=object_prefix)
    parser.add_argument("--artifact-suffix", default="")
    parser.add_argument("--verify-downloads", action="store_true", help="verify all four internal-build downloads; real releases use their six-artifact final gate")
    parser.add_argument("--dart-define", action="append", default=[])
    args = parser.parse_args(argv)
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", args.version):
        parser.error("version must be X.Y.Z")
    if not re.fullmatch(r"[A-Za-z0-9._-]*", args.artifact_suffix):
        parser.error("artifact suffix must not contain paths")
    if (args.verify_downloads or args.artifact_prefix or args.artifact_suffix) and not args.metadata_prefix:
        parser.error("publication options require --metadata-prefix")
    output = DESKTOP / "build/macos-variants"
    output.mkdir(parents=True, exist_ok=True)
    receipt = dict(version=args.version, started_at=runner.utc_now(), status="failed", checks=[])
    started = time.monotonic()
    try:
        build(args.version, [f"--dart-define={item}" for item in args.dart_define], DESKTOP, output, receipt)
        if args.metadata_prefix:
            checks = publication_checks(args.version, args.metadata_prefix,
                                        args.artifact_prefix or f"harness/desktop/{args.version}",
                                        args.artifact_suffix, DESKTOP, output)
            phase(checks, DESKTOP, output, receipt)
            if args.verify_downloads:
                receipt["artifacts"] = verify_downloads(args.version, args.metadata_prefix)
                if any(item["status"] != "passed" for item in receipt["artifacts"]):
                    raise RuntimeError("an internal macOS download failed verification")
        receipt["status"] = "passed"
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        receipt["error"] = str(error)
        print(f"error: {error}", file=sys.stderr)
    finally:
        receipt.update(finished_at=runner.utc_now(), duration_seconds=round(time.monotonic() - started, 3))
        (output / "timing.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"macOS variants: {receipt['status']} in {receipt['duration_seconds']}s", flush=True)
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
