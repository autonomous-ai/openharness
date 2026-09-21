import contextlib, importlib.util, io, json, os, runpy, shutil, subprocess, sys, tempfile, time, types, unittest
from fractions import Fraction
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import verdict
from verdict import judge

HERE = Path(__file__).resolve().parent


class Judge(unittest.TestCase):
    def test_a_render_that_plays_is_ready(self):
        v = judge(["scenes/intro.py"], "out/videos/intro/480p15/Intro.mp4", {"duration": 6.2, "frames": 93, "width": 854, "height": 480})
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "Intro.mp4 · 6.2 s · 854×480")
    def test_no_render_yet(self):
        v = judge(["scenes/intro.py"], None, {})
        self.assertFalse(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
        self.assertEqual(v["summary"], "1 scene, no render yet")
        self.assertEqual(judge(["scenes/a.py", "scenes/b.py"], None, {})["summary"], "2 scenes, no render yet")
    def test_no_scene_yet(self):
        v = judge([], None, {})
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertEqual(v["summary"], "no scene yet"); self.assertIsNone(v["artifact"])
    def test_a_still_is_not_a_video(self):
        v = judge(["scenes/a.py"], "out/a.mp4", {"duration": 0.07, "frames": 1})
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][2]["state"], "active"); self.assertEqual(v["findings"][0]["severity"], "warning")
        self.assertEqual(v["findings"][0]["message"], "a.mp4 is 0.1 s; a scene shorter than a second is a still")
    def test_a_render_ffprobe_could_not_read_is_not_ready(self):
        v = judge(["scenes/a.py"], "out/a.mp4", {})
        self.assertFalse(v["ready"]); self.assertEqual(v["summary"], "a.mp4")
        self.assertEqual(v["findings"][0]["message"], "a.mp4 is 0.0 s; a scene shorter than a second is a still")
    def test_frames_unknown_still_plays(self):
        self.assertTrue(judge(["scenes/a.py"], "out/a.webm", {"duration": 3.0})["ready"])

    def test_chapters_are_counted(self):
        v = judge(["scenes/proof.py"], "out/videos/proof/480p15/Proof.mp4", {"duration": 12.0, "frames": 180, "width": 854, "height": 480, "chapters": 4})
        self.assertTrue(v["ready"]); self.assertEqual(v["summary"], "Proof.mp4 · 12.0 s · 854×480 · 4 chapters")
    def test_a_failed_render_after_the_video_is_an_error(self):
        failure = {"type": "NameError", "message": "name 'Sqaure' is not defined", "file": "scenes/proof.py", "line": 42, "scene": "Proof"}
        v = judge(["scenes/proof.py"], "out/videos/proof/480p15/Proof.mp4", {"duration": 12.0, "frames": 180}, failure)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["findings"][0]["severity"], "error"); self.assertEqual(v["findings"][0]["ref"], "scenes/proof.py:42")
        self.assertIn("NameError", v["findings"][0]["message"])
        self.assertEqual(v["phases"][2]["state"], "active")
        self.assertTrue(v["summary"].endswith(" · last render failed"))
    def test_a_failure_with_nothing_known_about_it(self):
        v = judge(["scenes/a.py"], None, {}, {"scene": None})
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "render_failed", "message": "rendering the scene failed — Error: the render failed"}])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "failed", "pending"])
        self.assertEqual(v["summary"], "last render failed · 1 scene, no render yet")
    def test_a_failure_without_a_line_has_no_ref(self):
        v = judge(["scenes/a.py"], None, {}, {"type": "ImportError", "message": "no module", "file": "scenes/a.py", "scene": "A"})
        self.assertNotIn("ref", v["findings"][0])
        self.assertEqual(v["findings"][0]["message"], "rendering A failed — ImportError: no module")


class Newest(unittest.TestCase):
    def test_section_cuts_are_never_the_render(self):
        with tempfile.TemporaryDirectory() as d:
            q = Path(d) / "videos" / "proof" / "480p15"; (q / "sections").mkdir(parents=True)
            (q / "Proof.mp4").write_bytes(b"x"); time.sleep(0.01)
            (q / "sections" / "Proof_0001_Setup.mp4").write_bytes(b"x")
            self.assertEqual(verdict.newest_render(Path(d)).name, "Proof.mp4")

    def test_the_newest_video_or_gif_outside_hidden_and_tool_folders(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.assertIsNone(verdict.newest_render(root))
            for rel in ("a/Old.MP4", "notes.txt", "b/New.gif", ".cache/Hidden.mp4", "node_modules/x/Dep.mp4"):
                (root / rel).parent.mkdir(parents=True, exist_ok=True); (root / rel).write_bytes(b"x")
                os.utime(root / rel, (time.time() + len(rel), time.time() + len(rel)))
            os.utime(root / "b/New.gif", (time.time() + 100, time.time() + 100))
            os.utime(root / "a/Old.MP4", (time.time() - 100, time.time() - 100))
            self.assertEqual(verdict.newest_render(root), root / "b/New.gif")


class Probe(unittest.TestCase):
    def fake(self, stdout: str):
        return mock.patch.object(verdict.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, ""))

    def test_reads_the_first_video_stream(self):
        out = json.dumps({"streams": [{"width": 854, "height": 480, "nb_frames": "93", "duration": "6.2"}], "format": {"duration": "6.3"}})
        with self.fake(out) as run:
            self.assertEqual(verdict.ffprobe(Path("a.mp4")), {"width": 854, "height": 480, "frames": 93, "duration": 6.2})
        self.assertEqual(run.call_args.args[0][0], "ffprobe")

    def test_a_container_without_stream_facts_falls_back_to_the_format(self):
        with self.fake(json.dumps({"streams": [{"width": 64, "height": 48}], "format": {"duration": "2.0"}})):
            self.assertEqual(verdict.ffprobe(Path("a.webm")), {"width": 64, "height": 48, "frames": None, "duration": 2.0})
        with self.fake(""):
            self.assertEqual(verdict.ffprobe(Path("a.mp4")), {"width": None, "height": None, "frames": None, "duration": None})

    def test_no_ffprobe_is_no_facts(self):
        with mock.patch.object(verdict.subprocess, "run", side_effect=FileNotFoundError("ffprobe")):
            self.assertEqual(verdict.ffprobe(Path("a.mp4")), {})

    @unittest.skipIf(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), "ffmpeg/ffprobe not on PATH")
    def test_the_real_ffprobe(self):
        with tempfile.TemporaryDirectory() as d:
            video = Path(d) / "t.mp4"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10", "-t", "2", "-pix_fmt", "yuv420p", str(video)], check=True)
            self.assertEqual(verdict.ffprobe(video), {"width": 64, "height": 48, "frames": 20, "duration": 2.0})


class PyAV(unittest.TestCase):
    """probe() through PyAV, which is in Manim's venv on every machine, ffmpeg binary or not."""

    def av(self, stream=None, container_duration=None, opens=None):
        """A stand-in `av` module whose open() yields one container with `stream` as its video."""
        container = mock.MagicMock()
        container.__enter__.return_value = container
        container.streams.video = [stream]
        container.duration = container_duration
        return mock.patch.dict(sys.modules, {"av": types.SimpleNamespace(open=opens or mock.Mock(return_value=container), time_base=1_000_000)})

    @staticmethod
    def stream(duration, time_base, frames=116):
        return types.SimpleNamespace(duration=duration, time_base=time_base, frames=frames, codec_context=types.SimpleNamespace(width=854, height=480))

    def test_the_streams_own_duration(self):
        with self.av(self.stream(118779, Fraction(1, 15360))):
            self.assertEqual(verdict.probe(Path("Intro.mp4")), {"width": 854, "height": 480, "frames": 116, "duration": 7.733008})

    def test_the_containers_duration_when_the_stream_keeps_none(self):
        with self.av(self.stream(None, Fraction(1, 100), frames=0), container_duration=7_740_000):
            self.assertEqual(verdict.probe(Path("Intro.gif")), {"width": 854, "height": 480, "frames": None, "duration": 7.74})
        with self.av(self.stream(0, None, frames=0)):
            self.assertEqual(verdict.probe(Path("still.gif"))["duration"], None)

    def test_a_file_pyav_cannot_read_is_no_facts(self):
        with self.av(opens=mock.Mock(side_effect=ValueError("Invalid data found when processing input"))):
            self.assertEqual(verdict.probe(Path("scene.py")), {})

    def test_without_pyav_ffprobe_is_asked(self):
        with mock.patch.dict(sys.modules, {"av": None}), mock.patch.object(verdict, "ffprobe", return_value={"duration": 2.0}) as ffprobe:
            self.assertEqual(verdict.probe(Path("a.mp4")), {"duration": 2.0})
        ffprobe.assert_called_once_with(Path("a.mp4"))

    @unittest.skipUnless(importlib.util.find_spec("av"), "PyAV is not importable here; run with the harness venv's python")
    def test_the_real_pyav(self):
        import av
        with tempfile.TemporaryDirectory() as d:
            video = Path(d) / "t.mp4"
            with av.open(str(video), "w") as out:
                stream = out.add_stream("libx264", rate=10)
                stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
                for i in range(20):
                    frame = av.VideoFrame(64, 48, "yuv420p")
                    for plane in frame.planes:
                        plane.update(bytes([i * 10]) * plane.buffer_size)
                    out.mux(stream.encode(frame))
                out.mux(stream.encode())
            self.assertEqual(verdict.probe(video), {"width": 64, "height": 48, "frames": 20, "duration": 2.0})


class Chapters(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.video = Path(tmp.name) / "Proof.mp4"; self.video.write_bytes(b"x")
        self.index = Path(tmp.name) / "sections" / "Proof.json"; self.index.parent.mkdir()

    def test_sections_saved_with_the_render(self):
        self.assertIsNone(verdict.chapters(self.video), "no index")
        self.index.write_text(json.dumps([{"name": "a"}, {"name": "b"}, {"name": "c"}]))
        self.assertEqual(verdict.chapters(self.video), 3)
        self.index.write_text(json.dumps([{"name": "only"}]))
        self.assertIsNone(verdict.chapters(self.video), "one section is no chapters")

    def test_an_index_from_an_older_render_or_unreadable_is_none(self):
        self.index.write_text(json.dumps([1, 2]))
        os.utime(self.index, (time.time() - 60, time.time() - 60))
        self.assertIsNone(verdict.chapters(self.video))
        for body in ("{not json", "7"):
            self.index.write_text(body)
            self.assertIsNone(verdict.chapters(self.video), body)


class LastFailure(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.ws = Path(tmp.name)
        (self.ws / ".harness").mkdir()
        patcher = mock.patch.object(verdict, "WS", self.ws); patcher.start(); self.addCleanup(patcher.stop)
        self.video = self.ws / "Intro.mp4"; self.video.write_bytes(b"x")

    def status(self, body) -> None:
        (self.ws / ".harness" / "render.json").write_text(body if isinstance(body, str) else json.dumps(body))

    def test_nothing_to_report(self):
        self.assertIsNone(verdict.last_failure(None), "no render.json")
        for body in ("{broken", [], {"state": "done"}, {"state": "cancelled"}):
            self.status(body)
            self.assertIsNone(verdict.last_failure(self.video), body)

    def test_a_failure_after_the_render_is_reported(self):
        now_ms = (self.video.stat().st_mtime + 5) * 1000
        self.status({"state": "failed", "scene": "Intro", "finishedAtMs": now_ms, "error": {"type": "NameError", "line": 3}})
        self.assertEqual(verdict.last_failure(self.video), {"type": "NameError", "line": 3, "scene": "Intro"})
        self.assertEqual(verdict.last_failure(None)["scene"], "Intro")
        self.assertEqual(verdict.last_failure(self.ws / "gone.mp4")["scene"], "Intro")

    def test_a_render_newer_than_the_failure_clears_it(self):
        self.status({"state": "failed", "updatedAtMs": (self.video.stat().st_mtime - 5) * 1000, "error": None})
        self.assertIsNone(verdict.last_failure(self.video))
        self.status({"state": "failed"})
        self.assertIsNone(verdict.last_failure(self.video), "no time at all is older than any render")
        self.assertEqual(verdict.last_failure(None), {"scene": None})


class Main(unittest.TestCase):
    """verdict.py on a workspace: what it reads, what it writes, what it prints and returns."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.ws = Path(tmp.name)
        for patcher in (mock.patch.object(verdict, "WS", self.ws),
                        mock.patch.object(verdict, "probe", side_effect=lambda p: {"duration": 4.0, "frames": 60, "width": 854, "height": 480})):
            patcher.start(); self.addCleanup(patcher.stop)

    def main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = verdict.main(["verdict.py", *argv])
        return code, out.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def put(self, rel: str, body: bytes = b"x") -> Path:
        path = self.ws / rel; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(body)
        return path

    def test_an_empty_workspace(self):
        code, printed, v = self.main()
        self.assertEqual((code, printed), (1, "not ready · no scene yet\n"))

    def test_the_newest_render_under_out_with_its_chapters(self):
        self.put("scenes/intro.py")
        self.put("media/videos/intro/480p15/Stray.mp4")
        video = self.put("out/videos/intro/480p15/Intro.mp4")
        self.put("out/videos/intro/480p15/sections/Intro.json", json.dumps([1, 2]).encode())
        code, printed, v = self.main()
        self.assertEqual(code, 0)
        self.assertEqual(v["artifact"], "out/videos/intro/480p15/Intro.mp4")
        self.assertEqual(v["summary"], "Intro.mp4 · 4.0 s · 854×480 · 2 chapters")
        verdict.probe.assert_called_once_with(video)
        self.assertEqual(printed, "ready · Intro.mp4 · 4.0 s · 854×480 · 2 chapters\n")

    def test_without_out_the_whole_workspace_is_searched_and_a_named_render_wins(self):
        self.put("scenes/intro.py")
        self.put("media/A.mp4")
        self.assertEqual(self.main()[2]["artifact"], "media/A.mp4")
        self.put("media/B.gif")
        self.assertEqual(self.main("media/A.mp4")[2]["artifact"], "media/A.mp4")
        self.assertEqual(self.main(str(self.ws / "media/B.gif"))[2]["artifact"], "media/B.gif")

    def test_a_named_render_that_does_not_exist_and_a_failure_print_their_findings(self):
        self.put("scenes/intro.py")
        (self.ws / ".harness").mkdir()
        (self.ws / ".harness" / "render.json").write_text(json.dumps({"state": "failed", "scene": "Intro", "finishedAtMs": time.time() * 1000, "error": {"type": "NameError", "message": "x"}}))
        code, printed, v = self.main("out/missing.mp4")
        self.assertEqual(code, 1)
        self.assertIsNone(v["artifact"])
        verdict.probe.assert_not_called()
        self.assertEqual(printed.splitlines()[1], "  error   rendering Intro failed — NameError: x")

    def test_run_as_a_script(self):
        self.put("scenes/intro.py")
        with mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": str(self.ws)}), mock.patch.object(sys, "argv", ["verdict.py"]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
        self.assertEqual(exit_.exception.code, 1)
        self.assertEqual(json.loads((self.ws / ".harness" / "verdict.json").read_text())["summary"], "1 scene, no render yet")


if __name__ == "__main__": unittest.main()
