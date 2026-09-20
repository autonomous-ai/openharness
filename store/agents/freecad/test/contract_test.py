"""Fast schema, source-selection and handoff tests; no native CAD dependencies."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent / "skills" / "freecad" / "scripts"
sys.path.insert(0, str(TOOLS))
from design import validate
from handoff import read_sources, fingerprints, source_revision, write_handoff


def project():
    return json.loads((HERE / "fixtures" / "bench-bracket" / "design.json").read_text())


class ContractTests(unittest.TestCase):
    def test_saved_jobs_validate(self):
        validate(project())
        validate(json.loads((HERE.parent / "template" / "design.json").read_text()))

    def test_rejects_unknown_fields_and_unmeasured_jobs(self):
        for change in [{"checks": []}, {"units": "inch"}, {"spec": True}, {"approved": True}, {"parts": []}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate({**project(), **change})

    def test_rejects_unsafe_or_generated_source_paths(self):
        for name in ["../secrets", "/tmp/file", ".env", "a/.env", "a/../b", "a//b", "a\\b", "C:/x", "a\nfile",
                     "handoff/checks.json", "tools/design.py", "PART.STEP", "part.FCStd", "REBUILD.txt"]:
            data = project()
            data["sourceFiles"].append(name)
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate(data)

    def test_requires_unique_names_and_sources(self):
        for mutate in [lambda p: p["parts"].append({**p["parts"][0], "id": "BRACKET", "object": "Other"}),
                       lambda p: p["references"].append("Bracket"),
                       lambda p: p["sourceFiles"].append("DESIGN.json"),
                       lambda p: p["checks"].append(p["checks"][0]),
                       lambda p: p["sourceFiles"].remove("design.json")]:
            data = project()
            mutate(data)
            with self.assertRaises(ValueError):
                validate(data)

    def test_checks_reject_invalid_numbers_names_and_types(self):
        for fields in [{"type": []}, {"part": "Missing"}, {"size": [True, 20, 30]}, {"size": [1, 2, float("nan")]},
                       {"size": [1, 0, 3]}, {"size": [1, 2]}, {"tolerance": -1}, {"tolerence": .1}]:
            data = project()
            data["checks"][0].update(fields)
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                validate(data)

    def test_bore_and_clearance_constraints(self):
        for fields in [{"axis": [0, 0, 0]}, {"length": .01}, {"diameter": 0}, {"wall": .01}, {"tolerance": 4}]:
            data = project()
            data["checks"][1].update(fields)
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                validate(data)
        data = project()
        data["checks"][6]["maximum"] = 4
        with self.assertRaises(ValueError):
            validate(data)

    def test_source_allowlist_and_fingerprints(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = project()
            for name in data["sourceFiles"]:
                (root / name).write_text(name)
            (root / "private-notes.txt").write_text("Do not bundle")
            sources = read_sources(data, directory)
            self.assertEqual(set(sources), set(data["sourceFiles"]))
            self.assertEqual(source_revision(sources), source_revision(dict(reversed(list(sources.items())))))
            changed = {**sources, "dimensions.json": b"new dimensions"}
            self.assertNotEqual(source_revision(sources), source_revision(changed))
            self.assertNotEqual(fingerprints(sources)["dimensions.json"], fingerprints(changed)["dimensions.json"])

    def test_symlink_source_or_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "real").mkdir()
            (root / "real" / "data.json").write_text("{}"); (root / "linked").symlink_to(root / "real", target_is_directory=True)
            (root / "direct.json").symlink_to(root / "real" / "data.json")
            for path in ["direct.json", "linked/data.json"]:
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, "symlink"):
                    read_sources({"sourceFiles": [path]}, directory)

    def test_handoff_is_escaped_and_bundle_is_portable_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = project()
            data["title"] = '<script>alert("unsafe")</script>'
            part = {**data["parts"][0], "boundsMM": [80, 40, 45], "volumeMM3": 1234,
                    "meshTriangles": 200, "files": {"svg": "parts/bracket.svg", "step": "parts/bracket.step", "stl": "parts/bracket.stl"}}
            report = {"parts": [part], "checks": [{"passed": True, "id": "a", "reason": "A < B", "measured": {"actual": 1}, "requirement": {"expected": 1}}],
                      "requirementsPassed": True, "freecadVersion": "test-fixture"}
            (root / "handoff" / "parts").mkdir(parents=True)
            for name in ["part.step", "part.stl", "part.FCStd", "handoff/parts/bracket.svg", "handoff/parts/bracket.step", "handoff/parts/bracket.stl"]:
                (root / name).write_text("export fixture")
            (root / "secret.txt").write_text("not selected")
            sources = {"part.FCMacro": b"# source", "design.json": json.dumps(data).encode(), "dimensions.json": b"{}"}
            write_handoff(data, report, sources, directory, str(TOOLS))
            page = (root / "handoff" / "index.html").read_text()
            self.assertNotIn('<script>', page)
            self.assertIn('&lt;script&gt;', page)
            self.assertIn('A &lt; B', page)
            with zipfile.ZipFile(root / "handoff" / "project.zip") as archive:
                names = archive.namelist()
                self.assertEqual(len(names), len(set(names)))
                self.assertNotIn("secret.txt", names)
                self.assertNotIn("handoff/project.zip", names)
                self.assertIn("tools/geometry.py", names)
                self.assertIn("tools/LICENSE", names)
                self.assertIn("REBUILD.txt", names)
                self.assertEqual(archive.read("part.FCMacro"), sources["part.FCMacro"])
                self.assertIsNone(archive.testzip())


if __name__ == "__main__":
    unittest.main(verbosity=2)
