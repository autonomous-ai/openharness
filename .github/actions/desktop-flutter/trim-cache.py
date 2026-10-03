#!/usr/bin/env python3
"""Remove mobile engine artifacts from a CI-owned Desktop SDK cache."""
import argparse
from pathlib import Path
import shutil

MOBILE_ARTIFACTS = {"ios", "ios-profile", "ios-release"} | {
    f"android-{arch}{mode}"
    for arch in ("arm", "arm64", "x86", "x64")
    for mode in ("", "-profile", "-release")
}


def trim_cache(root):
    root = root.resolve(strict=True)
    engine = root / "bin/cache/artifacts/engine"
    if not (root / "bin/flutter").is_file() or not engine.is_dir() or engine.resolve() != engine:
        raise ValueError("expected a Flutter SDK with an in-place engine cache")
    selected = [engine / name for name in sorted(MOBILE_ARTIFACTS) if (engine / name).exists() or (engine / name).is_symlink()]
    # Validate the complete selection before deleting anything. Frameworks may
    # contain internal symlinks; rmtree removes those links without following them.
    if any(path.is_symlink() or not path.is_dir() for path in selected):
        raise ValueError("mobile engine artifacts must be ordinary SDK directories")
    for path in selected:
        shutil.rmtree(path)
    return [path.name for path in selected]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sdk", type=Path)
    args = parser.parse_args()
    removed = trim_cache(args.sdk)
    print(f"Desktop SDK cache: removed {len(removed)} mobile engine directories: " + ", ".join(removed))


if __name__ == "__main__":
    main()
