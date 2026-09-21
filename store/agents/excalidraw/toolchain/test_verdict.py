"""verdict.py: every finding it can make, and main() on a real workspace: python3 -m unittest toolchain/test_verdict.py"""
import contextlib, io, json, os, runpy, sys, tempfile, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import verdict
from verdict import judge

HERE = Path(__file__).resolve().parent


def scene(*elements) -> dict:
    return {"type": "excalidraw", "version": 2, "elements": list(elements)}


BOX = {"id": "box", "type": "rectangle"}
LABEL = {"id": "label", "type": "text", "text": "API", "containerId": "box"}


class Findings(unittest.TestCase):
    def kinds(self, v):
        return [(f["severity"], f["kind"]) for f in v["findings"]]

    def test_an_element_without_an_id_or_with_an_unknown_type(self):
        v = judge(scene(BOX, {"type": "rectangle"}, {"id": "s", "type": "star"}), "d.excalidraw")
        self.assertEqual(self.kinds(v), [("error", "schema"), ("error", "schema")])
        self.assertEqual(v["findings"][1]["message"], "element 's' has no id or an unknown type 'star'")
        self.assertEqual(v["summary"], "d.excalidraw · 2 shapes · 0 arrows · 2 errors")
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "failed", "pending"])

    def test_json_that_is_not_a_string_where_an_id_or_type_belongs_is_a_finding_not_a_crash(self):
        # A hand edit can leave a list or an object there; the verdict used to raise TypeError
        # (unhashable) and write nothing.
        v = judge(scene({"id": ["a"], "type": "rectangle"}, {"id": "b", "type": {"shape": "box"}},
                        {"id": "c", "type": "arrow", "startBinding": {"elementId": ["a"]}, "endBinding": {"elementId": "b"}},
                        {"id": "t", "type": "text", "text": "x", "containerId": {"id": "b"}}), "d.excalidraw")
        self.assertFalse(v["ready"])
        self.assertEqual(self.kinds(v), [("error", "schema"), ("error", "schema"), ("error", "binding"), ("error", "binding")])

    def test_a_label_whose_container_is_gone(self):
        v = judge(scene(LABEL), "d.excalidraw")
        self.assertEqual(v["findings"][0]["message"], "text label belongs to a missing container box")

    def test_review_warnings_leave_it_ready_with_review_open(self):
        loose = {"id": "a", "type": "arrow", "startBinding": {"elementId": "box"}, "endBinding": None}
        v = judge(scene(BOX, LABEL, loose, {"id": "e", "type": "text", "text": "  "}), "d.excalidraw")
        self.assertTrue(v["ready"])
        self.assertEqual(self.kinds(v), [("warning", "review"), ("warning", "review")])
        self.assertEqual([f["message"] for f in v["findings"]], ["arrow a is not attached at both ends", "text e is empty"])
        self.assertEqual(v["phases"][2]["state"], "active")
        self.assertEqual(v["summary"], "d.excalidraw · 1 shape · 1 arrow · valid")

    def test_deleted_elements_do_not_count_and_cannot_be_bound_to(self):
        v = judge(scene({**BOX, "isDeleted": True}, LABEL, "not an element"), "d.excalidraw")
        self.assertEqual(self.kinds(v), [("error", "binding")])
        self.assertEqual(v["summary"], "d.excalidraw · 0 shapes · 0 arrows · 1 error")

    def test_an_empty_scene_is_not_ready(self):
        v = judge(scene(), "d.excalidraw")
        self.assertFalse(v["ready"])
        self.assertEqual((v["summary"], v["artifact"]), ("d.excalidraw · empty", "d.excalidraw"))
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])


class Main(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws = Path(tmp.name)
        patcher = mock.patch.object(verdict, "WS", self.ws)
        patcher.start()
        self.addCleanup(patcher.stop)

    def main(self, *argv):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = verdict.main(["verdict.py", *argv])
        return code, out.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def test_the_default_diagram(self):
        (self.ws / "diagram.excalidraw").write_text(json.dumps(scene(BOX, LABEL)))
        code, printed, v = self.main()
        self.assertEqual((code, printed), (0, "ready · diagram.excalidraw · 1 shape · 0 arrows · valid\n"))
        self.assertEqual(v["artifact"], "diagram.excalidraw")

    def test_a_named_diagram_relative_or_absolute_prints_its_findings(self):
        (self.ws / "flows").mkdir()
        (self.ws / "flows" / "x.excalidraw").write_text(json.dumps(scene({"id": "s", "type": "star"})))
        for arg in ("flows/x.excalidraw", str(self.ws / "flows" / "x.excalidraw")):
            code, printed, v = self.main(arg)
            self.assertEqual(code, 1)
            self.assertEqual(v["artifact"], "flows/x.excalidraw")
            self.assertEqual(printed.splitlines()[1], "  error   element 's' has no id or an unknown type 'star'")

    def test_a_missing_or_unparseable_file_is_unreadable(self):
        code, printed, v = self.main()
        self.assertEqual(code, 1)
        self.assertEqual(v["summary"], "diagram.excalidraw · unreadable")
        self.assertEqual(v["findings"][0]["kind"], "file")
        self.assertIsNone(v["artifact"])
        (self.ws / "diagram.excalidraw").write_text("{ not json")
        code, printed, v = self.main()
        self.assertEqual((code, v["summary"]), (1, "diagram.excalidraw · unreadable"))
        self.assertTrue(v["findings"][0]["message"].startswith("diagram.excalidraw: Expecting property name"), v["findings"])

    def test_run_as_a_script(self):
        (self.ws / "diagram.excalidraw").write_text(json.dumps(scene(BOX)))
        with mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": str(self.ws)}), mock.patch.object(sys, "argv", ["verdict.py"]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
        self.assertEqual(exit_.exception.code, 0)
        self.assertTrue(json.loads((self.ws / ".harness" / "verdict.json").read_text())["ready"])


if __name__ == "__main__":
    unittest.main()
