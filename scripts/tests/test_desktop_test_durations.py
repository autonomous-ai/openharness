import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "desktop-test-durations.py"
spec = importlib.util.spec_from_file_location("desktop_test_durations", SCRIPT)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def shard_artifact(folder, desktop, timings):
    """One shard's artifact as CI uploads it: a receipt naming its checkout and the JSON reporter log, where each file's
    tests start and end at the times given (milliseconds since the run started)."""
    run = folder / "20261105T000000Z-desktop-1"
    run.mkdir(parents=True)
    (run / "receipt.json").write_text(json.dumps({"schema": 1, "kind": "desktop-vm", "desktop_root": desktop}))
    events, test_id = [], 100
    for suite_id, (name, start, end) in enumerate(timings):
        events.append({"type": "suite", "suite": {"id": suite_id, "platform": "vm", "path": f"{desktop}/test/{name}"}, "time": start})
        for at, kind in ((start, "testStart"), (end, "testDone")):
            if kind == "testStart":
                events.append({"type": kind, "test": {"id": test_id, "suiteID": suite_id, "name": "case"}, "time": at})
            else:
                events.append({"type": kind, "testID": test_id, "result": "success", "hidden": False, "skipped": False, "time": at})
        test_id += 1
    events.append({"type": "done", "success": True, "time": 99_000})
    (run / "desktop-vm.log").write_text("Flutter build output\n" + "\n".join(json.dumps(e) for e in events) + "\n")


class DurationRefreshTests(unittest.TestCase):
    """Task #3458: the shard split reads measured file times; this keeps them current from CI runs."""

    def test_measures_each_file_from_its_first_test_start_to_its_last_test_end(self):
        with tempfile.TemporaryDirectory() as folder:
            shard_artifact(Path(folder) / "s1", "/runner/work/repo/desktop", [("a_test.dart", 1_000, 11_000), ("b_test.dart", 2_000, 4_500)])
            self.assertEqual(tool.run_durations(Path(folder)), {"test/a_test.dart": 10.0, "test/b_test.dart": 2.5})

    def test_takes_each_files_median_over_runs_and_records_them(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for run, seconds in (("1", 10), ("2", 40), ("3", 20)):
                shard_artifact(root / run / "s1", "/w/desktop", [("a_test.dart", 0, seconds * 1000)])
            shard_artifact(root / "3" / "s2", "/w/desktop", [("new_test.dart", 0, 3_000)])
            document = tool.durations_document({run: tool.run_durations(root / run) for run in ("1", "2", "3")})
            self.assertEqual(document["files"], {"test/a_test.dart": 20.0, "test/new_test.dart": 3.0})
            self.assertEqual(document["sourceRuns"], [f"https://github.com/autonomous-ai/openharness/actions/runs/{run}" for run in ("1", "2", "3")])
            self.assertEqual(document["schema"], 1)

    def test_a_run_with_no_shard_logs_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                tool.run_durations(Path(folder))


if __name__ == "__main__":
    unittest.main()
