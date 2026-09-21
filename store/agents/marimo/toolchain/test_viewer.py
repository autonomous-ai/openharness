"""The pane's marimo settings take on the pinned marimo: .venv/bin/python -m unittest toolchain/test_viewer.py

viewer.py layers three settings over marimo's config by wrapping the factory `marimo._server.start`
calls. If a marimo bump moves that factory, the pane still starts (with marimo's defaults) — this
test is what notices. The tests with a stand-in marimo run anywhere; the real ones need the venv.
"""
import contextlib
import io
import os
import runpy
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

PACKAGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACKAGE))

import viewer  # noqa: E402

try:
    import marimo._server.start as start
except ImportError:  # the plain `python3 -m unittest` run, outside the venv
    start = None


def stand_in_marimo(test: unittest.TestCase, factory=True) -> types.SimpleNamespace:
    """A marimo package tree in sys.modules for the length of the test: `_server.start` with a config
    factory (or without one, as a moved marimo would be) and a `_cli.cli.main` that records its call."""
    made = types.SimpleNamespace(calls=[], factory_calls=[])

    class Manager:
        def __init__(self, args, kwargs):
            self.args, self.kwargs, self.overrides = args, kwargs, None

        def with_overrides(self, overrides):
            self.overrides = overrides
            return self

    def get_default_config_manager(*args, **kwargs):
        made.factory_calls.append((args, kwargs))
        return Manager(args, kwargs)

    def cli_main(**kwargs):
        made.calls.append({"kwargs": kwargs, "cwd": os.getcwd()})

    modules = {name: types.ModuleType(name) for name in ("marimo", "marimo._server", "marimo._server.start", "marimo._cli", "marimo._cli.cli")}
    modules["marimo"]._server, modules["marimo"]._cli = modules["marimo._server"], modules["marimo._cli"]
    modules["marimo._server"].start = modules["marimo._server.start"]
    modules["marimo._cli"].cli = modules["marimo._cli.cli"]
    if factory:
        modules["marimo._server.start"].get_default_config_manager = get_default_config_manager
    modules["marimo._cli.cli"].main = cli_main
    patcher = mock.patch.dict(sys.modules, modules)
    patcher.start()
    test.addCleanup(patcher.stop)
    made.start = modules["marimo._server.start"]
    return made


class Pane(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws = str(Path(tmp.name).resolve())
        self.addCleanup(os.chdir, os.getcwd())

    def test_tune_layers_the_pane_settings_over_the_factory(self):
        fake = stand_in_marimo(self)
        viewer.tune()
        manager = fake.start.get_default_config_manager(current_path="/Users/example/ws/notebook.py")
        self.assertEqual(fake.factory_calls, [((), {"current_path": "/Users/example/ws/notebook.py"})])
        self.assertEqual(manager.overrides, viewer.PANE_CONFIG)

    def test_a_marimo_that_moved_the_factory_still_starts_and_says_so(self):
        fake = stand_in_marimo(self, factory=False)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            viewer.tune()
        self.assertRegex(err.getvalue(), r"^\[marimo pane\] running with marimo's defaults \(.*get_default_config_manager.*\)\n$")
        self.assertFalse(hasattr(fake.start, "get_default_config_manager"))

    def test_main_runs_marimo_edit_headless_on_the_workspace_notebook(self):
        fake = stand_in_marimo(self)
        with mock.patch.dict(os.environ, {"HARNESS_VIEWER_PORT": "4123", "HARNESS_WORKSPACE": self.ws}):
            os.environ.pop("MARIMO_PANE_NOTEBOOK", None)
            viewer.main()
        self.assertEqual(fake.calls, [{"cwd": self.ws, "kwargs": {"prog_name": "marimo", "args": [
            "edit", "--headless", "--host", "127.0.0.1", "--port", "4123", "--no-token", "--watch", "--skip-update-check", "notebook.py"]}}])
        self.assertIsNotNone(fake.start.get_default_config_manager().overrides, "tune() ran before marimo started")

    def test_the_notebook_can_be_named_and_the_file_runs_as_a_script(self):
        fake = stand_in_marimo(self)
        env = {"HARNESS_VIEWER_PORT": "4124", "HARNESS_WORKSPACE": self.ws, "MARIMO_PANE_NOTEBOOK": "analysis.py"}
        with mock.patch.dict(os.environ, env):
            runpy.run_path(str(PACKAGE / "viewer.py"), run_name="__main__")
        self.assertEqual(fake.calls[0]["kwargs"]["args"][-1], "analysis.py")
        self.assertEqual(fake.calls[0]["kwargs"]["args"][5], "4124")


@unittest.skipIf(start is None, "marimo is not importable here; run with .venv/bin/python")
class PaneConfig(unittest.TestCase):
    def test_overrides_reach_the_server_config(self):
        original = start.get_default_config_manager
        try:
            viewer.tune()
            with tempfile.TemporaryDirectory() as ws:
                notebook = Path(ws, "notebook.py")
                notebook.write_text("import marimo\napp = marimo.App()\n")
                config = start.get_default_config_manager(current_path=str(notebook)).get_config()
            self.assertIs(config["runtime"]["auto_instantiate"], True)
            self.assertEqual(config["runtime"]["watcher_on_save"], "autorun")
            self.assertEqual(config["save"]["autosave"], "off")
        finally:
            start.get_default_config_manager = original

    def test_the_pinned_marimo_accepts_the_pane_command_line(self):
        """marimo's own `edit` parses the flags and reaches the server start, which is stubbed."""
        import marimo._cli.cli as cli

        original = start.get_default_config_manager
        self.addCleanup(setattr, start, "get_default_config_manager", original)
        self.addCleanup(os.chdir, os.getcwd())
        with tempfile.TemporaryDirectory() as ws, mock.patch.object(cli, "start") as server:
            Path(ws, "notebook.py").write_text("import marimo\napp = marimo.App()\n\n@app.cell\ndef _():\n    return\n")
            env = {"HARNESS_VIEWER_PORT": "4125", "HARNESS_WORKSPACE": ws, "MARIMO_SKIP_UPDATE_CHECK": "1"}
            with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(io.StringIO()):
                os.environ.pop("MARIMO_PANE_NOTEBOOK", None)
                with self.assertRaises(SystemExit) as exit_:
                    viewer.main()
            self.assertEqual(os.path.realpath(os.getcwd()), os.path.realpath(ws))
        self.assertEqual(exit_.exception.code, 0)
        kwargs = server.call_args.kwargs
        self.assertEqual((kwargs["host"], kwargs["port"], kwargs["headless"], kwargs["watch"], str(kwargs["auth_token"])),
                         ("127.0.0.1", 4125, True, True, ""), "loopback, the given port, no browser, following the file, no token")
        self.assertIn("notebook.py", repr(vars(kwargs["workspace"])))


if __name__ == "__main__":
    unittest.main()
