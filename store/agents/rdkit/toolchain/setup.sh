#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Two vendored toolchains, both inside this directory and
# nothing on the user's machine: a venv with the pinned RDKit for the chemistry (the agent's toolchain,
# and the pane's worker for SDFs the toolchain did not write), and node_modules with 3Dmol.js for the pane.
# The pinned numpy wants Python 3.12+ and pandas has wheels up to 3.14, so the venv is on 3.12 whatever
# this machine has (uv downloads it when it is not here); one already on 3.12–3.14 is kept. npm is the
# one beside the Node the pane runs on: this machine's, else Harness's own.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./VERSIONS
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
# RDKit publishes no Intel Mac wheel since 2025.9.3: say so before downloading anything, not in a resolver error.
if [ "$(uname -s)-$(uname -m)" = Darwin-x86_64 ]; then echo "miss rdkit ${RDKIT} has no Intel Mac build — this harness needs an Apple Silicon Mac, or Linux"; exit 1; fi
harness_venv .venv 3.12 3.12 3.15 || exit 1
echo "     installing rdkit ${RDKIT}"
harness_pip .venv "rdkit==${RDKIT}" "numpy==${NUMPY}" "pandas==${PANDAS}"
echo "ok   rdkit $(.venv/bin/python -c 'import rdkit; print(rdkit.__version__)') · numpy $(.venv/bin/python -c 'import numpy; print(numpy.__version__)') · pandas $(.venv/bin/python -c 'import pandas; print(pandas.__version__)')"
echo "     chemistry check (build, conformers, depict, describe, series)"
PYTHONPATH="$PWD/toolchain" .venv/bin/python - <<'PY'
import json, tempfile, pathlib
from harness_rdkit import design, similarity, substructure, mol_from_smiles
with tempfile.TemporaryDirectory() as tmp:
    report = design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen", out=tmp)
    assert report["conformers"] > 1 and report["formula"] == "C13H18O2", report
    analogue = design("CC(C)(O)Cc1ccc(C(C)C(=O)O)cc1", "ibuprofen_oh", out=tmp)
    assert analogue["parent"]["name"] == "ibuprofen" and analogue["parent"]["change"] == "+O", analogue["parent"]
    out = pathlib.Path(tmp)
    for name in ("ibuprofen.sdf", "ibuprofen.conformers.sdf", "ibuprofen.png", "ibuprofen.svg", "ibuprofen_oh.molecule.json"):
        assert (out / name).stat().st_size > 1000, name
    record = json.loads((out / "ibuprofen_oh.molecule.json").read_text())
    assert all(a["q"] is not None for a in record["atoms"]) and record["parent"]["changed"], record["parent"]
    assert [m["name"] for m in json.loads((out / "series.json").read_text())["molecules"]] == ["ibuprofen", "ibuprofen_oh"]
assert round(similarity("c1ccccc1O", "c1ccccc1O"), 3) == 1.0
assert substructure(mol_from_smiles("c1ccccc1O"), "[OX2H]c1ccccc1")
print("ok   conformer search, MMFF minimisation, Gasteiger charges, 2D depiction and the series work")
PY
harness_node 18 || exit 1
command -v npm >/dev/null 2>&1 || { echo "miss npm beside $(command -v node) (the pane)"; exit 1; }
echo "     npm ci (3Dmol.js $(node -p "require('./package.json').dependencies['3dmol']"))"
npm ci --silent --no-audit --no-fund
[ -f node_modules/3dmol/build/3Dmol-min.js ] || { echo "miss the 3Dmol.js bundle after npm ci"; exit 1; }
[ -f pane/app.js ] && [ -f pane/index.html ] || { echo "miss the pane (pane/index.html, pane/app.js)"; exit 1; }
echo "ok   3dmol $(node -p "require('3dmol/package.json').version")"
