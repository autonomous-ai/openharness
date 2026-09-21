import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from rdkit import Chem
from rdkit.Chem import AllChem, rdMolTransforms
import harness_torsion as torsion


def molecule(smiles):
    mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
    if AllChem.EmbedMolecule(mol, randomSeed=7) != 0:
        raise AssertionError("fixture could not embed")
    if AllChem.MMFFHasAllMoleculeParams(mol):
        AllChem.MMFFOptimizeMolecule(mol)
    return mol


class TorsionTests(unittest.TestCase):
    def test_rigid_scan_preserves_bonds_and_matches_independent_forcefield(self):
        mol = molecule("CCCC")
        block = Chem.MolToMolBlock(mol)
        before = torsion.prepare(block)
        lengths = [rdMolTransforms.GetBondLength(before.GetConformer(), b.GetBeginAtomIdx(), b.GetEndAtomIdx()) for b in before.GetBonds()]
        study = torsion.scan(block, [0, 1, 2, 3])
        self.assertEqual(len(study["frames"]), 25)
        self.assertEqual(study["source"]["sha256"], hashlib.sha256(block.encode()).hexdigest())
        self.assertEqual(torsion.scan(block, [0, 1, 2, 3])["fingerprint"], study["fingerprint"])
        for frame in study["frames"]:
            independent = Chem.Mol(before)
            for i, xyz in enumerate(frame["coords"]):
                independent.GetConformer().SetAtomPosition(i, xyz)
            props = AllChem.MMFFGetMoleculeProperties(independent, mmffVariant="MMFF94")
            energy = AllChem.MMFFGetMoleculeForceField(independent, props).CalcEnergy()
            self.assertAlmostEqual(energy, frame["energy"], places=10)
            measured = rdMolTransforms.GetDihedralDeg(independent.GetConformer(), 0, 1, 2, 3)
            error = (measured - frame["angle"] + 180) % 360 - 180
            self.assertAlmostEqual(error, 0, places=9)
            for bond, length in zip(independent.GetBonds(), lengths):
                self.assertAlmostEqual(rdMolTransforms.GetBondLength(independent.GetConformer(), bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()), length, places=10)
        self.assertAlmostEqual(study["frames"][0]["energy"], study["frames"][-1]["energy"], places=10)
        self.assertIn(study["bestIndex"], [0, 24])
        self.assertGreater(study["frames"][12]["relativeEnergy"], 3)
        self.assertEqual(Chem.MolToMolBlock(mol), block, "input molecule remains untouched")

    def test_different_authored_graph_and_v3000_input(self):
        mol = molecule("CC(=O)OCCc1ccccc1")
        block = Chem.MolToMolBlock(mol, forceV3000=True)
        candidates = torsion.options(block)["candidates"]
        self.assertGreater(len(candidates), 2)
        for candidate in candidates:
            result = torsion.scan(block, candidate["atoms"], 30)
            self.assertEqual(len(result["frames"]), 13)
            self.assertIn("V2000", result["source"]["displayBlock"])
            self.assertEqual(result["elements"], [a.GetSymbol() for a in mol.GetAtoms()])

    def test_invalid_chains_rings_double_bonds_and_missing_hydrogens_fail(self):
        cases = [("C1CCC1", [0, 1, 2, 3], "non-ring"), ("CC=CC", [0, 1, 2, 3], "single"), ("CCCC", [0, 2, 1, 3], "connected"), ("CCCC", [0, 1, 2, 2], "distinct")]
        for smiles, atoms, message in cases:
            with self.subTest(smiles=smiles, atoms=atoms), self.assertRaisesRegex(ValueError, message):
                torsion.scan(Chem.MolToMolBlock(molecule(smiles)), atoms)
        self.assertEqual(torsion.options(Chem.MolToMolBlock(molecule("C1CCCCC1")))["candidates"], [])
        with self.assertRaisesRegex(ValueError, "explicit hydrogen"):
            torsion.options(Chem.MolToMolBlock(Chem.RemoveHs(molecule("CCCC"))))
        with self.assertRaisesRegex(ValueError, "parameters"):
            torsion.options(Chem.MolToMolBlock(molecule("CB(C)C")))
        with self.assertRaisesRegex(ValueError, "spacing"):
            torsion.scan(Chem.MolToMolBlock(molecule("CCCC")), [0, 1, 2, 3], 1)

    def test_portable_archive_reproduces_after_extraction(self):
        study = torsion.scan(Chem.MolToMolBlock(molecule("CCCO")), [0, 1, 2, 3], 10)
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            torsion.save(study, str(root), "An alcohol torsion", 7, "Compare this orientation", {})
            with zipfile.ZipFile(root / "study.zip") as archive:
                self.assertIsNone(archive.testzip())
                extracted = root / "independent"
                archive.extractall(extracted)
            result = subprocess.run([sys.executable, str(extracted / "reproduce.py")], cwd="/", capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["max_energy_difference_kcal_mol"], 0)
            poses = list(Chem.SDMolSupplier(str(extracted / "scan.sdf"), removeHs=False))
            self.assertEqual(len(poses), 37)
            self.assertTrue(all(p is not None for p in poses))
            chosen = list(Chem.SDMolSupplier(str(extracted / "selected.sdf"), removeHs=False))[0]
            self.assertEqual(chosen.GetDoubleProp("torsion_degrees"), -110)
            for i, xyz in enumerate(study["frames"][7]["coords"]):
                actual = chosen.GetConformer().GetAtomPosition(i)
                for a, b in zip(actual, xyz):
                    self.assertLess(abs(a - b), .000051)


    def test_worker_rejects_changed_calculation_before_writing_and_keeps_serving(self):
        block = Chem.MolToMolBlock(molecule("CCCC"))
        with tempfile.TemporaryDirectory() as root:
            request = {"id": 1, "op": "torsion_keep", "molblock": block, "atoms": [0, 1, 2, 3],
                       "name": "butane", "step": 15, "fingerprint": "a changed calculation",
                       "destination": root, "selected": 8, "title": "Must not be saved", "note": ""}
            worker = Path(__file__).with_name("harness_rdkit.py")
            result = subprocess.run([sys.executable, str(worker), "serve"],
                                    input=json.dumps(request) + '\n{"id":2,"op":"ping"}\n',
                                    capture_output=True, text=True, check=True)
            answers = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertFalse(answers[0]["ok"])
            self.assertIn("calculation changed", answers[0]["error"])
            self.assertEqual(answers[1], {"id": 2, "ok": True, "result": "pong"})
            self.assertEqual(list(Path(root).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
