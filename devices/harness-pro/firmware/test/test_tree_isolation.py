#!/usr/bin/env python3
"""The Pro firmware tree must stand alone: no path into the round dial's tree, no round-dial UI."""
import os
import re
import sys

PRO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {"build", "managed_components", "__pycache__", ".git"}
TEXT_EXT = {".c", ".h", ".txt", ".cmake", ".yml", ".yaml", ".csv", ".py", ".sh", ".md",
            ".defaults", ".lock", ".json", ".cpp"}
BANNED_INCLUDE = re.compile(
    r'#\s*include\s*[<"][^>"]*(ui_screens\.h|lvgl\.h|octopus|tim\.h|tux\.h|carry\.h|visit\.h|workspace\.h)')
SRC_LINE = re.compile(r'"([^"\s]+\.[cC])"')

NO_RADIO_INCLUDE = re.compile(r'#\s*include\s*[<"][^>"]*(esp_wifi|esp_hosted|esp_netif|lwip)')
NO_RADIO_NAME = re.compile(r'esp_hosted|esp_wifi_remote|esp_wifi|esp_netif')

failures = []


def is_text(name):
    base = os.path.basename(name)
    return os.path.splitext(base)[1] in TEXT_EXT or base.startswith("sdkconfig.defaults")


for root, dirs, files in os.walk(PRO):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith("build")]
    for f in files:
        path = os.path.join(root, f)
        rel = os.path.relpath(path, PRO)
        if f in ("sdkconfig", "sdkconfig.old") or not is_text(f):
            continue
        if rel == os.path.join("test", "test_tree_isolation.py"):
            continue
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        if "harness-device" in text and not f.endswith(".md"):
            failures.append(f"{rel}: mentions harness-device")
        if f.endswith((".c", ".h")):
            for n, line in enumerate(text.splitlines(), 1):
                if BANNED_INCLUDE.search(line):
                    failures.append(f"{rel}:{n}: banned include: {line.strip()}")
                if rel.startswith("main" + os.sep) and NO_RADIO_INCLUDE.search(line):
                    failures.append(f"{rel}:{n}: Wi-Fi/network include (the Pro is cable-only): {line.strip()}")

cmake = os.path.join(PRO, "main", "CMakeLists.txt")
if not os.path.isfile(cmake):
    failures.append("main/CMakeLists.txt is missing")
else:
    with open(cmake, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            if line.lstrip().startswith("#"):
                continue
            for src in SRC_LINE.findall(line):
                if src.startswith(("/", "..")) or "${" in src:
                    failures.append(f"main/CMakeLists.txt:{n}: source outside main: {src}")
                elif not os.path.isfile(os.path.join(PRO, "main", src)):
                    failures.append(f"main/CMakeLists.txt:{n}: source not in main: {src}")

for rel in ("main/CMakeLists.txt", "main/idf_component.yml"):
    with open(os.path.join(PRO, rel), encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            if NO_RADIO_NAME.search(line):
                failures.append(f"{rel}:{n}: names a Wi-Fi component: {line.strip()}")
with open(os.path.join(PRO, "sdkconfig.defaults"), encoding="utf-8") as fh:
    for n, line in enumerate(fh, 1):
        if re.match(r"\s*CONFIG_(ESP_HOSTED|ESP_WIFI_REMOTE)", line):
            failures.append(f"sdkconfig.defaults:{n}: Wi-Fi option: {line.strip()}")

if failures:
    print("\n".join(failures))
    print("FAIL")
    sys.exit(1)
print("PASS")
