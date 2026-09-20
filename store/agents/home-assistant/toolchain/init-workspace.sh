#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
workspace="${HARNESS_WORKSPACE:-$PWD}"
exec bash "$here/node.sh" --input-type=module -e 'import {pathToFileURL} from "node:url";import {resolve} from "node:path";const root=resolve(process.argv[1]);const {readSource,verdict,exists}=await import(pathToFileURL(root+"/tools/project.mjs"));await readSource(root);if(!await exists(root+"/.harness/verdict.json"))await verdict(root,"Example devices are ready. Describe the behavior you want, then test it in Core.");console.log("ok   Habitat source preserved; no home connected")' "$workspace"
