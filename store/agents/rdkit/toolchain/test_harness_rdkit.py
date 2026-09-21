"""The helper on the pinned RDKit: `"$RDKIT_PYTHON" -m unittest toolchain/test_harness_rdkit.py`.

Small molecules and few conformers, so the whole file runs in seconds. The paths RDKit rarely takes — an
embedding that fails, a build without Cairo, a labeller that refuses a valence — are stubbed at the one
RDKit call that decides them. Skipped where RDKit is not installed (plain `python3`).
"""
import contextlib
import hashlib
import io
import json
import os
import runpy
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, rdDetermineBonds
    import harness_rdkit as h
except ImportError:  # plain python3: the verdict's tests still run, these skip
    h = None

needs_rdkit = unittest.skipIf(h is None, "RDKit is not installed for this Python")

IBUPROFEN = "CC(C)Cc1ccc(cc1)C(C)C(=O)O"
IBUPROFEN_OH = "CC(C)(O)Cc1ccc(C(C)C(=O)O)cc1"
METHANE_MOL2 = """@<TRIPOS>MOLECULE
methane
 5 4 0 0 0
SMALL
NO_CHARGES

@<TRIPOS>ATOM
      1 C1          0.0000    0.0000    0.0000 C.3     1  UNL1        0.0000
      2 H1          0.6291    0.6291    0.6291 H       1  UNL1        0.0000
      3 H2         -0.6291   -0.6291    0.6291 H       1  UNL1        0.0000
      4 H3         -0.6291    0.6291   -0.6291 H       1  UNL1        0.0000
      5 H4          0.6291   -0.6291   -0.6291 H       1  UNL1        0.0000
@<TRIPOS>BOND
     1     1     2    1
     2     1     3    1
     3     1     4    1
     4     1     5    1
"""


def quiet(fn, *args, **kwargs):
    """Call `fn`, returning (its result, what it printed)."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        result = fn(*args, **kwargs)
    return result, out.getvalue()


def failing_then_real(real, fails=1, value=-1):
    """A stand-in for an RDKit call that fails `fails` times, then is the real call. Records whether each
    call asked for random coordinates."""
    calls = []

    def call(mol, *args, **kwargs):
        params = kwargs.get("params", args[-1] if args else None)
        calls.append(bool(getattr(params, "useRandomCoords", False)))
        return value if len(calls) <= fails else real(mol, *args, **kwargs)
    return call, calls


class Case(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name).resolve()

    def lead(self, smiles=IBUPROFEN, name="ibuprofen", conformers=1, parent=False):
        mol = h.mol_from_smiles(smiles, name)
        mol = h.embed_conformers(mol, n=conformers)
        return quiet(h.write_outputs, mol, name, self.out, parent=parent)[0]


@needs_rdkit
class Helpers(Case):
    def test_write_goes_through_a_hidden_temporary_and_takes_text_or_bytes(self):
        h._write(self.out / "a.txt", "text")
        h._write(self.out / "b.bin", b"\x00\x01")
        self.assertEqual((self.out / "a.txt").read_text(), "text")
        self.assertEqual((self.out / "b.bin").read_bytes(), b"\x00\x01")
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["a.txt", "b.bin"])

    def test_a_smarts_pattern_is_compiled_once(self):
        self.assertIs(h._pattern("[OX2H]"), h._pattern("[OX2H]"))

    def test_progress_tells_the_pane_the_stage(self):
        h.progress(self.out / "sub", "caffeine", "embedding", "10 conformers")
        data = json.loads((self.out / "sub" / h.PROGRESS).read_text())
        self.assertEqual((data["name"], data["stage"], data["detail"], data["pid"]), ("caffeine", "embedding", "10 conformers", os.getpid()))

    def test_progress_never_raises(self):
        blocker = self.out / "file"
        blocker.write_text("")
        h.progress(blocker, "x", "embedding")  # out is a file: mkdir fails, the design goes on
        self.assertEqual(blocker.read_text(), "")

    def test_mol_from_smiles_names_the_molecule_and_refuses_typos(self):
        self.assertEqual(h.mol_from_smiles("CCO").GetProp("_Name"), "CCO")
        self.assertEqual(h.mol_from_smiles("CCO", "ethanol").GetProp("_Name"), "ethanol")
        with self.assertRaisesRegex(ValueError, r"not a valid SMILES: 'C1CC'"):
            h.mol_from_smiles("C1CC")

    def test_similarity_and_substructure(self):
        self.assertEqual(h.similarity("c1ccccc1O", "c1ccccc1O"), 1.0)
        self.assertLess(h.similarity("c1ccccc1O", h.mol_from_smiles("CCCCCC")), 0.3)
        self.assertEqual(len(h.substructure("OCCO", "[OX2H]")), 2)
        self.assertEqual(h.substructure("CCC", "[OX2H]"), ())
        with self.assertRaisesRegex(ValueError, "not a valid SMARTS"):
            h.substructure("CCO", "[OX2H")

    def test_read_smi_and_table(self):
        smi = self.out / "list.smi"
        smi.write_text("# a series\n\nCCO ethanol\nOCCO  ethylene glycol \nC\n")
        mols = h.read_smi(smi)
        self.assertEqual([m.GetProp("_Name") for m in mols], ["ethanol", "ethylene glycol", "C"])
        rows = h.table([mols[0], Chem.MolFromSmiles("O")])
        self.assertEqual([(r["name"], r["formula"]) for r in rows], [("ethanol", "C2H6O"), ("", "H2O")])


@needs_rdkit
class Embedding(Case):
    def test_embed_3d_minimises_one_conformer(self):
        mol = h.embed_3d(h.mol_from_smiles("CCO", "ethanol"))
        self.assertEqual((mol.GetNumAtoms(), mol.GetNumConformers(), mol.GetProp("_Name")), (9, 1, "ethanol"))
        self.assertEqual(mol.GetProp("forcefield"), "MMFF94")
        self.assertLessEqual(mol.GetDoubleProp("energy"), mol.GetDoubleProp("energy_before"))
        self.assertEqual(json.loads(mol.GetProp("conformer_energies")), [round(mol.GetDoubleProp("energy"), 4)])

    def test_an_unnamed_molecule_is_named_by_its_smiles(self):
        self.assertEqual(h.embed_3d(Chem.MolFromSmiles("OCC")).GetProp("_Name"), "CCO")
        self.assertEqual(h.embed_conformers(Chem.MolFromSmiles("OCC"), n=3).GetProp("_Name"), "CCO")

    def test_embed_3d_retries_with_random_coordinates(self):
        call, calls = failing_then_real(h.rdDistGeom.EmbedMolecule)
        with mock.patch.object(h.rdDistGeom, "EmbedMolecule", call):
            mol = h.embed_3d(h.mol_from_smiles("CCO"))
        self.assertEqual(calls, [False, True])
        self.assertEqual(mol.GetNumConformers(), 1)

    def test_embed_3d_says_so_when_nothing_embeds(self):
        with mock.patch.object(h.rdDistGeom, "EmbedMolecule", return_value=-1), \
                self.assertRaisesRegex(RuntimeError, "no 3D embedding for CCO"):
            h.embed_3d(h.mol_from_smiles("CCO"))

    def test_uff_stands_in_when_mmff_has_no_parameters(self):
        self.assertEqual(h.embed_3d(h.mol_from_smiles("CB(C)C")).GetProp("forcefield"), "UFF")
        self.assertEqual(h.embed_conformers(h.mol_from_smiles("CB(C)C"), n=3).GetProp("forcefield"), "UFF")

    def test_one_conformer_asked_is_embed_3d(self):
        mol = h.embed_conformers(h.mol_from_smiles("CCCC"), n=1)
        self.assertEqual(mol.GetNumConformers(), 1)

    def test_the_search_keeps_distinct_minima_lowest_first_and_reports_its_stages(self):
        stages = []
        mol = h.embed_conformers(h.mol_from_smiles("CCCC", "butane"), n=10, on_stage=lambda s, d: stages.append(s))
        energies = json.loads(mol.GetProp("conformer_energies"))
        self.assertEqual(mol.GetNumConformers(), 3)
        self.assertEqual(energies, sorted(energies))
        self.assertAlmostEqual(mol.GetDoubleProp("energy"), energies[0], places=3)
        self.assertEqual(stages, ["embedding", "minimising"])
        self.assertFalse(mol.HasProp("unspecified_stereo"))

    def test_n_caps_the_ensemble_and_the_window_drops_strained_minima(self):
        self.assertEqual(h.embed_conformers(h.mol_from_smiles("CCCC"), n=2).GetNumConformers(), 2)
        self.assertEqual(h.embed_conformers(h.mol_from_smiles("CCCC"), n=10, window=0.5).GetNumConformers(), 1)

    def test_a_duplicate_minimum_is_dropped(self):
        seen = []
        real = h._best_rms

        def spy(*args):
            seen.append(real(*args))
            return seen[-1]
        with mock.patch.object(h, "_best_rms", spy):
            mol = h.embed_conformers(h.mol_from_smiles("C1CCCCC1"), n=10)
        self.assertTrue(any(rms < 0.3 for rms in seen), seen)
        self.assertEqual(mol.GetNumConformers(), 2)

    def test_a_single_minimum_is_not_aligned(self):
        with mock.patch.object(h.rdMolAlign, "AlignMolConformers") as align:
            mol = h.embed_conformers(h.mol_from_smiles("C"), n=5)
        self.assertEqual(mol.GetNumConformers(), 1)
        align.assert_not_called()

    def test_the_search_retries_with_random_coordinates_then_gives_up(self):
        call, calls = failing_then_real(h.rdDistGeom.EmbedMultipleConfs, value=[])
        with mock.patch.object(h.rdDistGeom, "EmbedMultipleConfs", call):
            self.assertGreater(h.embed_conformers(h.mol_from_smiles("CCCC"), n=3).GetNumConformers(), 0)
        self.assertEqual(calls, [False, True])
        with mock.patch.object(h.rdDistGeom, "EmbedMultipleConfs", return_value=[]), \
                self.assertRaisesRegex(RuntimeError, "no 3D embedding for CCCC"):
            h.embed_conformers(h.mol_from_smiles("CCCC"), n=3)

    def test_an_unspecified_stereocentre_is_pinned_across_the_ensemble_and_recorded(self):
        mol = h.embed_conformers(h.mol_from_smiles("CC(N)O"), n=5)
        self.assertEqual(json.loads(mol.GetProp("unspecified_stereo")), [1])
        labels = set()
        for conf in mol.GetConformers():
            probe = Chem.Mol(mol)
            Chem.AssignStereochemistryFrom3D(probe, confId=conf.GetId())
            labels.add(probe.GetAtomWithIdx(1).GetProp("_CIPCode"))
        self.assertEqual(len(labels), 1)

    def test_pin_stereo_leaves_the_centre_alone_when_the_probe_does_not_embed(self):
        molh = Chem.AddHs(h.mol_from_smiles("CC(N)O"))
        with mock.patch.object(h.rdDistGeom, "EmbedMolecule", return_value=-1):
            self.assertEqual(h._pin_stereo(molh, 7), [1])
        self.assertEqual(molh.GetAtomWithIdx(1).GetChiralTag(), Chem.ChiralType.CHI_UNSPECIFIED)
        self.assertEqual(h._pin_stereo(Chem.AddHs(h.mol_from_smiles("CCO")), 7), [])

    def test_best_rms_falls_back_to_the_plain_rms(self):
        skeleton = Chem.RemoveHs(h.embed_conformers(h.mol_from_smiles("CCCC"), n=3))
        with mock.patch.object(h.rdMolAlign, "GetBestRMS", side_effect=RuntimeError("too many matches")):
            rms = h._best_rms(skeleton, 0, 1)
        self.assertAlmostEqual(rms, AllChem.GetConformerRMS(Chem.Mol(skeleton), 1, 0))

    def test_stereocentres_fall_back_to_the_legacy_labeller(self):
        real = Chem.FindMolChiralCenters
        calls = []

        def labeller(mol, **kwargs):
            calls.append(kwargs["useLegacyImplementation"])
            if not kwargs["useLegacyImplementation"]:
                raise RuntimeError("Invariant Violation")
            return real(mol, **kwargs)
        with mock.patch.object(h.Chem, "FindMolChiralCenters", labeller):
            self.assertEqual(h._stereocentres(h.mol_from_smiles("CC(N)O")), [(1, "?")])
        self.assertEqual(calls, [False, True])


@needs_rdkit
class Describing(Case):
    def test_the_properties_of_ibuprofen_pass_the_rules(self):
        props = h.properties(h.mol_from_smiles(IBUPROFEN))
        self.assertEqual((props["formula"], props["mw"], props["hbd"], props["hba"]), ("C13H18O2", 206.28, 1, 1))
        self.assertEqual((props["lipinski_violations"], props["veber_violations"]), (0, 0))
        self.assertEqual((props["stereocenters"], props["unspecified_stereocenters"]), (1, 1))

    def test_each_violated_rule_is_listed(self):
        props = h.properties(h.mol_from_smiles("C" * 30 + "C(=O)O"))
        self.assertEqual([v.split()[0] for v in props["lipinski"]], ["logp"])
        self.assertEqual([v.split()[0] for v in props["veber"]], ["rotatable_bonds"])
        self.assertEqual((props["lipinski_violations"], props["veber_violations"]), (1, 1))

    def test_functional_groups_claim_their_heteroatoms_once(self):
        names = lambda smiles: [g["name"] for g in h.functional_groups(h.mol_from_smiles(smiles))]  # noqa: E731
        self.assertEqual(names("CC(=O)OC"), ["Ester"])  # the ester's O is not also an ether
        self.assertEqual(names("OC(=O)c1ccccc1"), ["Carboxylic acid", "Benzene ring"])
        self.assertEqual(names("c1ccc2ccccc2c1"), ["Naphthalene"])  # its benzene rings are part of it
        self.assertEqual(names("c1nncs1"), ["Aromatic ring"])  # aromatic, but not a named ring
        self.assertEqual(names("C1CCCCC1"), [])
        self.assertEqual(h.functional_groups(h.mol_from_smiles("OC(=O)CC"))[0]["atoms"], [0, 1, 2])

    def test_structural_alerts_name_their_catalog(self):
        alerts = h.structural_alerts(h.mol_from_smiles("Oc1ccccc1O"))
        self.assertEqual([(a["catalog"], a["name"]) for a in alerts], [("PAINS", "Catechol A"), ("Brenk", "Catechol")])
        self.assertEqual(h.structural_alerts(h.mol_from_smiles("CCO")), [])

    def test_depict_draws_a_png_with_cairo_or_without_it(self):
        mol = h.embed_3d(h.mol_from_smiles("CCO"))
        self.assertTrue(h.depict(mol, self.out / "cairo.png").read_bytes().startswith(b"\x89PNG"))
        no_cairo = SimpleNamespace(MolDraw2DCairo=mock.Mock(side_effect=RuntimeError("built without Cairo")))
        with mock.patch.object(h, "rdMolDraw2D", no_cairo):
            path = h.depict(mol, str(self.out / "pillow.png"))
        self.assertTrue(path.read_bytes().startswith(b"\x89PNG"))

    def test_an_svg_for_a_single_atom_has_no_bond_to_scale_by(self):
        flat = Chem.MolFromSmiles("C")
        h.rdDepictor.Compute2DCoords(flat)
        svg, coords, (width, height) = h._draw_svg(flat)
        self.assertIn("<svg", svg)
        self.assertEqual(len(coords), 1)
        self.assertGreater(width * height, 0)

    def test_the_flat_molecule_maps_back_to_the_3d_indices(self):
        mol = Chem.AddHs(h.mol_from_smiles("OCC"))
        flat, to3d = h._flat_with_map(mol)
        self.assertEqual((flat.GetNumAtoms(), to3d), (3, [0, 1, 2]))
        self.assertEqual(mol.GetNumAtoms(), 9)  # the 3D model keeps its hydrogens

    def test_the_formula_delta_names_what_changed(self):
        self.assertEqual(h._formula_delta("C2H6O", "C2H6O"), "isomer")
        self.assertEqual(h._formula_delta("C2H6", "C2H4"), "+2H")
        self.assertEqual(h._formula_delta("C3H8O", "C2H6"), "+C +O")
        self.assertEqual(h._formula_delta("C2H3O2-", "C4H8O2"), "−2C")
        self.assertEqual(h._formula_delta("C6H5Cl", "C6H6"), "+Cl")
        self.assertEqual(h._formula_delta("C6H5N+", "C6H5O"), "+N −O")


def flag_props(**overrides):
    base = {"lipinski_violations": 0, "lipinski": [], "veber_violations": 0, "veber": [], "logp": 2.0, "tpsa": 50.0,
            "qed": 0.5, "formal_charge": 0, "fsp3": 0.5, "aromatic_rings": 0}
    return {**base, **overrides}


@needs_rdkit
class Flags(unittest.TestCase):
    def flags(self, groups=(), alerts=(), centres=(), geometry=None, **props):
        return [(f["level"], f["text"]) for f in h._flags(flag_props(**props), list(groups), list(alerts), list(centres), geometry or {})]

    def test_a_quiet_molecule_gets_only_good_news(self):
        self.assertEqual([level for level, _ in self.flags()], ["good", "good", "good", "good"])

    def test_the_rule_of_five_one_violation_is_a_note_two_a_warning(self):
        self.assertIn(("note", "One Lipinski violation (mw 612 > 500) — still inside the rule, which allows one."),
                      self.flags(lipinski_violations=1, lipinski=["mw 612 > 500"]))
        self.assertEqual(self.flags(lipinski_violations=2)[0][0], "warn")

    def test_veber_logp_tpsa_and_qed_each_have_their_bands(self):
        self.assertEqual(self.flags(veber_violations=1, veber=["tpsa 150 > 140"])[1][0], "warn")
        self.assertIn("very lipophilic", self.flags(logp=6.0)[2][1])
        self.assertEqual(self.flags(logp=4.0)[2][0], "note")
        self.assertIn("is polar", self.flags(logp=-1.0)[2][1])
        self.assertEqual(self.flags(tpsa=120.0)[3][0], "note")
        self.assertEqual(self.flags(tpsa=150.0)[3][0], "warn")
        self.assertIn(("good", "QED 0.8 — attractive by the 2012 drug-likeness score (≥ 0.67)."), self.flags(qed=0.8))
        self.assertIn(("warn", "QED 0.2 — unattractive by the drug-likeness score (< 0.35)."), self.flags(qed=0.2))

    def test_groups_stereo_charge_flatness_and_alerts_add_notes(self):
        flags = self.flags(groups=[{"name": "Tetrazole"}, {"name": "Tertiary amine"}], alerts=[{"catalog": "PAINS", "name": "Catechol A"}],
                           centres=[(1, "?"), (4, "?"), (7, "R")], geometry={1: "S"}, formal_charge=-1, fsp3=0.1, aromatic_rings=2)
        texts = [text for _, text in flags[4:]]
        self.assertTrue(texts[0].startswith("Acidic group"))
        self.assertTrue(texts[1].startswith("Basic amine"))
        self.assertIn("2 stereocentres unspecified in the SMILES — the 3D model shows one arbitrary configuration (S, ?).", texts[2])
        self.assertEqual(texts[3], "Net formal charge -1.")
        self.assertTrue(texts[4].startswith("Flat and aromatic-rich (Fsp3 0.1, 2 aromatic rings)"))
        self.assertEqual(texts[5], "PAINS alert: Catechol A — a substructure worth a second look.")
        self.assertIn("1 stereocentre unspecified", self.flags(centres=[(1, "?")])[4][1])


@needs_rdkit
class Series(Case):
    def sdf(self, name, smiles, age):
        path = self.out / name
        path.write_text(Chem.MolToMolBlock(h.embed_3d(h.mol_from_smiles(smiles))) + "$$$$\n")
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
        return path

    def test_series_json_is_read_as_written(self):
        (self.out / h.SERIES).write_text(json.dumps({"molecules": [{"name": "a"}]}))
        self.assertEqual(h.read_series(self.out), {"molecules": [{"name": "a"}]})

    def test_a_folder_from_before_series_json_is_listed_from_its_sdfs_oldest_first(self):
        (self.out / h.SERIES).write_text(json.dumps(["not", "a", "series"]))
        self.sdf("new.sdf", "CCO", age=10)
        self.sdf("old.sdf", "C", age=100)
        self.sdf("new.conformers.sdf", "CCO", age=0)
        self.sdf(".hidden.sdf", "CCO", age=0)
        (self.out / "torn.sdf").write_text("not a molecule\n")
        series = h.read_series(self.out)
        self.assertEqual([(m["name"], m["smiles"], m["legacy"], m["parent"]) for m in series["molecules"]],
                         [("old", "C", True, None), ("new", "CCO", True, None)])

    def test_a_torn_or_missing_series_is_no_series(self):
        (self.out / h.SERIES).write_text('{"molecules": [')
        self.assertEqual(h.read_series(self.out)["molecules"], [])
        self.assertEqual(h.read_series(self.out / "nowhere"), {"spec": "rdkit-series/1", "molecules": []})

    def test_read_first_is_none_for_a_missing_or_unreadable_file(self):
        (self.out / "torn.sdf").write_text("not a molecule\n")
        self.assertIsNone(h._read_first(self.out / "torn.sdf"))
        self.assertIsNone(h._read_first(self.out / "missing.sdf"))


@needs_rdkit
class Parents(Case):
    def test_the_parent_is_the_closest_earlier_analogue_never_a_later_one(self):
        series = {"molecules": [{"name": "far", "smiles": "c1ccccc1"}, {"name": "lead", "smiles": "CCCCCCO"},
                                {"name": "me", "smiles": "CCCCCCN"}, {"name": "later", "smiles": "CCCCCCN"}]}
        entry, score = h._infer_parent("me", h.mol_from_smiles("CCCCCCN"), series)
        self.assertEqual(entry["name"], "lead")
        self.assertAlmostEqual(score, h.similarity("CCCCCCO", "CCCCCCN"))

    def test_children_unreadable_and_unrelated_molecules_are_never_the_parent(self):
        series = {"molecules": [{"name": "child", "smiles": "CCCCCCN", "parent": "me"}, {"name": "unnamed"},
                                {"name": "typo", "smiles": "C1CC"}, {"name": "salt", "smiles": "[Na+].[Cl-]"}]}
        self.assertEqual(h._infer_parent("me", h.mol_from_smiles("CCCCCCN"), series), (None, 0.0))

    def test_sharing_a_fragment_is_not_being_an_analogue(self):
        series = {"molecules": [{"name": "lead", "smiles": "CCCCCCO"}]}
        with mock.patch.object(h, "_mcs", return_value=SimpleNamespace(numAtoms=1)):
            self.assertEqual(h._infer_parent("me", h.mol_from_smiles("CCCCCCN"), series), (None, 0.0))

    def test_the_largest_overlap_wins_over_a_later_candidate(self):
        series = {"molecules": [{"name": "same", "smiles": "CCCCCCN"}, {"name": "close", "smiles": "CCCCCCO"}]}
        entry, score = h._infer_parent("me", h.mol_from_smiles("CCCCCCN"), series)
        self.assertEqual((entry["name"], score), ("same", 1.0))

    def test_the_parent_template_comes_from_its_sdf_or_else_its_smiles(self):
        self.lead("CCO", "ethanol")
        flat, to3d, record = h._parent_template({"name": "ethanol", "smiles": "CCO"}, self.out)
        self.assertEqual((flat.GetNumAtoms(), to3d, record["name"]), (3, [0, 1, 2], "ethanol"))
        (self.out / "ethanol.molecule.json").write_text("{")
        (self.out / "torn.sdf").write_text("not a molecule\n")
        flat, to3d, record = h._parent_template({"name": "ethanol", "smiles": "OCC", "sdf": "torn.sdf"}, self.out)
        self.assertEqual((flat.GetNumAtoms(), to3d, record), (3, [0, 1, 2], None))
        flat, _, record = h._parent_template({"name": "gone", "smiles": "CCCO"}, self.out)
        self.assertEqual((flat.GetNumAtoms(), record), (4, None))

    def relation(self, parent, smiles=IBUPROFEN_OH, name="ibuprofen_oh"):
        mol = h.embed_3d(h.mol_from_smiles(smiles, name))
        flat, to3d = h._flat_with_map(mol)
        return h._relation(flat, to3d, name, parent, self.out, h.read_series(self.out))

    def test_no_parent_asked_or_found(self):
        self.assertEqual(self.relation(False), (None, None, None))
        self.assertEqual(self.relation(None), (None, None, None))
        self.assertEqual(self.relation(42), (None, None, None))

    def test_a_parent_named_in_the_series_is_resolved_with_its_template(self):
        self.lead()
        record, template, query = self.relation("ibuprofen")
        self.assertEqual((record["name"], record["inferred"], record["change"], record["sdf"]), ("ibuprofen", False, "+O", "ibuprofen.sdf"))
        self.assertEqual((record["shared_atoms"], record["removed_atoms"]), (15, 0))
        self.assertAlmostEqual(record["deltas"]["mw"], 16.0, places=0)
        self.assertEqual(len(record["changed"]), 1)
        self.assertIsNotNone(query)
        parent = json.loads((self.out / "ibuprofen.molecule.json").read_text())
        drawn = {row[0]: (row[3], row[4]) for row in parent["depiction"]["atoms"]}
        position = template.GetConformer().GetAtomPosition(0)
        self.assertEqual((round(position.x, 4), round(position.y, 4)), drawn[0])  # the parent's own 2D layout

    def test_a_parent_depiction_without_every_atom_is_laid_out_afresh(self):
        self.lead()
        path = self.out / "ibuprofen.molecule.json"
        record = json.loads(path.read_text())
        record["depiction"]["atoms"] = [row[:3] for row in record["depiction"]["atoms"]]
        path.write_text(json.dumps(record))
        _, template, _ = self.relation("ibuprofen")
        self.assertEqual(template.GetNumConformers(), 1)

    def test_a_parent_given_as_smiles_is_matched_to_the_series_or_named_by_it(self):
        self.lead()
        record, _, _ = self.relation("OC(=O)C(C)c1ccc(CC(C)C)cc1")  # ibuprofen, written another way
        self.assertEqual(record["name"], "ibuprofen")
        record, _, _ = self.relation("CCc1ccccc1")
        self.assertEqual((record["name"], record["sdf"]), ("CCc1ccccc1", None))
        record, _, _ = self.relation("CCCCCCCCCCc1ccc(cc1)C(CCCCCCCCCCCC)C(=O)O")
        self.assertEqual(record["name"], "parent")
        with self.assertRaisesRegex(ValueError, "neither a molecule in .* nor a SMILES"):
            self.relation("C1CC")

    def test_a_parent_given_as_a_molecule(self):
        record, _, _ = self.relation(h.mol_from_smiles(IBUPROFEN, "lead"))
        self.assertEqual(record["name"], "lead")
        record, _, _ = self.relation(Chem.MolFromSmiles(IBUPROFEN))
        self.assertEqual(record["name"], "parent")

    def test_a_molecule_is_not_its_own_parent(self):
        self.lead()
        self.assertEqual(self.relation("ibuprofen", smiles=IBUPROFEN, name="ibuprofen"), (None, None, None))

    def test_a_parent_with_nothing_in_common_has_no_template(self):
        record, template, query = self.relation("c1ccccc1", smiles="CCO", name="ethanol")
        self.assertEqual((record["shared_atoms"], template, query), (0, None, None))
        self.assertEqual(record["changed"], [0, 1, 2])

    def test_a_common_substructure_that_matches_neither_has_no_pairs(self):
        with mock.patch.object(h, "_mcs", return_value=SimpleNamespace(numAtoms=2, smartsString="[Na][Cl]")):
            record, template, query = self.relation("CCCCCCO", smiles="CCCCCCN", name="amine")
        self.assertIsNotNone(query)
        self.assertEqual((record["shared_atoms"], template), (0, None))


@needs_rdkit
class Describe(Case):
    def test_the_record_of_a_conformer_ensemble_with_a_pinned_stereocentre(self):
        mol = h.embed_conformers(h.mol_from_smiles("CC(N)O", "aminoethanol"), n=5)
        record, svg = h.describe(mol, parent=False, out=self.out, series={"molecules": []})
        self.assertEqual((record["name"], record["smiles"], record["formula"]), ("aminoethanol", "CC(N)O", "C2H7NO"))
        self.assertTrue(record["inchikey"])
        self.assertEqual([(s["atom"], s["label"]) for s in record["stereocentres"]], [(1, "?")])
        self.assertIn(record["stereocentres"][0]["geometry"], ("R", "S"))
        self.assertEqual(record["properties"]["unspecified_stereocenters"], 1)
        count = mol.GetNumConformers()
        self.assertEqual((record["conformers"]["count"], len(record["conformers"]["energies"])), (count, count))
        self.assertEqual(record["conformers"]["file"], "aminoethanol.conformers.sdf" if count > 1 else "aminoethanol.sdf")
        self.assertEqual(record["conformers"]["delta"][0], 0.0)
        self.assertEqual(len(record["atoms"]), mol.GetNumAtoms())
        hydrogen = next(a for a in record["atoms"] if a["el"] == "H")
        self.assertIsNotNone(hydrogen["on"])
        self.assertIn("<svg", svg)
        self.assertFalse(record["depiction"]["aligned_to_parent"])

    def test_a_molecule_without_a_name_coordinates_or_series(self):
        record, _ = h.describe(Chem.MolFromSmiles("CCO"), out=self.out)
        self.assertEqual((record["name"], record["conformers"]["count"], record["conformers"]["file"]), ("molecule", 0, "molecule.sdf"))
        self.assertEqual(record["stereocentres"], [])
        self.assertIsNone(record["parent"])

    def test_a_2d_conformer_has_no_geometry(self):
        flat = Chem.MolFromSmiles("CC(N)O")
        h.rdDepictor.Compute2DCoords(flat)
        record, _ = h.describe(flat, "flat", parent=False, out=self.out, series={"molecules": []})
        self.assertEqual(record["stereocentres"], [{"atom": 1, "label": "?", "geometry": None}])

    def test_inchi_failures_and_an_odd_valence_do_not_stop_the_record(self):
        mol = h.embed_3d(h.mol_from_smiles("CC(N)O"))
        with mock.patch.object(h.Chem, "MolToInchi", side_effect=ValueError("inchi")), \
                mock.patch.object(h.rdCIPLabeler, "AssignCIPLabels", side_effect=RuntimeError("valence")):
            record, _ = h.describe(mol, "x", parent=False, out=self.out, series={"molecules": []})
        self.assertEqual((record["inchi"], record["inchikey"]), (None, None))
        self.assertIsNotNone(record["stereocentres"][0]["geometry"])  # the legacy label from 3D
        with mock.patch.object(h.Chem, "MolToInchi", return_value=""):
            record, _ = h.describe(mol, "x", parent=False, out=self.out, series={"molecules": []})
        self.assertEqual((record["inchi"], record["inchikey"]), ("", None))

    def test_charges_gasteiger_cannot_assign_and_a_lone_hydride(self):
        record, _ = h.describe(h.embed_3d(h.mol_from_smiles("C[Se]C")), "se", parent=False, out=self.out, series={"molecules": []})
        self.assertIsNone(record["atoms"][1]["q"])
        record, _ = h.describe(Chem.MolFromSmiles("[H-].[Na+]"), "hydride", parent=False, out=self.out, series={"molecules": []})
        self.assertEqual([(a["el"], a["on"]) for a in record["atoms"]], [("H", None), ("Na", None)])

    def test_conformer_energies_that_do_not_fit_are_dropped(self):
        mol = h.embed_3d(h.mol_from_smiles("CCO"))
        mol.SetProp("conformer_energies", "not json")
        self.assertEqual(h.describe(mol, "x", parent=False, out=self.out, series={"molecules": []})[0]["conformers"]["energies"], [])
        mol.SetProp("conformer_energies", "[1.0, 2.0]")
        self.assertEqual(h.describe(mol, "x", parent=False, out=self.out, series={"molecules": []})[0]["conformers"]["delta"], [])

    def test_an_analogue_is_drawn_aligned_to_its_parent_unless_that_fails(self):
        self.lead()
        mol = h.embed_3d(h.mol_from_smiles(IBUPROFEN_OH))
        record, _ = h.describe(mol, "ibuprofen_oh", parent="ibuprofen", out=self.out)
        self.assertTrue(record["depiction"]["aligned_to_parent"])
        with mock.patch.object(h.rdDepictor, "GenerateDepictionMatching2DStructure", side_effect=ValueError("no match")):
            record, _ = h.describe(mol, "ibuprofen_oh", parent="ibuprofen", out=self.out)
        self.assertFalse(record["depiction"]["aligned_to_parent"])
        self.assertEqual(len(record["depiction"]["atoms"]), 16)


@needs_rdkit
class WriteOutputs(Case):
    def test_an_ensemble_writes_every_file_the_pane_and_verdict_read(self):
        mol = h.embed_conformers(h.mol_from_smiles("CCCC"), n=10)
        report, printed = quiet(h.write_outputs, mol, "butane", self.out)
        names = {p.name for p in self.out.iterdir()}
        self.assertTrue({"butane.sdf", "butane.conformers.sdf", "butane.svg", "butane.png", "butane.molecule.json",
                         "series.json", "properties.json", "report.json", h.PROGRESS} <= names, names)
        self.assertFalse([n for n in names if n.endswith(".tmp")])
        self.assertEqual((self.out / "butane.conformers.sdf").read_text().count("$$$$"), 3)
        sdf = (self.out / "butane.sdf").read_text()
        self.assertEqual(sdf.count("$$$$"), 1)
        self.assertIn(">  <energy_before>", sdf)
        record = json.loads((self.out / "butane.molecule.json").read_text())
        self.assertEqual(record["sdfSha1"], hashlib.sha1(sdf.encode()).hexdigest())
        self.assertEqual((report["conformers"], report["energies"]["forcefield"], report["parent"]), (3, "MMFF94", None))
        self.assertEqual(json.loads((self.out / h.PROGRESS).read_text())["stage"], "done")
        self.assertTrue(printed.startswith(f"{self.out / 'butane.sdf'} · C4H10 · MW 58.12"))
        self.assertIn("3 conformers · 0 Lipinski violation(s)\n", printed)

    def test_a_single_conformer_removes_a_stale_ensemble(self):
        self.lead("CCCC", "butane", conformers=10)
        report = self.lead("CCCC", "butane", conformers=1)
        self.assertFalse((self.out / "butane.conformers.sdf").exists())
        self.assertEqual(report["conformers"], 1)

    def test_a_flat_molecule_gets_a_depiction_and_no_sdf(self):
        report, printed = quiet(h.write_outputs, Chem.MolFromSmiles("CCO"), "flat", self.out)
        self.assertFalse((self.out / "flat.sdf").exists())
        self.assertIsNone(report["sdf"])
        self.assertEqual(report["energies"], {"forcefield": None, "before": None, "final": None})
        self.assertTrue(printed.startswith(f"{self.out / 'flat.png'} · C2H6O"))
        self.assertIn("0 conformers", printed)

    def test_an_sdf_without_force_field_facts_carries_only_the_conformer_number(self):
        mol = Chem.AddHs(Chem.MolFromSmiles("CCO"))
        AllChem.EmbedMolecule(mol, randomSeed=7)
        quiet(h.write_outputs, mol, "raw", self.out)
        tags = [line for line in (self.out / "raw.sdf").read_text().splitlines() if line.startswith(">")]
        self.assertEqual(tags, [">  <conformer>"])

    def test_sdf_text_skips_energies_it_does_not_have(self):
        mol = h.embed_conformers(h.mol_from_smiles("CCCC"), n=3)
        text = h._sdf_text(mol, "butane", [0, 1], [-5.0])
        first, second = text.split("$$$$\n")[:2]
        self.assertIn(">  <energy>\n-5.0000", first)
        self.assertNotIn("energy", second)
        self.assertIn(">  <conformer>\n2", second)

    def test_rewriting_a_molecule_keeps_its_place_and_creation_time_in_the_series(self):
        (self.out / h.SERIES).write_text(json.dumps({"molecules": ["junk", {"name": "old"}, {"name": "ethanol", "createdAt": "2026-01-01T00:00:00Z"}]}))
        self.lead("CCO", "ethanol")
        self.lead("CCO", "old")
        series = json.loads((self.out / h.SERIES).read_text())
        self.assertEqual([m["name"] for m in series["molecules"]], ["old", "ethanol"])
        self.assertEqual(series["molecules"][1]["createdAt"], "2026-01-01T00:00:00Z")
        self.assertEqual(series["molecules"][0]["createdAt"], series["molecules"][0]["updatedAt"])
        self.assertEqual(series["molecules"][1]["parent"], None)

    def test_an_analogue_says_what_changed_from_its_parent(self):
        self.lead()
        mol = h.embed_3d(h.mol_from_smiles(IBUPROFEN_OH))
        report, printed = quiet(h.write_outputs, mol, "ibuprofen_oh", self.out)
        self.assertEqual({k: report["parent"][k] for k in ("name", "change", "inferred")}, {"name": "ibuprofen", "change": "+O", "inferred": True})
        self.assertIn(" · vs ibuprofen: +O, Tanimoto 0.", printed)
        entry = json.loads((self.out / h.SERIES).read_text())["molecules"][-1]
        self.assertEqual((entry["parent"], entry["change"]), ("ibuprofen", "+O"))


@needs_rdkit
class Design(Case):
    def test_design_a_lead_and_its_analogue(self):
        lead, _ = quiet(h.design, IBUPROFEN, "ibuprofen", out=self.out, conformers=3)
        self.assertEqual((lead["formula"], lead["parent"]), ("C13H18O2", None))
        analogue, _ = quiet(h.design, IBUPROFEN_OH, "ibuprofen_oh", out=str(self.out), conformers=1, parent="ibuprofen")
        self.assertEqual((analogue["parent"]["name"], analogue["parent"]["inferred"], analogue["conformers"]), ("ibuprofen", False, 1))

    def test_a_failed_design_tells_the_pane_and_raises(self):
        with mock.patch.object(h, "embed_conformers", side_effect=RuntimeError("no 3D embedding for X\nat line 2")), \
                self.assertRaisesRegex(RuntimeError, "no 3D embedding"):
            h.design("CCO", "ethanol", out=self.out)
        self.assertEqual(json.loads((self.out / h.PROGRESS).read_text())["stage"], "failed")
        self.assertEqual(json.loads((self.out / h.PROGRESS).read_text())["detail"], "no 3D embedding for X")

    def test_a_typo_is_raised_before_any_work(self):
        with self.assertRaisesRegex(ValueError, "not a valid SMILES"):
            h.design("C1CC", "typo", out=self.out, conformers=1)
        self.assertEqual(json.loads((self.out / h.PROGRESS).read_text())["detail"], "1 conformer")


@needs_rdkit
class LoadStructure(Case):
    def ensemble(self, name="butane", smiles="CCCC", n=10):
        quiet(h.write_outputs, h.embed_conformers(h.mol_from_smiles(smiles), n=n), name, self.out, parent=False)
        return self.out / f"{name}.sdf"

    def test_an_sdf_takes_its_ensemble_and_the_energies_written_in_it(self):
        mol = h.load_structure(self.ensemble())
        self.assertEqual((mol.GetNumConformers(), mol.GetProp("_Name"), mol.GetProp("forcefield")), (3, "butane", "MMFF94"))
        energies = json.loads(mol.GetProp("conformer_energies"))
        self.assertEqual(energies, sorted(energies))

    def test_the_ensemble_itself_loads_as_the_same_molecule(self):
        self.ensemble()
        mol = h.load_structure(self.out / "butane.conformers.sdf")
        self.assertEqual((mol.GetNumConformers(), mol.GetProp("_Name")), (3, "butane"))

    def test_an_ensemble_of_another_molecule_is_ignored_and_foreign_records_are_skipped(self):
        path = self.ensemble()
        (self.out / "butane.conformers.sdf").write_text(Chem.MolToMolBlock(h.embed_3d(h.mol_from_smiles("CCO"))) + "$$$$\n")
        with path.open("a") as sdf:
            sdf.write(Chem.MolToMolBlock(h.embed_3d(h.mol_from_smiles("CC=C"))) + "$$$$\n")  # another molecule after it
        mol = h.load_structure(path)
        self.assertEqual(mol.GetNumConformers(), 1)

    def test_energies_stay_with_their_conformers_when_a_foreign_record_sits_between_them(self):
        butane = h.embed_conformers(h.mol_from_smiles("CCCC"), n=3)
        ethanol = h.embed_3d(h.mol_from_smiles("CCO"))
        record = lambda mol, conf, energy: Chem.MolToMolBlock(mol, confId=conf) + f">  <energy>\n{energy}\n\n$$$$\n"  # noqa: E731
        (self.out / "poses.sdf").write_text(record(butane, 0, 1.5) + record(ethanol, 0, 99.0) + record(butane, 1, 2.5))
        mol = h.load_structure(self.out / "poses.sdf")
        self.assertEqual(mol.GetNumConformers(), 2)
        self.assertEqual(json.loads(mol.GetProp("conformer_energies")), [1.5, 2.5])

    def test_missing_or_unreadable_energies_are_computed(self):
        mol = h.embed_conformers(h.mol_from_smiles("CCCC"), n=3)
        text = "".join(Chem.MolToMolBlock(mol, confId=c) + ">  <energy>\nabc\n\n$$$$\n" for c in range(mol.GetNumConformers()))
        (self.out / "hand.sd").write_text(text)
        loaded = h.load_structure(self.out / "hand.sd")
        self.assertEqual(loaded.GetProp("forcefield"), "MMFF94")
        self.assertEqual(len(json.loads(loaded.GetProp("conformer_energies"))), 3)
        with mock.patch.object(h, "_forcefield", side_effect=RuntimeError("no parameters")):
            self.assertFalse(h.load_structure(self.out / "hand.sd").HasProp("conformer_energies"))

    def test_a_flat_mol_file_has_no_energies(self):
        flat = Chem.MolFromSmiles("CCO")
        h.rdDepictor.Compute2DCoords(flat)
        (self.out / "flat.mol").write_text(Chem.MolToMolBlock(flat))
        mol = h.load_structure(self.out / "flat.mol")
        self.assertEqual((mol.GetNumAtoms(), mol.HasProp("conformer_energies"), mol.HasProp("forcefield")), (3, False, False))

    def test_a_pdb_gets_its_bond_orders_perceived_or_keeps_its_connectivity(self):
        Chem.MolToPDBFile(h.embed_3d(h.mol_from_smiles("CC=O")), str(self.out / "acetaldehyde.pdb"))
        mol = h.load_structure(self.out / "acetaldehyde.pdb")
        self.assertEqual(Chem.MolToSmiles(Chem.RemoveHs(mol)), "CC=O")
        with mock.patch.object(rdDetermineBonds, "DetermineBondOrders", side_effect=ValueError("charge")) as determine:
            mol = h.load_structure(self.out / "acetaldehyde.pdb")
        determine.assert_called_once()
        self.assertEqual((mol.GetNumAtoms(), mol.GetProp("_Name")), (7, "acetaldehyde"))

    def test_a_mol2_file(self):
        (self.out / "methane.mol2").write_text(METHANE_MOL2)
        mol = h.load_structure(self.out / "methane.mol2")
        self.assertEqual((mol.GetNumAtoms(), mol.GetProp("_Name")), (5, "methane"))

    def test_what_rdkit_cannot_read_is_an_error(self):
        (self.out / "bad.pdb").write_text("nonsense\n")
        with self.assertRaisesRegex(ValueError, "bad.pdb: no molecule RDKit could sanitize"):
            h.load_structure(self.out / "bad.pdb")
        with self.assertRaisesRegex(ValueError, "cannot read .xyz files"):
            h.load_structure(self.out / "x.xyz")


@needs_rdkit
class Pane(Case):
    def test_describe_file_for_a_toolchain_sdf_and_a_hand_written_one(self):
        self.lead("CCCCCCO", "hexanol")
        record = h.describe_file(self.out / "hexanol.sdf")
        self.assertEqual((record["name"], record["computedBy"], record["parent"]), ("hexanol", "viewer", None))
        self.assertIn("<svg", record["svgText"])
        (self.out / "hand.sdf").write_text(Chem.MolToMolBlock(h.embed_3d(h.mol_from_smiles("CCCCCCN"))) + "$$$$\n")
        record = h.describe_file(self.out / "hand.sdf")
        self.assertEqual((record["name"], record["parent"]["name"], record["parent"]["inferred"]), ("hand", "hexanol", True))

    def serve(self, lines):
        stdin, stdout = io.StringIO("".join(line + "\n" for line in lines)), io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", stdout):
            code = h._serve()
        return code, [json.loads(line) for line in stdout.getvalue().splitlines()]

    def test_serve_answers_one_line_per_request_and_survives_bad_ones(self):
        self.lead("CCO", "ethanol")
        code, replies = self.serve(["", "not json", '{"id": 1, "op": "ping"}', '{"id": 2, "op": "render"}',
                                    json.dumps({"id": 3, "op": "describe", "path": str(self.out / "missing.sdf")}),
                                    json.dumps({"id": 4, "op": "describe", "path": str(self.out / "ethanol.sdf")})])
        self.assertEqual(code, 0)
        self.assertEqual(replies[0], {"id": 1, "ok": True, "result": "pong"})
        self.assertEqual(replies[1], {"id": 2, "ok": False, "error": "unknown op 'render'"})
        self.assertEqual((replies[2]["ok"], replies[2]["error"].split(":")[0]), (False, "OSError"))
        self.assertEqual((replies[3]["id"], replies[3]["ok"], replies[3]["result"]["name"]), (4, True, "ethanol"))

    def test_the_command_line(self):
        _, printed = quiet(h.main, ["design", "CCO", "ethanol", "--parent", "none", "--conformers", "1", "--out", str(self.out)])
        self.assertIn("C2H6O", printed)
        code, printed = quiet(h.main, ["describe", str(self.out / "ethanol.sdf")])
        self.assertEqual((code, json.loads(printed)["name"]), (0, "ethanol"))
        with mock.patch.object(sys, "stdin", io.StringIO("")):
            self.assertEqual(h.main(["serve"]), 0)

    def test_run_as_a_script(self):
        with mock.patch.object(sys, "argv", ["harness_rdkit.py", "serve"]), mock.patch.object(sys, "stdin", io.StringIO("")), \
                self.assertRaises(SystemExit) as exit:
            runpy.run_path(h.__file__, run_name="__main__")
        self.assertEqual(exit.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
