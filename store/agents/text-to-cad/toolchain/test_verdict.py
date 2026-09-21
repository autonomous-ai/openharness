"""python -m unittest toolchain/test_verdict.py — the verdict from what cadgen says, no cadgen needed.

The payloads below have the shapes cadgen 0.5.1 (CADGEN_VERSION) prints with `--format json`:
`step inspect validate` lists only the failing shapes in `parts` ({ref, name, reasons, occurrences})
and reports errors as objects with a `message`; `step inspect refs --facts` has one token per entry
with `summary.shapeCount`, `entryFacts.size` and `warnings`.
"""
import io
import json
import os
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import verdict  # noqa: E402
from verdict import judge  # noqa: E402

VERDICT = Path(__file__).parent / "verdict.py"
FACTS = {"ok": True, "tokens": [{"summary": {"kind": "part", "shapeCount": 1}, "warnings": [], "entryFacts": {"size": [40.0, 30.0, 10.0]}}], "errors": []}
VALID = {"ok": True, "failureCount": 0, "parts": [], "errors": []}
OPEN_LID = {
    "ok": False, "entry": "STEP/lid.step", "occurrenceCount": 2, "prototypeCount": 1, "selfIntersectionCheck": "first-placement",
    "failureCount": 2,
    "parts": [{"ref": "o1.1", "name": "lid", "reasons": ["openShell", "nonPositiveVolume"], "solidCount": 1, "volumes": [-3.0],
               "occurrences": [{"ref": "o1.1", "name": "lid"}, {"ref": "o1.2", "name": "lid"}]}],
    "errors": [],
}


class Judge(unittest.TestCase):
    def test_a_valid_step_is_ready_with_all_three_phases_done(self):
        v = judge(FACTS, VALID, has_models=True, step="STEP/part.step")
        self.assertTrue(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "part.step · 1 solid · 40 × 30 × 10 mm · valid")
        self.assertEqual(v["artifact"], "STEP/part.step")
        self.assertEqual(v["findings"], [])

    def test_no_step_yet_is_building_and_names_no_artifact(self):
        v = judge({}, {}, has_models=True, step=None)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
        self.assertEqual(v["summary"], "no STEP yet")
        # verdict.schema.json: artifact is a string when present — never null.
        self.assertNotIn("artifact", v)

    def test_an_empty_workspace_has_no_model_yet(self):
        v = judge({}, {}, has_models=False, step=None)
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertEqual(v["summary"], "no model yet")

    def test_an_invalid_solid_fails_validate_with_its_reasons(self):
        v = judge(FACTS, OPEN_LID, has_models=True, step="STEP/lid.step")
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][2]["state"], "failed")
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "validate", "message": "lid: openShell, nonPositiveVolume", "ref": "o1.1"}])
        self.assertEqual(v["summary"], "lid.step · 1 solid · 40 × 30 × 10 mm · not valid")

    def test_a_failing_part_without_a_name_or_reasons_still_says_something(self):
        v = judge(FACTS, {"ok": False, "failureCount": 2, "parts": [{"ref": "o1.3", "reasons": []}, {}, "not an object"], "errors": []},
                  has_models=True, step="STEP/x.step")
        self.assertEqual([f["message"] for f in v["findings"]], ["o1.3: invalid geometry", "a solid: invalid geometry"])
        self.assertEqual(v["findings"][0]["ref"], "o1.3")
        self.assertNotIn("ref", v["findings"][1])  # a finding's ref is a string when present

    def test_error_objects_become_their_message_not_a_dict_repr(self):
        valid = {"ok": False, "errors": [{"message": "checking lid [o1.1] failed: boom", "ref": "o1.1"}, "plain words", {"code": 7}]}
        facts = {"ok": False, "tokens": [{"summary": {}, "warnings": ["thin wall", {"message": "tiny face"}]}],
                 "errors": [{"message": "STEP/x.step: file not found", "line": 1}]}
        v = judge(facts, valid, has_models=True, step="STEP/x.step")
        self.assertEqual([(f["severity"], f["kind"], f["message"]) for f in v["findings"]], [
            ("error", "validate", "checking lid [o1.1] failed: boom"),
            ("error", "validate", "plain words"),
            ("error", "validate", "{'code': 7}"),
            ("warning", "facts", "thin wall"),
            ("warning", "facts", "tiny face"),
            ("error", "facts", "STEP/x.step: file not found"),
        ])
        self.assertFalse(v["ready"])

    def test_a_clean_validate_with_a_facts_error_is_not_ready(self):
        v = judge({"ok": False, "tokens": [], "errors": ["no tree"]}, VALID, has_models=True, step="STEP/x.step")
        self.assertFalse(v["ready"])
        self.assertEqual(v["summary"], "x.step · not valid")

    def test_summary_counts_solids_and_ignores_a_malformed_size(self):
        facts = {"tokens": [{"summary": {"shapeCount": 3}, "entryFacts": {"size": [1, 2]}}]}
        v = judge(facts, VALID, has_models=True, step="STEP/asm.step")
        self.assertEqual(v["summary"], "asm.step · 3 solids · valid")
        v = judge({"tokens": [{"summary": {"shapeCount": "3"}, "entryFacts": {"size": "big"}}]}, VALID, has_models=True, step="STEP/asm.step")
        self.assertEqual(v["summary"], "asm.step · valid")


class Workspace(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def touch(self, rel, mtime):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("ISO-10303-21;\n")
        os.utime(path, (mtime, mtime))
        return path

    def test_newest_step_takes_the_latest_step_or_stp_outside_skipped_dirs(self):
        now = time.time()
        self.touch("mid.step", now - 50)  # os.walk is top-down: this is seen first,
        self.touch("STEP/old.stp", now - 100)  # this older one after it,
        newest = self.touch("STEP/sub/NEW.STP", now - 10)  # and the newest last
        for skipped in ("tmp", ".harness", "node_modules", ".venv", "__pycache__", ".hidden"):
            self.touch(f"{skipped}/later.step", now)
        self.touch("STEP/notes.txt", now)
        self.assertEqual(verdict.newest_step(self.root), newest)

    def test_newest_step_skips_a_dangling_link(self):
        real = self.touch("STEP/real.step", time.time() - 10)
        (self.root / "STEP" / "gone.step").symlink_to(self.root / "nowhere.step")
        self.assertEqual(verdict.newest_step(self.root), real)

    def test_newest_step_is_none_without_a_step(self):
        self.assertIsNone(verdict.newest_step(self.root))

    def test_models_are_the_scripts_directly_in_src(self):
        self.assertEqual(verdict.models(self.root), [])
        (self.root / "src" / "lib").mkdir(parents=True)
        (self.root / "src" / "b.py").write_text("")
        (self.root / "src" / "a.py").write_text("")
        (self.root / "src" / "lib" / "__init__.py").write_text("")
        (self.root / "src" / "README.md").write_text("")
        self.assertEqual([p.name for p in verdict.models(self.root)], ["a.py", "b.py"])


def fake_cadgen(root: Path, body: str) -> Path:
    exe = root / "bin" / "cadgen"
    exe.parent.mkdir(parents=True, exist_ok=True)
    exe.write_text("#!/bin/sh\n" + body)
    exe.chmod(0o755)
    return exe


class Cadgen(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        patcher = mock.patch.object(verdict, "WORKSPACE", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def run_with(self, body):
        exe = fake_cadgen(self.root, body)
        with mock.patch.dict(os.environ, {"CADGEN": str(exe)}):
            return verdict.cadgen("step", "inspect", "validate", "STEP/x.step")

    def test_the_last_stdout_line_is_the_json_and_the_arguments_ask_for_json(self):
        got = self.run_with('echo "$@" > args; echo "progress"; echo \'{"ok": true, "parts": []}\'; exit 1\n')
        self.assertEqual(got, {"ok": True, "parts": []})
        self.assertEqual((self.root / "args").read_text().split(), ["step", "inspect", "validate", "STEP/x.step", "--format", "json"])

    def test_no_stdout_is_an_error_carrying_stderr(self):
        self.assertEqual(self.run_with('echo "cadgen: no such command" >&2; exit 2\n'), {"ok": False, "errors": ["cadgen: no such command"]})

    def test_stdout_that_is_not_json_is_an_error(self):
        self.assertEqual(self.run_with('echo "Traceback: boom"\n'), {"ok": False, "errors": ["Traceback: boom"]})
        self.assertEqual(self.run_with('echo "not json"; echo "stderr wins" >&2\n'), {"ok": False, "errors": ["stderr wins"]})

    def test_a_missing_cadgen_is_an_error_not_a_crash(self):
        with mock.patch.dict(os.environ, {"CADGEN": str(self.root / "nope" / "cadgen")}):
            got = verdict.cadgen("step", "inspect", "validate", "x.step")
        self.assertFalse(got["ok"])
        self.assertIn("No such file", got["errors"][0])

    def test_a_hung_cadgen_times_out_into_an_error(self):
        with mock.patch.object(verdict.subprocess, "run", side_effect=subprocess.TimeoutExpired(["cadgen"], 600)):
            got = verdict.cadgen("step", "inspect", "validate", "x.step")
        self.assertEqual(got["ok"], False)
        self.assertIn("timed out", got["errors"][0])

    def test_without_CADGEN_it_uses_the_cadgen_beside_this_python(self):
        env = {k: v for k, v in os.environ.items() if k != "CADGEN"}
        done = subprocess.CompletedProcess([], 0, stdout='{"ok": true}\n', stderr="")
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(verdict.subprocess, "run", return_value=done) as run:
            self.assertEqual(verdict.cadgen("step"), {"ok": True})
        self.assertEqual(run.call_args.args[0][0], str(Path(sys.executable).parent / "cadgen"))
        self.assertEqual(run.call_args.kwargs["cwd"], self.root)


CADGEN_SCRIPT = """case "$3" in
  validate) cat "$CADGEN_FIXTURES/validate.json" ;;
  refs) cat "$CADGEN_FIXTURES/refs.json" ;;
esac
echo "$@" >> "$CADGEN_FIXTURES/calls"
"""


class Main(unittest.TestCase):
    """main() over a real workspace, cadgen replaced by a script that answers with fixed JSON."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name).resolve() / "ws"  # as verdict.WORKSPACE is: resolved
        (self.ws / "src").mkdir(parents=True)
        (self.ws / "src" / "part.py").write_text("")
        self.fixtures = Path(self.tmp.name) / "fixtures"
        self.fixtures.mkdir()
        exe = fake_cadgen(Path(self.tmp.name), CADGEN_SCRIPT)
        env = mock.patch.dict(os.environ, {"CADGEN": str(exe), "CADGEN_FIXTURES": str(self.fixtures)})
        env.start()
        self.addCleanup(env.stop)
        ws = mock.patch.object(verdict, "WORKSPACE", self.ws)
        ws.start()
        self.addCleanup(ws.stop)

    def answer(self, valid, facts):
        (self.fixtures / "validate.json").write_text(json.dumps(valid, separators=(",", ":")) + "\n")
        (self.fixtures / "refs.json").write_text(json.dumps(facts, separators=(",", ":")) + "\n")

    def main(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = verdict.main(["verdict.py", *argv])
        return code, out.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def test_the_newest_valid_step_is_ready(self):
        (self.ws / "STEP").mkdir()
        (self.ws / "STEP" / "part.step").write_text("ISO-10303-21;\n")
        self.answer(VALID, FACTS)
        code, out, written = self.main()
        self.assertEqual(code, 0)
        self.assertEqual(out, "ready · part.step · 1 solid · 40 × 30 × 10 mm · valid\n")
        self.assertTrue(written["ready"])
        self.assertEqual(written["artifact"], "STEP/part.step")
        self.assertEqual((self.fixtures / "calls").read_text().splitlines(), [
            "step inspect validate STEP/part.step --format json",
            "step inspect refs --facts STEP/part.step --format json",
        ])

    def test_a_named_step_that_fails_prints_its_findings(self):
        (self.ws / "STEP").mkdir()
        (self.ws / "STEP" / "lid.step").write_text("ISO-10303-21;\n")
        (self.ws / "STEP" / "newer.step").write_text("ISO-10303-21;\n")
        self.answer(OPEN_LID, FACTS)
        code, out, written = self.main(str(self.ws / "STEP" / "lid.step"))
        self.assertEqual(code, 1)
        self.assertEqual(out.splitlines(), ["not ready · lid.step · 1 solid · 40 × 30 × 10 mm · not valid", "  error   lid: openShell, nonPositiveVolume"])
        self.assertEqual(written["artifact"], "STEP/lid.step")

    def test_no_step_writes_a_verdict_without_asking_cadgen(self):
        code, out, written = self.main()
        self.assertEqual(code, 1)
        self.assertEqual(out, "not ready · no STEP yet\n")
        self.assertNotIn("artifact", written)
        self.assertFalse((self.fixtures / "calls").exists())

    def test_run_as_a_script_it_exits_with_mains_code(self):
        self.answer(VALID, FACTS)
        with mock.patch.object(sys, "argv", [str(VERDICT)]), mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": str(self.ws)}), \
                redirect_stdout(io.StringIO()) as out, self.assertRaises(SystemExit) as exit_:
            runpy.run_path(str(VERDICT), run_name="__main__")
        self.assertEqual(exit_.exception.code, 1)
        self.assertEqual(out.getvalue(), "not ready · no STEP yet\n")


if __name__ == "__main__":
    unittest.main()
