"""A reproducible, rigid MMFF94 torsion scan of an explicitly hydrogenated 3D MOL block.

Only a non-ring single bond is rotated. No geometry minimization, solvent model, population,
kinetics or binding prediction is implied. This module travels with every kept study.
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path
import zipfile

from rdkit import Chem, rdBase
from rdkit.Chem import AllChem, rdMolTransforms

MAX_ATOMS = 200
METHOD = "Rigid MMFF94 scan; other internal coordinates fixed; no solvent"


def prepare(block: str) -> Chem.Mol:
    if not isinstance(block, str) or len(block.encode("utf-8")) > 128 * 1024:
        raise ValueError("Use a MOL block of at most 128 KB")
    mol = Chem.MolFromMolBlock(block, removeHs=False)
    if mol is None:
        raise ValueError("RDKit could not read this molecule")
    if not 4 <= mol.GetNumAtoms() <= MAX_ATOMS:
        raise ValueError(f"Bond scans support 4–{MAX_ATOMS} atoms, including hydrogens")
    if len(Chem.GetMolFrags(mol)) != 1:
        raise ValueError("Scan one connected molecule at a time")
    if not mol.GetNumConformers() or not mol.GetConformer().Is3D():
        raise ValueError("A bond scan needs a 3D conformer")
    if any(atom.GetTotalNumHs() for atom in mol.GetAtoms()):
        raise ValueError("Use a 3D conformer with explicit hydrogen atoms; the agent can rebuild it with design()")
    for point in mol.GetConformer().GetPositions():
        if any(not math.isfinite(float(value)) or abs(value) > 10000 for value in point):
            raise ValueError("The input has invalid or out-of-range coordinates")
    if not AllChem.MMFFHasAllMoleculeParams(mol):
        raise ValueError("MMFF94 does not have parameters for every atom in this molecule")
    return mol


def validate_atoms(mol: Chem.Mol, atoms: list[int]) -> None:
    if (not isinstance(atoms, list) or len(atoms) != 4
            or any(type(i) is not int or not 0 <= i < mol.GetNumAtoms() for i in atoms)
            or len(set(atoms)) != 4):
        raise ValueError("Choose four distinct, valid atom indices")
    bonds = [mol.GetBondBetweenAtoms(a, b) for a, b in zip(atoms, atoms[1:])]
    if not all(bonds):
        raise ValueError("The four atoms must form a connected chain")
    if bonds[1].IsInRing() or bonds[1].GetBondType() != Chem.BondType.SINGLE:
        raise ValueError("The middle bond must be a non-ring single bond")
    conf = mol.GetConformer()
    for a, b, c in [atoms[:3], atoms[1:]]:
        angle = rdMolTransforms.GetAngleDeg(conf, a, b, c)
        if not math.isfinite(angle) or angle < 1 or angle > 179:
            raise ValueError("This atom chain is too close to collinear to define a dihedral")


def options(block: str) -> dict:
    mol = prepare(block)
    candidates = []
    for bond in mol.GetBonds():
        if bond.IsInRing() or bond.GetBondType() != Chem.BondType.SINGLE:
            continue
        j, k = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        if mol.GetAtomWithIdx(j).GetAtomicNum() == 1 or mol.GetAtomWithIdx(k).GetAtomicNum() == 1:
            continue
        sides = []
        for at, other in [(j, k), (k, j)]:
            choices = [n.GetIdx() for n in mol.GetAtomWithIdx(at).GetNeighbors() if n.GetIdx() != other]
            sides.append(sorted(choices, key=lambda i: (mol.GetAtomWithIdx(i).GetAtomicNum() == 1, i)))
        if not all(sides):
            continue
        atoms = [sides[0][0], j, k, sides[1][0]]
        try:
            validate_atoms(mol, atoms)
        except ValueError:
            continue
        label = "–".join(f"{mol.GetAtomWithIdx(i).GetSymbol()}{i}" for i in atoms)
        candidates.append({"atoms": atoms, "bond": [j, k], "label": label,
                           "angle": rdMolTransforms.GetDihedralDeg(mol.GetConformer(), *atoms)})
    candidates.sort(key=lambda c: (sum(mol.GetAtomWithIdx(i).GetAtomicNum() == 1 for i in c["atoms"]), c["bond"]))
    return {"candidates": candidates, "atomCount": mol.GetNumAtoms(), "rdkitVersion": rdBase.rdkitVersion,
            "method": METHOD, "sourceSha256": hashlib.sha256(block.encode()).hexdigest()}


def scan(block: str, atoms: list[int], step: int = 15) -> dict:
    mol = prepare(block)
    validate_atoms(mol, atoms)
    if type(step) is not int or step not in (10, 15, 30):
        raise ValueError("Choose 10°, 15° or 30° scan spacing")
    props = AllChem.MMFFGetMoleculeProperties(mol, mmffVariant="MMFF94")
    initial = AllChem.MMFFGetMoleculeForceField(mol, props).CalcEnergy()
    angle_before = rdMolTransforms.GetDihedralDeg(mol.GetConformer(), *atoms)
    if not math.isfinite(initial) or not math.isfinite(angle_before):
        raise ValueError("The starting conformer has no finite MMFF94 energy or dihedral")
    frames = []
    for angle in range(-180, 181, step):
        candidate = Chem.Mol(mol)  # Every point starts from the same conformer, avoiding cumulative drift.
        conf = candidate.GetConformer()
        rdMolTransforms.SetDihedralDeg(conf, *atoms, float(angle))
        field = AllChem.MMFFGetMoleculeForceField(candidate, props)
        energy = float(field.CalcEnergy())
        measured = float(rdMolTransforms.GetDihedralDeg(conf, *atoms))
        coords = [[float(v) for v in point] for point in conf.GetPositions()]
        if not math.isfinite(energy) or not math.isfinite(measured) or any(not math.isfinite(v) for p in coords for v in p):
            raise ValueError("This geometry could not be evaluated with a finite MMFF94 energy")
        frames.append({"angle": angle, "measuredAngle": measured, "energy": energy, "coords": coords})
    best = min(range(len(frames)), key=lambda i: frames[i]["energy"])
    minimum = frames[best]["energy"]
    for frame in frames:
        frame["relativeEnergy"] = frame["energy"] - minimum
    result = {"spec": "rdkit-torsion/1", "method": METHOD, "rdkitVersion": rdBase.rdkitVersion,
              "atoms": atoms, "step": step, "elements": [a.GetSymbol() for a in mol.GetAtoms()],
              "source": {"molblock": block, "displayBlock": Chem.MolToMolBlock(mol), "sha256": hashlib.sha256(block.encode()).hexdigest(),
                         "smiles": Chem.MolToSmiles(Chem.RemoveHs(mol)), "angle": angle_before, "energy": initial},
              "frames": frames, "bestIndex": best}
    result["fingerprint"] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return result


def frame_molecule(study: dict, index: int) -> Chem.Mol:
    mol = prepare(study["source"]["molblock"])
    frame = study["frames"][index]
    for i, xyz in enumerate(frame["coords"]):
        mol.GetConformer().SetAtomPosition(i, xyz)
    mol.SetProp("_Name", f"torsion {frame['angle']} degrees")
    mol.SetProp("forcefield", "MMFF94")
    mol.SetDoubleProp("torsion_degrees", frame["angle"])
    mol.SetDoubleProp("energy", frame["energy"])
    mol.SetDoubleProp("relative_energy", frame["relativeEnergy"])
    mol.SetProp("method", METHOD)
    return mol


def save(study: dict, destination: str, title: str, selected: int, note: str, record: dict) -> None:
    """Destination is a newly created private directory supplied by the loopback server."""
    if not isinstance(title, str) or not title.strip() or len(title) > 100:
        raise ValueError("Give the study a name of at most 100 characters")
    if type(selected) is not int or not 0 <= selected < len(study["frames"]):
        raise ValueError("Select a point in the scan")
    if not isinstance(note, str) or len(note) > 1000:
        raise ValueError("Keep the note under 1,000 characters")
    root = Path(destination)
    study = {**study, "title": title.strip(), "selectedIndex": selected, "note": note, "record": record}
    (root / "study.json").write_text(json.dumps(study, indent=2) + "\n")
    (root / "source.mol").write_text(study["source"]["molblock"])
    with Chem.SDWriter(str(root / "scan.sdf")) as writer:
        for index in range(len(study["frames"])):
            writer.write(frame_molecule(study, index))
    with Chem.SDWriter(str(root / "selected.sdf")) as writer:
        writer.write(frame_molecule(study, selected))
    with (root / "energies.csv").open("w", newline="") as output:
        writer = csv.writer(output)
        writer.writerow(["target_degrees", "measured_degrees", "mmff94_kcal_mol", "relative_kcal_mol"])
        for frame in study["frames"]:
            writer.writerow([frame["angle"], frame["measuredAngle"], frame["energy"], frame["relativeEnergy"]])
    (root / "harness_torsion.py").write_bytes(Path(__file__).read_bytes())
    (root / "LICENSE").write_bytes(Path(__file__).resolve().parent.parent.joinpath("LICENSE").read_bytes())
    (root / "reproduce.py").write_text('''from pathlib import Path
import json
from harness_torsion import scan
root = Path(__file__).resolve().parent
saved = json.loads((root / "study.json").read_text())
fresh = scan((root / "source.mol").read_text(), saved["atoms"], saved["step"])
if len(fresh["frames"]) != len(saved["frames"]) or fresh["source"]["sha256"] != saved["source"]["sha256"]:
    raise SystemExit("The saved source or number of poses has changed")
error = max(abs(a["energy"] - b["energy"]) for a, b in zip(saved["frames"], fresh["frames"]))
coordinate_error = max(abs(x - y) for a, b in zip(saved["frames"], fresh["frames"]) for p, q in zip(a["coords"], b["coords"]) for x, y in zip(p, q))
print(json.dumps({"rdkitVersion": fresh["rdkitVersion"], "max_energy_difference_kcal_mol": error, "max_coordinate_difference_angstrom": coordinate_error, "frames": len(fresh["frames"])}))
if fresh["rdkitVersion"] != saved["rdkitVersion"] or error > 1e-7 or coordinate_error > 1e-9:
    raise SystemExit("This environment did not reproduce the saved scan within 1e-7 kcal/mol and 1e-9 angstrom")
(root / "reproduced.json").write_text(json.dumps(fresh, indent=2) + "\\n")
''')
    (root / "README.md").write_text(f"# {title.strip()}\n\n{METHOD}.\n\n"
        f"RDKit {study['rdkitVersion']}; atom indices in study.json are zero-based. Energies are kcal/mol. "
        "Relative energy is measured from the lowest sampled point of this same scan. No geometry "
        "minimization was performed: this is not a relaxed barrier, a free energy, an equilibrium "
        "population or a prediction of activity. Compare values only within this study.\n\n"
        "- source.mol: the exact conformer used as input.\n- scan.sdf: every sampled angle.\n"
        "- selected.sdf: the chosen pose.\n- energies.csv: measured angles and calculated energies.\n"
        "- study.json: full-precision coordinates, source, method, selection and note.\n"
        "- reproduce.py and harness_torsion.py: standalone calculation source.\n\n"
        f"With RDKit {study['rdkitVersion']} installed, run `python reproduce.py` to recompute the scan. "
        "MOL/SDF coordinates are rounded to four decimal places for exchange; study.json preserves "
        "the full-precision sampled coordinates used to calculate energy.\n\n"
        f"Note: {note}\n")
    with zipfile.ZipFile(root / "study.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(root.iterdir()):
            if path.name != "study.zip":
                archive.write(path, path.name)
