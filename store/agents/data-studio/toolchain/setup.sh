#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/runtimes.sh"
harness_node 22.16 || exit 1
node --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const d=new DatabaseSync(":memory:"); const s=d.prepare("SELECT 1 AS ok"); if(s.columns()[0].name!=="ok")process.exit(1);d.close();'
node --input-type=module -e 'import {readFileSync} from "node:fs";import {createHash} from "node:crypto";const base=process.argv[1],pins=JSON.parse(readFileSync(base+"/checksums.json"));for(const n of ["sqlite3.js","sqlite3.wasm"]){if(createHash("sha256").update(readFileSync(base+"/"+n)).digest("hex")!==pins[n])throw new Error("SQLite asset checksum mismatch: "+n)}' "$here/../template/vendor"
echo "ok   node $(node --version) with native SQLite"
echo "ok   pinned SQLite 3.53.4 browser runtime"
test -f "$here/../skills/data/SKILL.md" && echo "ok   data analysis skill"
