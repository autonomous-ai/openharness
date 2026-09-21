"""render.py: the argument handling, the progress feed and its hooks on stand-in Manim objects (any
Python), and one real render, a failing scene and a syntax error on the pinned Manim (its venv):

    python3 -m unittest toolchain/test_render.py                     # the real renders skip
    "$MANIM_PYTHON" -m unittest toolchain/test_render.py
"""
import contextlib, importlib.util, io, json, os, runpy, shutil, subprocess, sys, tempfile, types, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import render
from render import with_manim_args, guess_target, describe

HERE = Path(__file__).resolve().parent
HAS_MANIM = importlib.util.find_spec("manim") is not None


@contextlib.contextmanager
def modules(names: dict):
    """Stand-ins for Manim's modules in sys.modules, put back as they were afterwards."""
    saved = {name: sys.modules.get(name) for name in names}
    sys.modules.update(names)
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def fake_manim(fmt=None, input_file="scenes/proof.py"):
    module = types.ModuleType("manim")
    module.__version__ = "0.0.test"
    module.config = types.SimpleNamespace(format=fmt, input_file=input_file)
    return modules({"manim": module})


class Workspace(unittest.TestCase):
    """A scratch workspace as render.WS, with STATUS inside it."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws = Path(tmp.name).resolve()
        for name, value in (("WS", self.ws), ("STATUS", self.ws / ".harness" / "render.json")):
            patcher = mock.patch.object(render, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        cwd = os.getcwd()
        os.chdir(self.ws)  # Manim's paths are relative to the cwd, which is the workspace
        self.addCleanup(os.chdir, cwd)

    def status_file(self) -> dict:
        return json.loads((self.ws / ".harness" / "render.json").read_text())


class Args(unittest.TestCase):
    def test_the_pane_flags_are_added(self):
        self.assertEqual(with_manim_args(["scenes/a.py", "A"]), ["render", "--save_sections", "--media_dir", "out", "-ql", "scenes/a.py", "A"])
    def test_the_agents_own_flags_win(self):
        args = with_manim_args(["render", "-qh", "--media_dir", "media", "--save_sections", "scenes/a.py", "A"])
        self.assertEqual(args, ["render", "-qh", "--media_dir", "media", "--save_sections", "scenes/a.py", "A"])
        self.assertEqual(with_manim_args(["-r", "1920,1080", "scenes/a.py"]), ["render", "--save_sections", "--media_dir", "out", "-r", "1920,1080", "scenes/a.py"])
    def test_a_failure_before_the_scene_still_names_its_video(self):
        t = guess_target(with_manim_args(["-qh", "scenes/proof.py", "Proof"]))
        self.assertEqual(t["output"], "out/videos/proof/1080p60/Proof.mp4"); self.assertEqual(t["scene"], "Proof")

    def test_every_spelling_of_quality_and_media_dir_is_understood(self):
        # Before: only `-qh` was read, so `-q h` or `--quality=h` guessed 480p15, and a trailing
        # `--media_dir` with no value raised IndexError inside the failure path.
        for flags in (["-q", "h"], ["--quality", "h"], ["--quality=H"], ["-qh"]):
            with self.subTest(flags=flags):
                self.assertEqual(guess_target(with_manim_args([*flags, "scenes/proof.py", "Proof"]))["output"], "out/videos/proof/1080p60/Proof.mp4")
        self.assertEqual(guess_target(["--media_dir=renders", "-qk", "scenes/a.py", "A"])["output"], "renders/videos/a/2160p60/A.mp4")
        self.assertEqual(guess_target(["-qz", "scenes/a.py", "A", "--media_dir"])["output"], "media/videos/a/480p15/A.mp4")

    def test_what_a_command_without_a_scene_or_a_source_means(self):
        self.assertEqual(guess_target(["render", "-ql"]), {})
        t = guess_target(["scenes/a.py", "-ql"])
        self.assertEqual((t["scene"], "output" in t), (None, False))
        self.assertEqual(guess_target(["/Users/example/elsewhere/b.py", "B"])["source"], render.rel("/Users/example/elsewhere/b.py"))


class Paths(Workspace):
    def test_rel_is_workspace_relative_and_never_raises(self):
        self.assertIsNone(render.rel(None))
        self.assertEqual(render.rel(self.ws / "out" / "a.mp4"), "out/a.mp4")
        self.assertEqual(render.rel("bad\0name"), "bad\0name")
        self.assertEqual(render.sidecar_path("out/a.mp4"), self.ws / ".harness" / "renders" / "out/a.mp4.json")

    def test_write_json_is_atomic_and_best_effort(self):
        target = self.ws / "deep" / "state.json"
        render.write_json(target, {"é": 1})
        self.assertEqual(target.read_text(), '{\n "é": 1\n}\n')
        self.assertEqual([p.name for p in target.parent.iterdir()], ["state.json"])
        (self.ws / "file").write_text("x")
        render.write_json(self.ws / "file" / "state.json", {})  # a file where a folder should be: no raise


class Errors(Workspace):
    def put(self, rel: str, source: str) -> dict:
        path = self.ws / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        namespace: dict = {}
        exec(compile(source, str(path), "exec"), namespace)
        return namespace

    def test_without_an_exception(self):
        self.assertEqual(render.error_from(None, None), {"type": "Error", "message": "manim exited with an error"})

    def test_the_message_is_its_first_line_or_the_type(self):
        self.assertEqual(render.error_from(ValueError("first\nsecond"), None), {"type": "ValueError", "message": "first"})
        self.assertEqual(render.error_from(KeyError(), None), {"type": "KeyError", "message": "KeyError"})

    def test_a_syntax_error_names_the_file_line_and_code(self):
        path = self.ws / "scenes" / "bad.py"
        try:
            compile("from manim import *\nclass Bad(Scene:\n", str(path), "exec")
        except SyntaxError as exc:
            error = render.error_from(exc, exc.__traceback__)
        self.assertEqual((error["type"], error["file"], error["line"], error["code"]), ("SyntaxError", "scenes/bad.py", 2, "class Bad(Scene:"))
        self.assertNotIn("file", render.error_from(SyntaxError("no file"), None))

    def test_the_deepest_frame_in_the_workspace_not_in_a_venv_or_site_packages(self):
        dep = self.put(".venv/lib/dep.py", "def boom():\n    raise RuntimeError('deep')\n")
        site = self.put("lib/site-packages/pkg.py", "def call():\n    boom()\n")
        site["boom"] = dep["boom"]
        scene = self.put("scenes/proof.py", "def construct():\n    call()\n")
        scene["call"] = site["call"]
        try:
            scene["construct"]()
        except RuntimeError as exc:
            error = render.error_from(exc, exc.__traceback__)
        self.assertEqual(error, {"type": "RuntimeError", "message": "deep", "file": "scenes/proof.py", "line": 2, "code": "call()", "function": "construct"})

    def test_no_workspace_frame_and_an_unresolvable_one_are_skipped(self):
        scene = self.put("scenes/unreadable.py", "def construct():\n    raise ValueError('x')\n")
        real_resolve = Path.resolve

        def resolve(path, *args, **kwargs):
            if path.name == "unreadable.py":
                raise OSError("gone")
            return real_resolve(path, *args, **kwargs)

        try:
            scene["construct"]()
        except ValueError as exc:
            with mock.patch.object(Path, "resolve", resolve):
                error = render.error_from(exc, exc.__traceback__)
        self.assertEqual(error, {"type": "ValueError", "message": "x"})

    def test_a_tex_program_this_machine_lacks_says_what_to_do(self):
        scene = self.put("scenes/formula.py", "def construct():\n    raise FileNotFoundError(2, 'No such file or directory', 'latex')\n")
        try:
            scene["construct"]()
        except FileNotFoundError as exc:
            error = render.error_from(exc, exc.__traceback__)
        self.assertEqual(error, {"type": "FileNotFoundError", "message": "Tex/MathTex need LaTeX and `latex` is not on this machine — write the formula with Text(…) instead",
                                 "file": "scenes/formula.py", "line": 2, "code": "raise FileNotFoundError(2, 'No such file or directory', 'latex')", "function": "construct"})
        self.assertEqual(render.missing_tex(FileNotFoundError(2, "No such file or directory", "/Library/TeX/texbin/dvisvgm")), "dvisvgm")

    def test_any_other_missing_file_is_itself(self):
        for exc in (FileNotFoundError(2, "No such file or directory", "assets/logo.png"), FileNotFoundError("no filename"), PermissionError(13, "Permission denied", "latex")):
            with self.subTest(exc=exc):
                self.assertIsNone(render.missing_tex(exc))
                self.assertNotIn("LaTeX", render.error_from(exc, None)["message"])
        self.assertIsNone(render.missing_tex(None))


class Labels(unittest.TestCase):
    def test_labels_are_short(self):
        class Text:  # stand-ins: describe() reads class names and text only
            original_text = "The Pythagorean   Theorem, stated for every right triangle"
        class Square: pass
        class FadeIn:
            mobject = Text()
        class _MethodAnimation:
            mobject = Square()
        class Wait:
            mobject = None
        class Write:
            mobject = None
        self.assertEqual(describe(FadeIn()), "FadeIn(Text “The Pythagorean Theorem, stated…”)")
        self.assertEqual(describe(_MethodAnimation()), "animate(Square)")
        self.assertEqual(describe(Wait()), "Wait")
        self.assertEqual(describe(Write()), "Write")

    def test_any_text_the_mobject_carries(self):
        class MathTex:
            tex_string = r"a^2 + b^2 = c^2"
        class Paragraph:
            text = "   "
        class Create:
            def __init__(self, mobject): self.mobject = mobject
        self.assertEqual(describe(Create(MathTex())), "Create(MathTex “a^2 + b^2 = c^2”)")
        self.assertEqual(describe(Create(Paragraph())), "Create(Paragraph)")


class Section:
    def __init__(self, name, files=(), skip=False):
        self.name, self.partial_movie_files, self.skip_animations = name, list(files), skip


class Writer:
    def __init__(self, **paths):
        self.partial_movie_files, self.sections = [], []
        for key, value in paths.items():
            setattr(self, key, value)


class Proof:
    def __init__(self, writer):
        self.renderer = types.SimpleNamespace(file_writer=writer)


class Feed(Workspace):
    """Status on stand-in scenes and file writers: begin, sync, finish, fail, write."""

    def video(self) -> Path:
        return self.ws / "out" / "videos" / "proof" / "480p15" / "Proof.mp4"

    def test_a_render_from_begin_to_finish(self):
        video = self.video()
        clips = video.parent / "partial_movie_files" / "Proof"
        clips.mkdir(parents=True)
        (clips / "c1.mp4").write_bytes(b"12345")
        sidecar = self.ws / ".harness" / "renders" / "out/videos/proof/480p15/Proof.mp4.json"
        sidecar.parent.mkdir(parents=True)
        sidecar.write_text(json.dumps({"renderedAtMs": 1, "duration": 2.5, "clips": [{"name": "old.mp4", "size": 9}], "animations": [{}, {}]}))

        writer = Writer(movie_file_path=str(video), partial_movie_directory=str(clips))
        status = render.Status(["render", "-ql", "scenes/proof.py", "Proof"])
        status.sync(writer, "ignored before begin")
        self.assertEqual(status.data, {})
        with fake_manim():
            status.begin(Proof(writer))
        started = self.status_file()
        self.assertEqual({k: started[k] for k in ("state", "tool", "command", "source", "scene", "quality", "output", "expected")},
                         {"state": "rendering", "tool": "manim 0.0.test", "command": "manim render -ql scenes/proof.py Proof", "source": "scenes/proof.py",
                          "scene": "Proof", "quality": "480p15", "output": "out/videos/proof/480p15/Proof.mp4", "expected": 2})

        writer.sections = [Section("Setup")]
        status.sync(writer)
        writer.partial_movie_files.append(str(clips / "c1.mp4"))
        writer.sections = [Section("Setup", [str(clips / "c1.mp4")]), Section("Skipped", [None], skip=True), Section("Proof")]
        status.sync(writer, "FadeIn(Square)", 0.51234)
        writer.partial_movie_files.append(None)                     # an animation that wrote no clip
        status.sync(writer, "Wait", None)
        writer.partial_movie_files.append(str(clips / "c2.mp4"))    # a clip that is gone by the end
        status.sync(writer, "Create(Circle)", 1.0)
        self.assertEqual(status.data["current"], "Create(Circle)")
        self.assertEqual(status.data["section"], "Proof")
        self.assertEqual(status.data["sections"], [{"name": "Setup", "animation": 0, "skipped": False}, {"name": "Skipped", "animation": 1, "skipped": True},
                                                   {"name": "Proof", "animation": 2, "skipped": False}])

        video.write_bytes(b"movie")
        status.finish(Proof(writer))
        done = self.status_file()
        self.assertEqual((done["state"], done["current"], done["animation"]), ("done", None, 3))
        self.assertEqual(done["clips"], ["out/videos/proof/480p15/partial_movie_files/Proof/c1.mp4", "out/videos/proof/480p15/partial_movie_files/Proof/c2.mp4"])
        self.assertEqual([(a["label"], a["runTime"], a["clip"], a["section"]) for a in done["animations"]],
                         [("FadeIn(Square)", 0.5123, "c1.mp4", 2), ("Wait", None, None, 2), ("Create(Circle)", 1.0, "c2.mp4", 2)])
        side = json.loads(sidecar.read_text())
        self.assertEqual(side["clipsDir"], "out/videos/proof/480p15/partial_movie_files/Proof")
        self.assertEqual(side["clips"], [{"name": "c1.mp4", "size": 5}, {"name": "c2.mp4", "size": None}])
        self.assertEqual(side["duration"], 1.5123)
        self.assertEqual([s["name"] for s in side["sections"]], ["Setup", "Proof"])
        self.assertEqual(side["previous"], {"renderedAtMs": 1, "duration": 2.5, "clips": [{"name": "old.mp4", "size": 9}], "sections": []})
        self.assertEqual(side["tookMs"], done["finishedAtMs"] - done["startedAtMs"])

    def test_a_first_render_without_a_clips_folder(self):
        video = self.video()
        video.parent.mkdir(parents=True)
        video.write_bytes(b"movie")
        writer = Writer(movie_file_path=str(video))
        writer.partial_movie_files = ["c1.mp4"]
        status = render.Status([])
        with fake_manim(input_file=""):
            status.begin(Proof(writer))
        self.assertEqual((status.data["expected"], status.data["source"]), (None, None))
        status.finish(Proof(writer))
        side = json.loads((self.ws / ".harness" / "renders" / "out/videos/proof/480p15/Proof.mp4.json").read_text())
        self.assertEqual((side["clipsDir"], side["clips"], side["previous"]), (None, [{"name": "c1.mp4", "size": None}], None))

    def test_no_video_no_sidecar(self):
        writer = Writer(movie_file_path=str(self.video()))
        status = render.Status([])
        status.finish(Proof(writer))
        self.assertFalse((self.ws / ".harness").exists(), "finish before begin writes nothing")
        with fake_manim():
            status.begin(Proof(writer))
        status.finish(Proof(writer))
        self.assertEqual(self.status_file()["state"], "done")
        self.assertFalse((self.ws / ".harness" / "renders").exists())

    def test_the_output_is_the_gif_the_movie_or_the_image(self):
        gif, movie, image = (str(self.ws / "out" / "q" / name) for name in ("A.gif", "A.mp4", "A.png"))
        cases = (("gif", Writer(gif_file_path=gif, movie_file_path=movie), "out/q/A.gif"),
                 ("gif", Writer(movie_file_path=movie), "out/q/A.mp4"),
                 (None, Writer(gif_file_path=gif, movie_file_path=movie), "out/q/A.mp4"),
                 (None, Writer(image_file_path=image), "out/q/A.png"),
                 (None, Writer(), None))
        for fmt, writer, output in cases:
            with self.subTest(fmt=fmt, output=output), fake_manim(fmt=fmt):
                status = render.Status([])
                status.begin(Proof(writer))
                self.assertEqual(status.data["output"], output)
                self.assertEqual(status.data["quality"], "q" if output else None)

    def test_an_unreadable_previous_sidecar_is_no_previous(self):
        sidecar = self.ws / ".harness" / "renders" / "out/videos/proof/480p15/Proof.mp4.json"
        sidecar.parent.mkdir(parents=True)
        sidecar.write_text("{truncated")
        status = render.Status([])
        with fake_manim():
            status.begin(Proof(Writer(movie_file_path=str(self.video()))))
        self.assertIsNone(status.previous)
        self.assertIsNone(status.data["expected"])

    def test_a_failure_before_any_scene_is_guessed_from_the_command(self):
        status = render.Status(with_manim_args(["-qm", "scenes/proof.py", "Proof"]))
        status.fail(None, None)
        failed = self.status_file()
        self.assertEqual({k: failed[k] for k in ("state", "source", "scene", "quality", "output", "error", "animation", "clips")},
                         {"state": "failed", "source": "scenes/proof.py", "scene": "Proof", "quality": "720p30", "output": "out/videos/proof/720p30/Proof.mp4",
                          "error": {"type": "Error", "message": "manim exited with an error"}, "animation": 0, "clips": []})
        status.fail(ValueError("later"), None)
        self.assertEqual(self.status_file()["error"]["type"], "Error", "the first failure is the one kept")

    def test_a_cancelled_render_has_no_error(self):
        status = render.Status([])
        with fake_manim():
            status.begin(Proof(Writer()))
        status.fail(None, None, cancelled=True)
        self.assertEqual((self.status_file()["state"], self.status_file()["error"]), ("cancelled", None))

    def test_progress_writes_are_throttled_unless_forced(self):
        status = render.Status([])
        status.data = {"n": 1}
        status.write(force=True)
        status.data["n"] = 2
        status.write()
        self.assertEqual(self.status_file()["n"], 1)
        status.last_write -= 1
        status.write()
        self.assertEqual(self.status_file()["n"], 2)


class Hooks(unittest.TestCase):
    """install_hooks on stand-in Manim classes: each hook calls through, reports to the status, and
    never lets the status break the render."""

    def setUp(self):
        test = self

        class Scene:
            def render(self, *args, **kwargs):
                test.rendered.append((args, kwargs))
                if test.render_raises:
                    raise test.render_raises
                return "rendered"

        class CairoRenderer:
            def play(self, scene, *args, **kwargs):
                return ("played", scene, args)

        class SceneFileWriter:
            def __init__(self):
                self.partial_movie_files, self.sections = [], []

            def add_partial_movie_file(self, hash_animation):
                self.partial_movie_files.append(hash_animation)

            def next_section(self, name="unnamed", **kwargs):
                self.sections.append(name)

        class Console:
            def print_exception(self, *args, **kwargs):
                return "printed"

        self.rendered, self.render_raises = [], None
        self.Scene, self.CairoRenderer, self.SceneFileWriter = Scene, CairoRenderer, SceneFileWriter
        self.console = Console()
        tree = {"manim": types.ModuleType("manim"), "manim__scene": types.ModuleType("manim.scene"),
                "manim__scene__scene": types.ModuleType("manim.scene.scene"), "manim__scene__scene_file_writer": types.ModuleType("manim.scene.scene_file_writer"),
                "manim__renderer": types.ModuleType("manim.renderer"), "manim__renderer__cairo_renderer": types.ModuleType("manim.renderer.cairo_renderer"),
                "manim__cli": types.ModuleType("manim.cli"), "manim__cli__render": types.ModuleType("manim.cli.render"),
                "manim__cli__render__commands": types.ModuleType("manim.cli.render.commands")}
        tree["manim__scene__scene"].Scene = Scene
        tree["manim__scene__scene_file_writer"].SceneFileWriter = SceneFileWriter
        tree["manim__renderer__cairo_renderer"].CairoRenderer = CairoRenderer
        tree["manim__cli__render__commands"].error_console = self.console
        tree["manim"].scene, tree["manim"].renderer, tree["manim"].cli = tree["manim__scene"], tree["manim__renderer"], tree["manim__cli"]
        tree["manim__scene"].scene, tree["manim__scene"].scene_file_writer = tree["manim__scene__scene"], tree["manim__scene__scene_file_writer"]
        tree["manim__renderer"].cairo_renderer = tree["manim__renderer__cairo_renderer"]
        tree["manim__cli"].render = tree["manim__cli__render"]
        tree["manim__cli__render"].commands = tree["manim__cli__render__commands"]
        context = modules({name.replace("__", "."): module for name, module in tree.items()})
        context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        self.status = mock.Mock()
        render.install_hooks(self.status)

    def test_a_scene_renders_between_begin_and_finish(self):
        scene = self.Scene()
        self.assertEqual(scene.render(1, fast=True), "rendered")
        self.assertEqual(self.rendered, [((1,), {"fast": True})])
        self.assertEqual(self.status.mock_calls, [mock.call.begin(scene), mock.call.finish(scene)])

    def test_a_failing_scene_is_reported_and_raised(self):
        scene = self.Scene()
        self.render_raises = ZeroDivisionError("nope")
        with self.assertRaises(ZeroDivisionError):
            scene.render()
        self.assertEqual(self.status.fail.call_args.args[0], self.render_raises)
        self.assertIsInstance(self.status.fail.call_args.args[1], types.TracebackType)
        self.status.finish.assert_not_called()

    def test_an_interrupted_scene_is_cancelled(self):
        self.render_raises = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.Scene().render()
        self.status.fail.assert_called_once_with(None, None, True)

    def test_each_clip_is_labelled_from_the_scene_that_played_it(self):
        writer = self.SceneFileWriter()
        writer.add_partial_movie_file("before any play")
        self.status.sync.assert_called_with(writer, "Animation", None)

        class FadeIn:
            mobject = None
        scene = types.SimpleNamespace(animations=[FadeIn(), FadeIn(), FadeIn()], duration=1.5)
        self.assertEqual(self.CairoRenderer().play(scene, "x"), ("played", scene, ("x",)))
        writer.add_partial_movie_file("h1")
        self.assertEqual(writer.partial_movie_files, ["before any play", "h1"])
        self.status.sync.assert_called_with(writer, "FadeIn +2", 1.5)
        writer.next_section("Proof", skip_animations=False)
        self.assertEqual(writer.sections, ["Proof"])
        self.status.sync.assert_called_with(writer)

    def test_the_cli_printing_an_exception_marks_the_failure(self):
        for error, cancelled in ((RuntimeError("init"), False), (KeyboardInterrupt(), True)):
            with self.subTest(error=type(error).__name__):
                try:
                    raise error
                except BaseException:
                    self.assertEqual(self.console.print_exception(show_locals=False), "printed")
                args = self.status.fail.call_args.args
                self.assertEqual((args[0], args[2]), (error, cancelled))

    def test_a_missing_latex_is_one_line_not_a_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp).resolve()
            source = ws / "scenes" / "formula.py"
            source.parent.mkdir()
            source.write_text("def construct():\n    raise FileNotFoundError(2, 'No such file or directory', 'latex')\n")
            namespace: dict = {}
            exec(compile(source.read_text(), str(source), "exec"), namespace)
            for where, construct, line in ((ws, namespace["construct"], "scenes/formula.py:2: "), (ws / "elsewhere", namespace["construct"], "")):
                with self.subTest(where=line or "no workspace frame"), mock.patch.object(render, "WS", where):
                    err = io.StringIO()
                    try:
                        construct()
                    except FileNotFoundError as exc:
                        with contextlib.redirect_stderr(err):
                            self.assertIsNone(self.console.print_exception(show_locals=False), "Manim's traceback is not printed")
                        self.assertIs(self.status.fail.call_args.args[0], exc)
                    self.assertEqual(err.getvalue(), f"{line}Tex/MathTex need LaTeX and `latex` is not on this machine — write the formula with Text(…) instead\n")

    def test_a_status_that_raises_never_stops_the_render(self):
        self.status.begin.side_effect = self.status.finish.side_effect = self.status.sync.side_effect = RuntimeError("feed broke")
        self.assertEqual(self.Scene().render(), "rendered")
        writer = self.SceneFileWriter()
        writer.add_partial_movie_file("h")
        writer.next_section("S")
        self.assertEqual((writer.partial_movie_files, writer.sections), (["h"], ["S"]))


class Main(Workspace):
    """main() with Manim's CLI and the verdict stood in for."""

    def run_main(self, cli, *argv, verdict_code=0, hooks=None):
        module = types.ModuleType("manim.__main__")
        module.main = cli
        stdout, stderr = io.StringIO(), io.StringIO()
        with modules({"manim": types.ModuleType("manim"), "manim.__main__": module}), \
                mock.patch.object(render, "install_hooks", hooks or (lambda status: None)), \
                mock.patch.object(render.subprocess, "run", return_value=subprocess.CompletedProcess([], verdict_code)) as run, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = render.main(["render.py", *argv])
        return code, run, stdout.getvalue(), stderr.getvalue()

    def exits(self, value):
        def cli(**kwargs):
            self.cli_kwargs = kwargs
            raise SystemExit(value)
        return cli

    def test_help(self):
        for argv, code in (([], 2), (["-h"], 0), (["--help"], 0)):
            with self.subTest(argv=argv):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(render.main(["render.py", *argv]), code)
                self.assertTrue(out.getvalue().startswith("Render Manim scenes the way the pane shows them"))

    def test_a_render_hands_its_command_to_manim_and_returns_the_verdict(self):
        seen = []

        def cli(**kwargs):
            seen.append(kwargs)
            status = hooked[0]
            status.scenes_begun = 1

        hooked = []
        code, run, _, _ = self.run_main(cli, "scenes/a.py", "A", verdict_code=1, hooks=hooked.append)
        self.assertEqual(code, 1)
        self.assertEqual(seen, [{"args": ["render", "--save_sections", "--media_dir", "out", "-ql", "scenes/a.py", "A"], "prog_name": "manim", "standalone_mode": True}])
        self.assertEqual(run.call_args.args[0], [sys.executable, str(HERE / "verdict.py")])
        self.assertEqual((run.call_args.kwargs["cwd"], run.call_args.kwargs["env"]["HARNESS_WORKSPACE"]), (str(self.ws), str(self.ws)))
        self.assertFalse((self.ws / ".harness" / "render.json").exists(), "the hooks write the feed, not main")

    def test_a_clean_exit_that_rendered_nothing_says_so(self):
        for value in (0, None):
            with self.subTest(exit=value):
                code, _, _, _ = self.run_main(self.exits(value), "scenes/a.py")
                self.assertEqual(code, 0)
                self.assertEqual({k: self.status_file()[k] for k in ("state", "note")}, {"state": "done", "note": "no scene rendered"})

    def test_manim_failing_marks_the_feed_failed_and_skips_the_verdict_code(self):
        for value, expected in ((2, 2), ("Error: no such option", 1)):
            with self.subTest(exit=value):
                code, run, _, _ = self.run_main(self.exits(value), "-qh", "scenes/a.py", "A", verdict_code=0)
                self.assertEqual(code, expected)
                run.assert_called_once()
                self.assertEqual({k: self.status_file()[k] for k in ("state", "scene", "quality")}, {"state": "failed", "scene": "A", "quality": "1080p60"})

    def test_a_trailing_option_without_its_value_does_not_crash_the_wrapper(self):
        code, run, _, _ = self.run_main(self.exits(2), "scenes/a.py", "A", "--media_dir")
        self.assertEqual(code, 2)
        self.assertEqual(self.status_file()["output"], "media/videos/a/480p15/A.mp4")
        run.assert_called_once()

    def test_an_interrupt_outside_the_cli_is_a_cancel(self):
        def cli(**kwargs):
            raise KeyboardInterrupt
        code, _, _, _ = self.run_main(cli, "scenes/a.py", "A")
        self.assertEqual((code, self.status_file()["state"], self.status_file()["error"]), (130, "cancelled", None))

    def test_an_exception_escaping_the_cli_is_printed_and_recorded(self):
        def cli(**kwargs):
            raise SyntaxError("invalid syntax")
        code, _, _, stderr = self.run_main(cli, "scenes/a.py", "A")
        self.assertEqual(code, 1)
        self.assertIn("SyntaxError: invalid syntax", stderr)
        self.assertEqual(self.status_file()["error"]["type"], "SyntaxError")

    def test_a_manim_the_hooks_do_not_know_still_renders(self):
        def hooks(status):
            raise AttributeError("no Scene.render")
        code, run, _, stderr = self.run_main(self.exits(0), "scenes/a.py", hooks=hooks)
        self.assertEqual(stderr, "render.py: progress hooks unavailable (no Scene.render); rendering without them\n")
        run.assert_called_once()

    def test_run_as_a_script(self):
        with mock.patch.object(sys, "argv", ["render.py", "--help"]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(HERE / "render.py"), run_name="__main__")
        self.assertEqual(exit_.exception.code, 0)


TINY = '''from manim import *


class Tiny(Scene):
    def construct(self):
        self.next_section("One")
        square = Square()
        self.play(FadeIn(square), run_time=0.5)
        self.next_section("Two")
        self.play(square.animate.shift(RIGHT), Rotate(square), run_time=0.5)
        self.wait(0.2)
'''
BROKEN = '''from manim import *


class Broken(Scene):
    def construct(self):
        self.play(FadeIn(Sqaure()))
'''
FORMULA = '''from manim import *


class Formula(Scene):
    def construct(self):
        self.play(Write(MathTex(r"e^{i\\pi} + 1 = 0")))
'''
SYNTAX = '''from manim import *
class Bad(Scene:
    pass
'''


@unittest.skipUnless(HAS_MANIM, "manim is not importable here; run with the harness venv's python")
class RealManim(Workspace):
    """The pinned Manim, in this process, on a scene small enough to render in about a second."""

    FLAGS = ["--disable_caching", "--silent", "-v", "ERROR", "--progress_bar", "none"]

    def setUp(self):
        super().setUp()
        for name, source in (("tiny", TINY), ("broken", BROKEN), ("syntax", SYNTAX), ("formula", FORMULA)):
            (self.ws / "scenes").mkdir(exist_ok=True)
            (self.ws / "scenes" / f"{name}.py").write_text(source)
        self.unhook = self.hooks_restorer()
        self.addCleanup(self.unhook)

    @staticmethod
    def hooks_restorer():
        """install_hooks patches Manim's classes for the life of a process; put them back per test."""
        from manim.scene.scene import Scene
        from manim.scene.scene_file_writer import SceneFileWriter
        from manim.renderer.cairo_renderer import CairoRenderer
        import manim.cli.render.commands as commands
        saved = [(cls, name, cls.__dict__[name]) for cls, name in ((Scene, "render"), (CairoRenderer, "play"), (SceneFileWriter, "add_partial_movie_file"), (SceneFileWriter, "next_section"))]
        console = commands.error_console

        def restore():
            for cls, name, fn in saved:
                setattr(cls, name, fn)
            vars(console).pop("print_exception", None)
        return restore

    def render(self, scene_file, scene):
        from manim import tempconfig
        self.unhook()  # every run hooks Manim afresh, as a new process would
        # and starts from Manim's own config: it keeps the first input file it digests for good.
        with tempconfig({}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            code = render.main(["render.py", *self.FLAGS, f"scenes/{scene_file}", scene])
        return code, err.getvalue()

    def verdict(self) -> dict:
        return json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def test_a_scene_renders_with_chapters_a_sidecar_and_a_ready_verdict(self):
        code, err = self.render("tiny.py", "Tiny")
        self.assertEqual(code, 0, err)
        feed = self.status_file()
        self.assertEqual((feed["state"], feed["scene"], feed["quality"], feed["output"], feed["expected"]), ("done", "Tiny", "480p15", "out/videos/tiny/480p15/Tiny.mp4", None))
        self.assertEqual([s["name"] for s in feed["sections"]], ["One", "Two"])
        self.assertEqual([(a["label"], a["runTime"], a["section"]) for a in feed["animations"]],
                         [("FadeIn(Square)", 0.5, 0), ("animate(Square) +1", 0.5, 1), ("Wait", 0.2, 1)])
        sidecar = json.loads((self.ws / ".harness" / "renders" / "out/videos/tiny/480p15/Tiny.mp4.json").read_text())
        self.assertEqual((sidecar["duration"], len(sidecar["clips"]), sidecar["previous"]), (1.2, 3, None))
        self.assertTrue(all(isinstance(c["size"], int) and c["size"] > 0 for c in sidecar["clips"]))
        verdict = self.verdict()
        self.assertTrue(verdict["ready"], verdict)
        self.assertEqual(verdict["artifact"], "out/videos/tiny/480p15/Tiny.mp4")
        self.assertIn("2 chapters", verdict["summary"])

        code, err = self.render("tiny.py", "Tiny")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.status_file()["expected"], 3, "a re-render expects the animations of the last one")
        sidecar = json.loads((self.ws / ".harness" / "renders" / "out/videos/tiny/480p15/Tiny.mp4.json").read_text())
        self.assertEqual(sidecar["previous"]["duration"], 1.2)

    def test_a_scene_that_raises_names_its_line(self):
        code, _ = self.render("broken.py", "Broken")
        self.assertEqual(code, 1)
        feed = self.status_file()
        self.assertEqual(feed["state"], "failed")
        self.assertEqual(feed["error"], {"type": "NameError", "message": "name 'Sqaure' is not defined", "file": "scenes/broken.py", "line": 6,
                                         "code": "self.play(FadeIn(Sqaure()))", "function": "construct"})
        self.assertEqual(self.verdict()["phases"][1]["state"], "failed")

    def test_a_syntax_error_is_reported_before_any_scene_exists(self):
        code, err = self.render("syntax.py", "Bad")
        self.assertEqual(code, 1)
        self.assertIn("SyntaxError", err)
        feed = self.status_file()
        self.assertEqual((feed["state"], feed["scene"], feed["output"]), ("failed", "Bad", "out/videos/syntax/480p15/Bad.mp4"))
        self.assertEqual({k: feed["error"][k] for k in ("type", "file", "line", "code")}, {"type": "SyntaxError", "file": "scenes/syntax.py", "line": 2, "code": "class Bad(Scene:"})

    @unittest.skipIf(shutil.which("latex"), "LaTeX is on this machine")
    def test_a_formula_without_latex_is_one_clear_line(self):
        code, err = self.render("formula.py", "Formula")
        self.assertEqual(code, 1)
        self.assertEqual(err, "scenes/formula.py:6: Tex/MathTex need LaTeX and `latex` is not on this machine — write the formula with Text(…) instead\n")
        self.assertEqual({k: self.status_file()["error"][k] for k in ("type", "file", "line")}, {"type": "FileNotFoundError", "file": "scenes/formula.py", "line": 6})


if __name__ == "__main__": unittest.main()
