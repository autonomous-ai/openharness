# RDKit, as a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for
[RDKit](https://www.rdkit.org): describe a molecule in the chat pane — a drug, an analogue, a
scaffold, a series — and watch it appear in the molecule pane: its conformers in 3D, its 2D depiction
linked atom-for-atom, its properties and rule badges, and the series it belongs to. Turn a bond through
a native energy scan, inspect each shape, and keep a reproducible study. Runs on Codex.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `pane/` + `viewer.mjs` — the pane, 3Dmol.js from this package's own `node_modules` (the
  UMD build, no CDN). 3D: wire / stick / ball-and-stick / spacefill, hydrogens all / polar / none,
  colour by element, Gasteiger charge, Crippen lipophilicity or change from the parent, VDW / SAS / SES
  surfaces coloured by electrostatic or lipophilicity potential, soft shadows or outlines on a light or
  dark stage, spin. Hover an atom (3D or 2D) for its charge, hybridisation, CIP label and groups; click
  atoms for distances, angles and dihedrals labelled in the scene. The RDKit SVG depiction is linked to
  the 3D model atom-for-atom, with chips for functional groups, PAINS/Brenk alerts and what changed from
  the parent. Properties with Lipinski / Veber / QED / alert badges, deltas against the parent and
  plain-language flags; SMILES / InChI / InChIKey to copy. The conformer ensemble with MMFF energies,
  play / step, an all-conformers overlay and the parent superposed on the shared atoms. The series as a
  strip of cards and a sortable comparison table; the newest opens, and the pane follows new molecules as
  they are written, keeping the camera, representation and measurements, with "embedding…" while
  `design` works. PNG of the view, SVG, SDF (lowest or all conformers) and MOL export. Keyboard: `?`.
  The server reads `<name>.molecule.json`; for an SDF the toolchain did not write it asks a long-lived
  `harness_rdkit.py serve` worker, so older workspaces get the same pane.
- `toolchain/setup.sh` — one venv on Python 3.12 (uv brings it when the machine has none) with the
  pinned RDKit, numpy and pandas (`VERSIONS`), plus `npm ci` (on Harness's own Node when the machine has
  none) — Apple Silicon Macs and Linux, since the pinned RDKit has no Intel Mac build;
  `harness_rdkit.py` builds from SMILES, searches conformers (ETKDGv3 + MMFF94), describes the molecule
  (charges, groups, alerts, depiction, parent and change) and writes the SDFs, the depiction, the
  record, the series, the properties and the report; `verdict.py` judges Design / Embed / Review.
- `skills/rdkit/` — the RDKit skill (ours): SMILES and SMARTS, the helper API, scaffolds, analogue
  series, similarity, conformers, and the pitfalls. `template/` — ibuprofen, built in six lines.

## Explore a bond

Ask for a molecule with a flexible chain, then open **Bond scan → Use current conformer**. Choose a
four-atom chain from the menu, or measure a dihedral with **T** and four atom clicks in 2D or 3D, then
choose **Use measured dihedral**. Atom numbers match the viewer's zero-based labels. **Scan bond**
evaluates 13, 25 or 37 poses, from −180° to +180° at 30°, 15° or 10° spacing. Drag the curve, scrub with
the slider, play the rotation, or jump to the lowest sampled point. The purple starting pose helps
show what moved. This works on an authored or imported compatible molecule; the molecules in
`test/fixtures/flexible-molecules.py` are examples, not a fixed set of models.

This is a **rigid MMFF94 scan** using the installed RDKit: only the chosen non-ring single bond
rotates; the other internal coordinates stay fixed. The energy curve is relative to the lowest
sampled point of that same scan. It is not a relaxed barrier, a free energy, an equilibrium
population or a prediction of activity. Closely approaching atoms can give very high energies.
Use one connected, explicitly hydrogenated 3D MOL/SDF molecule with 4–200 atoms and MMFF94
parameters. `design()` normally supplies that geometry. Rings, multiple central bonds, missing
hydrogens, unsupported atoms and nearly collinear dihedrals produce a clear error without replacing
an existing scan. There is no silent force-field fallback.

**Keep study** saves a name, note and chosen pose under `out/torsions/<id>/`. Each study includes the
exact input conformer, the chosen SDF, all sampled SDF poses, an energy CSV, full-precision
coordinates and calculation metadata, plus a ZIP containing a standalone Python reproducer and its
source. The server recomputes the scan and checks its fingerprint before saving. With the recorded
RDKit version installed, extract the ZIP anywhere and run `python reproduce.py` to check the
energies and coordinates independently. SDF coordinates use four decimal places; the JSON keeps the
full calculation precision. The original molecule files are unchanged.

Kept studies reopen after a server restart or after the original files change or disappear. New
agent output waits while a scan is open; **Back to molecule** returns to the live workspace. A failed
save keeps the study in the current tab for retry. Unsaved studies do not survive closing or
reloading the tab. Read the study's note and `selected.sdf` when asking the agent to continue from a
chosen shape; the study directory stays as a record of the experiment.

The implementation uses RDKit's [dihedral transforms](https://www.rdkit.org/docs/source/rdkit.Chem.rdMolTransforms.html)
and [MMFF force-field helpers](https://www.rdkit.org/docs/source/rdkit.Chem.rdForceFieldHelpers.html).
The upstream chemistry and 3D renderer are unmodified.

![An authored molecule, its starting pose and a native bond-energy scan](../../../docs/images/rdkit-bond-scan.png)

[Watch the bond-scan walkthrough](../../../docs/images/rdkit-bond-scan-demo.mp4).

## Credit and stewardship

RDKit is the RDKit contributors' work, led by Greg Landrum —
[rdkit/rdkit](https://github.com/rdkit/rdkit), BSD-3-Clause (`LICENSE-rdkit`) — and the pane is
[3Dmol.js](https://3dmol.csb.pitt.edu), David Koes and contributors at the University of Pittsburgh,
BSD-3-Clause (`LICENSE-3dmol`). Nothing of either is changed here: RDKit is installed from PyPI as
released and 3Dmol.js is loaded as they publish it on npm. This folder is the Harness wrapper —
the manifest, the pane server, a skill, the helper, the template, the verdict — written by Autonomous
to bring RDKit into Harness, on the project's behalf, to bootstrap the catalogue.

If you maintain RDKit or 3Dmol.js and want to own this package, it is yours: open an issue on
[OpenHarness](https://github.com/autonomous-ai/openharness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in RDKit belong upstream, bugs in the
wrapper belong here, and a newer RDKit is a bump of `VERSIONS`.

Nothing in this package predicts activity, binding or safety. It computes what RDKit computes —
molecular weight, Crippen cLogP, TPSA, hydrogen-bond counts, Lipinski, QED, fingerprints, geometry —
and says so.

```sh
harness dsh check .                                # conformance
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without rdkit
python3 -m unittest toolchain/test_scripts.py      # setup, doctor, init and viewer.sh, on stubbed PATHs
"$RDKIT_PYTHON" -m unittest discover -s toolchain  # the helper on the pinned RDKit, plus the real chemistry checks
node --test test/*.test.mjs                        # the pane's server, with a fake RDKit worker
RDKIT_PYTHON=/path/to/python PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/torsion-browser.mjs
                                                 # actual RDKit + Chrome + 3Dmol, isolated workspace
```
