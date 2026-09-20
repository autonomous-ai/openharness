#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dsh="$(cd "$here/.." && pwd)"
python="${HA_PYTHON:-$dsh/.runtime/core/bin/python}"
if [ ! -x "$python" ]; then echo "miss Home Assistant runtime — run toolchain/setup.sh"; exit 1; fi
"$python" -I -c 'import importlib.metadata as m,sys; import homeassistant,time_machine; assert m.version("homeassistant")=="2026.9.3"; assert m.version("time-machine")=="3.5.0"; assert sys.version_info[:3]==(3,14,7); print("ok   Home Assistant Core 2026.9.3 / Python",sys.version.split()[0]); print("note isolated, non-persistent test lab; no home or physical devices connected")'
bash "$here/node.sh" --input-type=module -e 'import {access} from "node:fs/promises";import {pathToFileURL} from "node:url";const {chromium}=await import(pathToFileURL(process.argv[1]));await access(process.env.BROWSER_EXECUTABLE||chromium.executablePath());console.log("ok   browser verification runtime")' "$dsh/node_modules/playwright-core/index.mjs"
