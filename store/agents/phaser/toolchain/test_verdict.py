import io
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import verdict  # noqa: E402
from verdict import build_message, judge, source_files  # noqa: E402

PLAYS = {"create": True, "input": True, "gate": True}


class Judge(unittest.TestCase):
    def test_a_game_that_builds_and_plays_is_ready(self):
        v = judge(True, ["Title", "Play"], None, PLAYS, "out/dist/index.html")
        self.assertTrue(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "2 scenes: Title, Play · builds · plays")
        self.assertEqual(v["artifact"], "out/dist/index.html")
        self.assertEqual(v["findings"], [])

    def test_a_build_error_fails_the_build_phase(self):
        v = judge(True, ["Play"], "src/scenes/Play.js:12:4: ERROR: Expected \";\"", PLAYS, None)
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["phases"][2]["state"], "pending")
        self.assertEqual(v["findings"][0]["severity"], "error")
        self.assertNotIn("artifact", v)

    def test_no_scene_is_an_error_even_when_main_exists(self):
        v = judge(True, [], None, {"create": False, "input": False, "gate": False}, None)
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["findings"][0]["kind"], "scene")

    def test_no_input_is_a_warning_and_play_stays_active(self):
        v = judge(True, ["Play"], None, {"create": True, "input": False, "gate": False}, "out/dist/index.html")
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][2]["state"], "active")
        kinds = [f["kind"] for f in v["findings"]]
        self.assertEqual(kinds, ["input", "focus"])
        self.assertIn("1 warning", v["summary"])

    def test_a_missing_click_gate_is_only_info(self):
        v = judge(True, ["Play"], None, {"create": True, "input": True, "gate": False}, None)
        self.assertTrue(v["ready"])
        self.assertEqual([f["severity"] for f in v["findings"]], ["info"])

    def test_an_empty_workspace_is_writing(self):
        v = judge(False, [], None, {"create": False, "input": False, "gate": False}, None)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertEqual(v["summary"], "no game yet")

    def test_no_build_does_not_claim_a_build_nobody_ran(self):
        v = judge(True, ["Title", "Play"], None, PLAYS, None, build_ran=False)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
        self.assertEqual(v["summary"], "2 scenes: Title, Play · not built yet")

    def test_a_scene_without_create_warns_and_errors_and_warnings_are_counted(self):
        v = judge(True, ["Play"], "Transform failed", {"create": False, "input": True, "gate": True}, None)
        self.assertEqual([(f["severity"], f["kind"]) for f in v["findings"]], [("error", "build"), ("warning", "scene")])
        self.assertEqual(v["summary"], "1 scene: Play · does not build · 1 error, 1 warning")

    def test_several_errors_and_warnings_are_plural(self):
        v = judge(True, ["A", "B", "C", "D", "E"], "boom", {"create": False, "input": False, "gate": True}, None)
        self.assertEqual(v["summary"], "5 scenes: A, B, C, D… · does not build · 1 error, 2 warnings")

    def test_a_main_without_scenes_says_how_many_errors(self):
        v = judge(True, [], None, {"create": True, "input": True, "gate": True}, None)
        self.assertEqual(v["summary"], "1 error")
        self.assertEqual(v["phases"][2]["state"], "pending")

    def test_summary_stays_inside_the_header(self):
        v = judge(True, [f"Scene{i}" for i in range(20)], None, PLAYS, None)
        self.assertLessEqual(len(v["summary"]), 200)
        self.assertIn("…", v["summary"])


class BuildMessage(unittest.TestCase):
    def test_takes_the_lines_after_error_during_build(self):
        out = (
            "vite v6.4.3 building for production...\n"
            "\x1b[31merror during build:\x1b[0m\n"
            "[vite:esbuild] Transform failed with 1 error:\n"
            "/tmp/ws/src/scenes/Play.js:12:4: ERROR: Expected \";\" but found \"x\"\n"
        )
        msg = build_message(out)
        self.assertIn("Play.js:12:4", msg)
        self.assertNotIn("\x1b", msg)

    def test_stops_before_rollups_file_line_and_stack(self):
        out = (
            "error during build:\n"
            "[vite]: Rollup failed to resolve\n"
            "Could not resolve \"../nope.js\" from \"src/scenes/Play.js\"\n"
            "file: /tmp/ws/src/scenes/Play.js\n"
            "    at getRollupError (file:///.../parseAst.js:319:41)\n"
        )
        msg = build_message(out)
        self.assertEqual(msg, '[vite]: Rollup failed to resolve Could not resolve "../nope.js" from "src/scenes/Play.js"')

    def test_falls_back_to_an_error_line(self):
        self.assertIn("Could not resolve", build_message("blah\n[vite]: Rollup failed: Could not resolve './Missing.js'\n"))

    def test_empty_output(self):
        self.assertEqual(build_message("   \n\n"), "vite build failed with no output")

    def test_error_during_build_with_nothing_readable_after_it_falls_through(self):
        out = "error during build:\nfile: /tmp/ws/src/main.js\nsomething else\n"
        self.assertEqual(build_message(out), "something else")

    def test_without_a_known_marker_the_last_line_is_the_message(self):
        self.assertEqual(build_message("building...\n\x1b[2mexited with code 2\x1b[0m\n"), "exited with code 2")


def write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


TITLE = ("import Phaser from 'phaser';\nexport default class Title extends Phaser.Scene {\n"
         "  create() { this.input.once('pointerdown', () => this.scene.start('Play')); }\n}\n")
PLAY = "export default class Play extends Scene {\n  create() { this.cursors = this.input.keyboard.createCursorKeys(); }\n}\n"


class SourceFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name)

    def test_no_src_folder_is_no_sources(self):
        self.assertEqual(source_files(self.ws), [])

    def test_only_hand_written_scripts_under_src(self):
        for name in ("src/main.js", "src/scenes/Play.ts", "src/lib/util.mjs", "src/readme.md",
                     "src/node_modules/x/index.js", "src/out/a.js", "src/dist/b.js", "src/.vite/c.js", "main.js"):
            write(self.ws / name)
        (self.ws / "src" / "folder.js").mkdir()
        got = [p.relative_to(self.ws).as_posix() for p in source_files(self.ws)]
        self.assertEqual(got, ["src/lib/util.mjs", "src/main.js", "src/scenes/Play.ts"])

    def test_a_workspace_inside_a_folder_named_like_build_output_still_has_sources(self):
        # The skip list is about folders under src/, not the folders the workspace itself lives in.
        for parent in ("out", "dist", "node_modules", ".vite"):
            ws = self.ws / parent / "game"
            write(ws / "src" / "main.js")
            self.assertEqual([p.name for p in source_files(ws)], ["main.js"], parent)


def stub_vite(folder: Path, body: str) -> str:
    """An executable standing in for vite: logs its argv and cwd beside itself, then runs `body`."""
    path = folder / "vite-stub"
    path.write_text(
        f"#!{sys.executable}\nimport json, os, sys\n"
        "open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vite-calls.jsonl'), 'a')"
        ".write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd()}) + '\\n')\n"
        f"{body}\n")
    path.chmod(0o755)
    return str(path)


class Main(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.ws = root / "ws"
        self.ws.mkdir()
        self.bin = root / "bin"
        self.bin.mkdir()

    def game(self):
        write(self.ws / "src" / "main.js", "import Title from './scenes/Title.js';\n")
        write(self.ws / "src" / "scenes" / "Title.js", TITLE)
        write(self.ws / "src" / "scenes" / "Play.js", PLAY)

    def calls(self):
        log = self.bin / "vite-calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def run_main(self, vite: str, *argv: str):
        out = io.StringIO()
        with mock.patch.object(verdict, "WS", self.ws), mock.patch.object(verdict, "VITE", vite), redirect_stdout(out):
            code = verdict.main(list(argv))
        return code, out.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def test_an_empty_workspace_writes_a_verdict_without_building(self):
        code, out, v = self.run_main(stub_vite(self.bin, "sys.exit(0)"))
        self.assertEqual(code, 1)
        self.assertEqual(out, "not ready · no game yet\n")
        self.assertEqual(v["summary"], "no game yet")
        self.assertEqual(self.calls(), [])

    def test_a_game_that_builds_is_ready_and_names_the_built_page(self):
        self.game()
        vite = stub_vite(self.bin, "os.makedirs('out/dist', exist_ok=True); open('out/dist/index.html', 'w').write('<html>')")
        code, out, v = self.run_main(vite)
        self.assertEqual(code, 0)
        self.assertEqual(self.calls(), [{"argv": ["build", "--outDir", "out/dist", "--minify", "false", "--logLevel", "warn"],
                                         "cwd": str(self.ws)}])
        self.assertTrue(v["ready"])
        self.assertEqual(v["artifact"], "out/dist/index.html")
        self.assertEqual(out, "ready · 2 scenes: Play, Title · builds · plays\n")

    def test_a_failed_build_is_a_finding_with_vites_message(self):
        self.game()
        vite = stub_vite(self.bin, "sys.stderr.write('error during build:\\n[vite:esbuild] Transform failed\\n"
                                   "file: /tmp/x.js\\n'); sys.exit(1)")
        code, out, v = self.run_main(vite)
        self.assertEqual(code, 1)
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "build", "message": "[vite:esbuild] Transform failed"}])
        self.assertNotIn("artifact", v)
        self.assertIn("  error   [vite:esbuild] Transform failed\n", out)

    def test_a_vite_that_is_not_there_is_a_build_finding(self):
        self.game()
        code, _, v = self.run_main(str(self.bin / "no-such-vite"))
        self.assertEqual(code, 1)
        self.assertEqual(v["findings"][0]["kind"], "build")
        self.assertTrue(v["findings"][0]["message"].startswith("vite could not run ("), v["findings"][0]["message"])

    def test_a_build_that_hangs_is_a_build_finding(self):
        self.game()
        hung = subprocess.TimeoutExpired(cmd=["vite", "build"], timeout=600)
        vite = stub_vite(self.bin, "sys.exit(0)")
        with mock.patch.object(verdict.subprocess, "run", side_effect=hung):
            code, _, v = self.run_main(vite)
        self.assertEqual(code, 1)
        self.assertIn("timed out after 600 seconds", v["findings"][0]["message"])

    def node_env(self, recorded: bool):
        """The agent's shell as a new Mac has it: no node on PATH, and Harness's own recorded, or not."""
        runtime = self.bin / "runtime"
        runtime.mkdir()
        if recorded:
            node = self.bin / "harness-node" / "bin" / "node"
            node.parent.mkdir(parents=True)
            node.write_text(f'#!/bin/bash\n[ "$1" = -e ] && exit 0\necho "harness node ran $1" > "{self.bin}/node.log"\n')
            node.chmod(0o755)
            (runtime / "current-node").write_text(f"{node}\n")
        return mock.patch.dict(os.environ, {"PATH": "/usr/bin:/bin", "ADAPTER_RUNTIME_DIR": str(runtime)})

    def test_vite_runs_on_harnesss_node_when_the_shell_has_none(self):
        self.game()
        vite = self.bin / "vite"
        vite.write_text("#!/usr/bin/env node\n")             # what node_modules/.bin/vite is
        vite.chmod(0o755)
        with self.node_env(recorded=True):
            code, _, v = self.run_main(str(vite))
        self.assertEqual((self.bin / "node.log").read_text(), f"harness node ran {vite}\n")
        self.assertEqual((code, v["findings"], v["ready"]), (0, [], True))

    def test_no_node_anywhere_is_a_build_finding_that_says_so(self):
        self.game()
        with self.node_env(recorded=False):
            code, _, v = self.run_main(stub_vite(self.bin, "sys.exit(0)"))
        self.assertEqual(code, 1)
        self.assertEqual(v["findings"][0], {"severity": "error", "kind": "build", "message":
                         f"miss node >= 18, and Harness's own Node is not in {self.bin / 'runtime'} — run `harness start` once to lay it down"})
        self.assertEqual(self.calls(), [])

    def test_no_build_reads_the_scenes_but_never_runs_vite(self):
        self.game()
        write(self.ws / "out" / "dist" / "index.html", "<html>")  # from an earlier build
        code, _, v = self.run_main(stub_vite(self.bin, "sys.exit(0)"), "--no-build")
        self.assertEqual(code, 1)
        self.assertEqual(self.calls(), [])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
        self.assertEqual(v["artifact"], "out/dist/index.html")

    def test_a_typescript_entry_counts_and_what_the_scenes_lack_is_reported(self):
        write(self.ws / "src" / "main.ts", "new Phaser.Game({})\n")
        write(self.ws / "src" / "Level.ts", "class Level extends Phaser.Scene { preload() {} }\n")
        code, _, v = self.run_main(stub_vite(self.bin, "sys.exit(0)"), "--no-build")
        self.assertEqual(code, 1)
        self.assertEqual([f["kind"] for f in v["findings"]], ["scene", "input", "focus"])
        self.assertEqual(v["summary"], "1 scene: Level · not built yet · 2 warnings")

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads any file")
    def test_an_unreadable_source_is_skipped(self):
        self.game()
        secret = write(self.ws / "src" / "scenes" / "Boss.js", "class Boss extends Phaser.Scene {}\n")
        secret.chmod(0)
        self.addCleanup(secret.chmod, 0o644)
        _, _, v = self.run_main(stub_vite(self.bin, "sys.exit(0)"), "--no-build")
        self.assertEqual(v["summary"], "2 scenes: Play, Title · not built yet")


class CommandLine(unittest.TestCase):
    def test_the_script_judges_harness_workspace_and_exits_with_the_verdict(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            write(ws / "src" / "main.js")
            write(ws / "src" / "Title.js", TITLE)
            env = {"HARNESS_WORKSPACE": str(ws), "VITE": str(ws / "no-vite")}
            with mock.patch.dict(os.environ, env), mock.patch.object(sys, "argv", ["verdict.py", "--no-build"]), \
                    redirect_stdout(io.StringIO()) as out, self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
            self.assertEqual(exit_.exception.code, 1)
            self.assertEqual(out.getvalue(), "not ready · 1 scene: Title · not built yet\n")
            v = json.loads((ws / ".harness" / "verdict.json").read_text())
            self.assertEqual(v["phases"][1]["state"], "active")


if __name__ == "__main__":
    unittest.main()
