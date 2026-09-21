import contextlib, io, json, os, runpy, sys, tempfile, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import verdict
from verdict import judge

HERE = Path(__file__).resolve().parent
STABLE = {"video": "out/rollout.mp4", "seconds": 4.0, "model": {"nbody": 18, "nu": 12}, "nan": False, "max_qvel": 12.0,
          "model_path": "menagerie/unitree_go2/scene.xml", "trajectory": "out/rollout.qpos.json"}
DONE = {"status": "done", "model": "menagerie/unitree_go2/scene.xml", "nu": 12, "qpos": [[0]], "ctrl": [[0] * 12]}


class Judge(unittest.TestCase):
    def test_a_recorded_rollout_is_ready_and_the_pane_opens_the_trajectory(self):
        v = judge(True, STABLE, True, "out/rollout.qpos.json")
        self.assertTrue(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual([p["id"] for p in v["phases"]], ["model", "simulate", "record"])
        self.assertEqual(v["artifact"], "out/rollout.qpos.json")
        self.assertEqual(v["findings"], [])

    def test_the_header_names_the_robot_not_the_video(self):
        v = judge(True, STABLE, True, "out/rollout.qpos.json")
        self.assertEqual(v["summary"], "unitree_go2 · 4.0 s · 18 bodies · 12 actuators · stable")
        self.assertNotIn("mp4", v["summary"])
        own = judge(True, {**STABLE, "model_path": "scenes/arm.xml"}, True, "out/rollout.qpos.json")
        self.assertTrue(own["summary"].startswith("arm.xml · "))
        nameless = judge(True, {"seconds": 1, "nan": False}, False, "out/rollout.qpos.json")
        self.assertEqual(nameless["summary"], "1.0 s · ? bodies · ? actuators · stable")

    def test_the_video_is_never_the_artifact(self):
        without_trajectory = judge(True, STABLE, True, None)
        self.assertEqual(without_trajectory["artifact"], "out/rollout.json", "the report still names the model")
        self.assertFalse(without_trajectory["ready"], "the pane cannot run it, so it is not done")
        self.assertEqual([f["kind"] for f in without_trajectory["findings"]], ["replay"])
        self.assertEqual(without_trajectory["findings"][0]["severity"], "warning")
        for v in (without_trajectory, judge(True, STABLE, True, "out/rollout.qpos.json"), judge(True, None, True)):
            self.assertFalse(str(v["artifact"]).endswith(".mp4"))

    def test_a_rollout_needs_no_video(self):
        v = judge(True, {**STABLE, "video": None}, False, "out/rollout.qpos.json")
        self.assertTrue(v["ready"])

    def test_an_old_trajectory_without_controls_replays_but_says_so(self):
        v = judge(True, STABLE, True, "out/rollout.qpos.json", ctrl_recorded=False)
        self.assertTrue(v["ready"])
        self.assertEqual([(f["severity"], f["kind"]) for f in v["findings"]], [("info", "replay")])

    def test_recording_moves_the_header_while_the_rollout_runs(self):
        v = judge(True, None, False, None, recording={"frames": 61, "dt": 0.034, "seconds": 5.0, "model": "menagerie/unitree_go2/scene.xml"})
        self.assertFalse(v["ready"])
        self.assertEqual(v["artifact"], "out/rollout.qpos.json")
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
        self.assertEqual(v["summary"], "recording unitree_go2 · 2.0 / 5.0 s")
        self.assertEqual(v["findings"], [])
        anonymous = judge(True, None, False, None, recording={"qpos": []})
        self.assertEqual(anonymous["summary"], "recording rollout · 0.0 / 0.0 s")

    def test_a_rollout_the_script_stopped_mid_way_failed(self):
        v = judge(True, STABLE, True, None, recording={"frames": 11, "dt": 0.05, "seconds": 4.0, "model": "scenes/arm.xml", "error": "RuntimeError: boom"})
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "failed", "pending"])
        self.assertEqual(v["summary"], "stopped arm.xml · 0.5 / 4.0 s")
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "simulate", "message": "the rollout stopped at 0.5 s: RuntimeError: boom"}])
        self.assertEqual(v["artifact"], "out/rollout.qpos.json", "what was recorded still replays")

    def test_divergence_fails_simulate(self):
        v = judge(True, {"video": "out/rollout.mp4", "seconds": 1.0, "model": {}, "nan": True}, True)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed"); self.assertEqual(v["findings"][0]["severity"], "error")
        self.assertTrue(v["summary"].endswith("diverged"))

    def test_exploding_velocities_are_a_warning(self):
        v = judge(True, {**STABLE, "max_qvel": 950.4}, True, "out/rollout.qpos.json")
        self.assertTrue(v["ready"])
        self.assertEqual(v["findings"], [{"severity": "warning", "kind": "simulate", "message": "joint velocities reached 950 rad/s — the rollout is probably exploding"}])

    def test_nothing_yet(self):
        v = judge(False, None, False)
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertIsNone(v["artifact"])
        self.assertEqual(v["summary"], "no simulation yet")
        self.assertEqual(judge(True, None, False)["summary"], "no rollout yet")

    def test_a_report_without_a_model_on_disk(self):
        v = judge(False, STABLE, False, "out/rollout.qpos.json")
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"], "a report is proof enough of a model")


class ModelName(unittest.TestCase):
    def test_names(self):
        self.assertEqual(verdict.model_name("menagerie/unitree_go2/scene.xml"), "unitree_go2")
        self.assertEqual(verdict.model_name("menagerie/scene.xml"), "scene.xml")
        self.assertEqual(verdict.model_name("scenes/arm.xml"), "arm.xml")
        self.assertIsNone(verdict.model_name(None))
        self.assertIsNone(verdict.model_name(""))


class Main(unittest.TestCase):
    """verdict.py on a workspace: what it reads, what it writes, what it prints and returns."""

    def run_main(self, files: dict) -> tuple[int, str, dict]:
        with tempfile.TemporaryDirectory() as ws:
            for rel, body in files.items():
                path = Path(ws) / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                if isinstance(body, bytes):
                    path.write_bytes(body)
                else:
                    path.write_text(body if isinstance(body, str) else json.dumps(body))
            printed = io.StringIO()
            with mock.patch.object(verdict, "WS", Path(ws)), contextlib.redirect_stdout(printed):
                code = verdict.main([])
            self.assertFalse((Path(ws) / ".harness" / "verdict.json.tmp").exists(), "written atomically")
            return code, printed.getvalue(), json.loads((Path(ws) / ".harness" / "verdict.json").read_text())

    def run_in(self, files: dict) -> dict:
        return self.run_main(files)[2]

    def test_a_trajectory_mid_write_is_a_recording(self):
        v = self.run_in({"sim/hello.py": "", "out/rollout.qpos.json": {"status": "recording", "model": "menagerie/unitree_go2/scene.xml", "dt": 0.034, "seconds": 4, "qpos": [[0]] * 30}})
        self.assertEqual(v["phases"][1]["state"], "active")
        self.assertTrue(v["summary"].startswith("recording unitree_go2"))

    def test_a_trajectory_the_script_stopped_is_failed(self):
        body = {"status": "failed", "error": "KeyboardInterrupt", "model": "scenes/arm.xml", "dt": 0.1, "seconds": 4, "qpos": [[0]] * 6}
        code, printed, v = self.run_main({"scenes/arm.xml": "<mujoco/>", "out/rollout.json": STABLE, "out/rollout.qpos.json": body})
        self.assertEqual(code, 1)
        self.assertFalse(v["ready"], "the report of the run before is not this run's")
        self.assertEqual(v["summary"], "stopped arm.xml · 0.5 / 4.0 s")
        self.assertEqual(printed.splitlines(), ["not ready · stopped arm.xml · 0.5 / 4.0 s", "  error   the rollout stopped at 0.5 s: KeyboardInterrupt"])
        v = self.run_in({"out/rollout.qpos.json": {**body, "error": None}})
        self.assertIn("the script stopped", v["findings"][0]["message"])

    def test_a_finished_rollout(self):
        code, printed, v = self.run_main({"sim/hello.py": "", "out/rollout.json": STABLE, "out/rollout.qpos.json": DONE,
                                          "out/rollout.mp4": b"\0" * 2000})
        self.assertEqual(code, 0)
        self.assertTrue(v["ready"])
        self.assertEqual(v["artifact"], "out/rollout.qpos.json")
        self.assertEqual(printed.splitlines(), ["ready · unitree_go2 · 4.0 s · 18 bodies · 12 actuators · stable"])

    def test_the_video_is_optional_whatever_state_it_is_in(self):
        for files in ({"out/rollout.mp4": b"\0" * 10}, {}, {"out/rollout.json": {**STABLE, "video": None}}):
            with self.subTest(files=list(files)):
                v = self.run_in({"scenes/arm.xml": "<mujoco/>", "out/rollout.json": STABLE, "out/rollout.qpos.json": DONE, **files})
                self.assertTrue(v["ready"])

    def test_controls_decide_whether_the_pane_can_resimulate(self):
        old = {"status": "done", "model": "scenes/arm.xml", "qpos": [[0], [0]]}
        v = self.run_in({"out/rollout.json": STABLE, "out/rollout.qpos.json": old})
        self.assertEqual([f["kind"] for f in v["findings"]], ["replay"], "a trajectory written before controls were recorded")
        passive = {"status": "done", "model": "scenes/ball.xml", "nu": 0, "qpos": [[0], [0]], "ctrl": [[], []]}
        v = self.run_in({"out/rollout.json": STABLE, "out/rollout.qpos.json": passive})
        self.assertEqual(v["findings"], [], "a model with no actuators has nothing to record")
        v = self.run_in({"out/rollout.json": STABLE, "out/rollout.qpos.json": {**passive, "ctrl": []}})
        self.assertEqual(v["findings"], [], "nor does an empty ctrl column matter when nu is 0")

    def test_files_that_are_not_what_they_should_be_are_ignored(self):
        code, printed, v = self.run_main({"scenes/arm.xml": "<mujoco/>", "out/rollout.json": "[1, 2]", "out/rollout.qpos.json": '{"status": "done", "qpos": 3}'})
        self.assertEqual(code, 1)
        self.assertEqual(v["summary"], "no rollout yet")
        self.assertIsNone(v["artifact"])
        self.assertEqual(printed, "not ready · no rollout yet\n")
        v = self.run_in({"out/rollout.json": "{not json", "out/rollout.qpos.json": "[]"})
        self.assertEqual(v["summary"], "no simulation yet")
        # Before: a report that parsed to a list crashed the verdict (list has no .get) and wrote nothing.
        v = self.run_in({"out/rollout.json": [STABLE]})
        self.assertEqual(v["summary"], "no simulation yet")

    def test_warnings_are_printed(self):
        _, printed, _ = self.run_main({"out/rollout.json": STABLE})
        self.assertEqual(printed.splitlines()[1][:10], "  warning ")

    def test_run_as_a_script(self):
        with tempfile.TemporaryDirectory() as ws:
            (Path(ws) / "sim").mkdir()
            (Path(ws) / "sim" / "hello.py").write_text("")
            with mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": ws}), mock.patch.object(sys, "argv", ["verdict.py"]), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as exit_:
                    runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
            self.assertEqual(exit_.exception.code, 1)
            self.assertEqual(json.loads((Path(ws) / ".harness" / "verdict.json").read_text())["summary"], "no rollout yet")


if __name__ == "__main__": unittest.main()
