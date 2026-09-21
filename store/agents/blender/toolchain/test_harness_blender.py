"""harness_blender on real bpy, at postage-stamp sizes. Needs the venv's bpy:

    "$BLENDER_PYTHON" -m unittest toolchain/test_harness_blender.py

Every test starts from fresh() in its own scratch workspace; renders are 32×18 and turntables a few
frames, so the whole file runs in seconds.
"""
import atexit, contextlib, importlib, io, json, os, shutil, struct, sys, tempfile, types, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import bpy
    from mathutils import Vector
except ImportError:  # the verdict tests run without bpy; these cannot
    bpy = None

hb = None
IMPORT_FEED = None
IMPORT_HOOK = None
SIZE = (32, 18)


def setUpModule():
    """Import the helper the way a scene script does: from a workspace, as scenes/build.py."""
    global hb, IMPORT_FEED, IMPORT_HOOK
    if bpy is None:
        return
    tmp = tempfile.TemporaryDirectory()
    ws = Path(tmp.name).resolve()
    (ws / ".harness").mkdir()
    (ws / "scenes").mkdir()
    cwd, hook = os.getcwd(), sys.excepthook
    os.chdir(ws)
    try:
        with mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": str(ws)}), mock.patch.object(sys, "argv", [str(ws / "scenes" / "build.py")]):
            sys.modules.pop("harness_blender", None)
            hb = importlib.import_module("harness_blender")
        IMPORT_FEED = json.loads((ws / ".harness" / "build.json").read_text())
        IMPORT_HOOK = sys.excepthook
    finally:
        os.chdir(cwd)
        sys.excepthook = hook
        atexit.unregister(hb._finish)
        tmp.cleanup()


def glb_json(path: Path) -> dict:
    data = path.read_bytes()
    length = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20:20 + length])


@unittest.skipIf(bpy is None, "bpy is not importable here; run with the venv's python")
class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws = Path(tmp.name).resolve()
        (self.ws / ".harness").mkdir()
        cwd = os.getcwd()
        os.chdir(self.ws)
        self.addCleanup(os.chdir, cwd)
        patcher = mock.patch.object(hb, "_WS", self.ws)
        patcher.start()
        self.addCleanup(patcher.stop)
        hb._feed.clear()
        hb._exported.clear()
        hb._feed_written = 0.0
        self.addCleanup(hb._feed.clear)
        self.addCleanup(hb._exported.clear)
        hb.fresh()

    def feed(self) -> dict:
        return json.loads((self.ws / ".harness" / "build.json").read_text())

    def cube(self, name="Cube", size=10.0, location=(0, 0, 0)):
        bpy.ops.mesh.primitive_cube_add(size=size, location=location)
        obj = bpy.context.active_object
        obj.name = name
        return obj


class Feed(Base):
    def test_importing_announces_the_script(self):
        self.assertEqual({k: IMPORT_FEED[k] for k in ("state", "step", "progress", "script", "pid", "exported", "error")},
                         {"state": "building", "step": "Running", "progress": None, "script": "scenes/build.py", "pid": os.getpid(), "exported": None, "error": None})
        self.assertIs(IMPORT_HOOK, hb._excepthook)

    def test_fresh_says_modelling(self):
        self.assertEqual(self.feed()["step"], "Modelling")

    def test_no_harness_folder_means_no_feed(self):
        hb._feed.clear()
        shutil.rmtree(self.ws / ".harness")
        hb._activity("Exporting")
        self.assertEqual(hb._feed, {})
        self.assertFalse((self.ws / ".harness").exists())

    def test_only_a_python_script_is_named(self):
        for argv in (["python"], [""], []):
            with self.subTest(argv=argv), mock.patch.object(sys, "argv", argv):
                hb._feed.clear()
                hb._activity("x")
                self.assertIsNone(self.feed()["script"])

    def test_progress_is_clamped_and_extras_ride_along(self):
        hb._activity("a", progress=1.7, exported="out/a.glb")
        self.assertEqual((self.feed()["progress"], self.feed()["exported"]), (1.0, "out/a.glb"))
        hb._activity("b", progress=-0.3)
        self.assertEqual(self.feed()["progress"], 0.0)
        hb._activity(progress=0.12345)
        self.assertEqual((self.feed()["step"], self.feed()["progress"]), ("b", 0.123))

    def test_per_frame_progress_is_throttled(self):
        hb._activity("first")
        hb._activity("second", progress=0.5, force=False)
        self.assertEqual(self.feed()["step"], "first")
        self.assertEqual(hb._feed["step"], "second")
        hb._feed_written = 0.0
        hb._activity("third", force=False)
        self.assertEqual(self.feed()["step"], "third")

    def test_a_feed_that_cannot_be_written_never_fails_the_build(self):
        (self.ws / ".harness" / "build.json").unlink()
        (self.ws / ".harness" / "build.json").mkdir()
        hb._activity("Exporting")
        self.assertTrue((self.ws / ".harness" / "build.json").is_dir())

    def test_an_uncaught_error_marks_the_build_failed(self):
        prior = mock.Mock()
        with mock.patch.object(hb, "_prior_excepthook", prior):
            hb._activity("Exporting model.glb")
            try:
                raise ValueError("boom " + "x" * 300)
            except ValueError as error:
                hb._excepthook(ValueError, error, error.__traceback__)
            prior.assert_called_once()
            feed = self.feed()
            self.assertEqual((feed["state"], feed["step"]), ("failed", "Exporting model.glb"))
            self.assertEqual(len(feed["error"]), 200)
            self.assertTrue(feed["error"].startswith("ValueError: boom xxx") and feed["error"].endswith("…"))
            hb._feed.clear()
            hb._excepthook(RuntimeError, RuntimeError("short"), None)
            self.assertEqual({k: self.feed()[k] for k in ("state", "step", "error")}, {"state": "failed", "step": "Failed", "error": "RuntimeError: short"})

    def test_the_end_of_a_script_is_done_unless_it_failed(self):
        hb._feed.clear()
        (self.ws / ".harness" / "build.json").unlink()
        hb._finish()
        self.assertFalse((self.ws / ".harness" / "build.json").exists(), "nothing ran, nothing to finish")
        hb._activity("Report written")
        hb._finish()
        self.assertEqual((self.feed()["state"], self.feed()["step"]), ("done", "Done"))
        hb._activity(state="failed")
        hb._finish()
        self.assertEqual(self.feed()["state"], "failed")

    def test_a_path_outside_the_workspace_stays_absolute(self):
        self.assertEqual(hb._rel(self.ws / "out" / "a.glb"), "out/a.glb")
        self.assertEqual(hb._rel(Path("/Users/example/elsewhere.glb")), "/Users/example/elsewhere.glb")


class Scene(Base):
    def test_fresh_is_an_empty_scene_in_millimetres(self):
        s = bpy.context.scene
        self.assertEqual(len(s.objects), 0)
        self.assertEqual((s.unit_settings.system, s.unit_settings.length_unit, s.render.engine), ("METRIC", "MILLIMETERS", "BLENDER_WORKBENCH"))
        self.assertAlmostEqual(hb._mm(), 1.0)
        self.assertIsNotNone(s.world)

    def test_bounds_are_what_renders(self):
        self.assertEqual(hb.bounds(), (Vector((0, 0, 0)), Vector((0, 0, 0))), "an empty scene is a point")
        self.cube(location=(10, 0, 0))
        cutter = self.cube("Cutter", size=100)
        cutter.hide_render = True
        self.assertEqual([o.name for o in hb.meshes()], ["Cube"])
        lo, hi = hb.bounds()
        self.assertEqual((tuple(round(v, 4) for v in lo), tuple(round(v, 4) for v in hi)), ((5, -5, -5), (15, 5, 5)))

    def test_frame_all_adds_one_camera_and_one_key_light_looking_at_the_model(self):
        self.cube(location=(10, 20, 5))
        cam = hb.frame_all()
        s = bpy.context.scene
        self.assertIs(s.camera, cam)
        bpy.context.view_layer.update()
        forward = cam.matrix_world.to_quaternion() @ Vector((0, 0, -1))
        towards = (Vector((10, 20, 5)) - cam.location).normalized()
        self.assertGreater(forward.dot(towards), 0.9999)
        distance = (cam.location - Vector((10, 20, 5))).length
        self.assertLess(cam.data.clip_start, distance)
        self.assertLess(distance, cam.data.clip_end)
        self.assertIs(hb.frame_all(azimuth=90), cam, "a second call moves the same camera")
        self.assertEqual([o.name for o in s.objects if o.type == "LIGHT"], ["Key"])

    def test_a_scene_with_its_own_light_gets_no_key(self):
        self.cube()
        light = bpy.data.objects.new("Lamp", bpy.data.lights.new("Lamp", "POINT"))
        bpy.context.scene.collection.objects.link(light)
        hb.frame_all()
        self.assertEqual([o.name for o in bpy.context.scene.objects if o.type == "LIGHT"], ["Lamp"])


class Renders(Base):
    def test_a_still_frames_the_scene_when_there_is_no_camera(self):
        self.cube()
        out = hb.render("out/preview.png", size=SIZE)
        self.assertEqual(out, self.ws / "out" / "preview.png")
        self.assertTrue(out.is_file())
        self.assertIsNotNone(bpy.context.scene.camera)
        self.assertEqual(self.feed()["step"], "Rendering preview.png (Workbench)")

    def test_a_cycles_still_on_the_cpu(self):
        self.cube()
        hb.render("out/beauty.png", size=SIZE, engine="CYCLES", samples=1)
        s = bpy.context.scene
        self.assertEqual((s.render.engine, s.cycles.samples, s.cycles.device), ("CYCLES", 1, "CPU"))
        self.assertEqual(self.feed()["step"], "Rendering beauty.png (Cycles)")
        self.assertTrue((self.ws / "out" / "beauty.png").is_file())

    def test_another_named_engine_keeps_cycles_settings_alone(self):
        self.cube()
        samples = bpy.context.scene.cycles.samples
        hb.render("out/p.png", size=SIZE, engine="BLENDER_WORKBENCH", samples=3)
        self.assertEqual(bpy.context.scene.cycles.samples, samples)

    def scene_as_found(self):
        self.cube()
        cam = hb.frame_all()
        s = bpy.context.scene
        s.frame_start, s.frame_end, s.render.fps = 5, 90, 24
        s.frame_set(7)
        bpy.context.preferences.edit.keyframe_new_interpolation_type = "BEZIER"
        return cam, cam.matrix_world.copy()

    def assert_scene_put_back(self, cam, matrix):
        s = bpy.context.scene
        self.assertIsNone(cam.parent)
        for a, b in zip(cam.matrix_world, matrix):
            for x, y in zip(a, b):
                self.assertAlmostEqual(x, y, places=4)
        self.assertNotIn("Pivot", bpy.data.objects)
        self.assertEqual((s.frame_start, s.frame_end, s.render.fps, s.frame_current), (5, 90, 24, 7))
        self.assertEqual(bpy.context.preferences.edit.keyframe_new_interpolation_type, "BEZIER")

    def test_a_turntable_is_an_mp4_and_the_scene_is_left_as_found(self):
        if hb._ffmpeg() is None:
            self.skipTest("no ffmpeg on PATH or in the venv")
        cam, matrix = self.scene_as_found()
        out = hb.turntable("out/turntable.mp4", seconds=0.3, fps=10, size=SIZE)
        self.assertTrue(out.is_file() and out.stat().st_size > 0)
        self.assertFalse((self.ws / "out" / "turntable-frames").exists(), "the frames are joined, then removed")
        self.assert_scene_put_back(cam, matrix)
        self.assertEqual(len(bpy.data.actions), 0, "the orbit's action goes with its pivot")
        self.assertEqual(self.feed()["step"], "Encoding turntable")

    def test_without_ffmpeg_the_frames_stay_and_say_so(self):
        cam, matrix = self.scene_as_found()
        frames = self.ws / "out" / "spin-frames"
        frames.mkdir(parents=True)
        (frames / "frame_0099.png").write_bytes(b"stale")
        printed = io.StringIO()
        with mock.patch.object(hb, "_ffmpeg", return_value=None), contextlib.redirect_stdout(printed):
            out = hb.turntable("out/spin.mp4", seconds=0.2, fps=10, size=SIZE)
        self.assertFalse(out.exists())
        self.assertEqual(sorted(p.name for p in frames.iterdir()), ["frame_0001.png", "frame_0002.png"])
        self.assertIn(f"warn no ffmpeg — turntable frames are in {frames}; run toolchain/setup.sh again", printed.getvalue())
        self.assert_scene_put_back(cam, matrix)

    def test_ffmpeg_is_the_machines_first(self):
        with mock.patch.object(hb.shutil, "which", return_value="/usr/local/bin/ffmpeg"):
            self.assertEqual(hb._ffmpeg(), "/usr/local/bin/ffmpeg")

    def test_ffmpeg_falls_back_to_the_one_imageio_ffmpeg_carries(self):
        carried = types.SimpleNamespace(get_ffmpeg_exe=lambda: "/venv/imageio_ffmpeg/binaries/ffmpeg")
        with mock.patch.object(hb.shutil, "which", return_value=None), mock.patch.dict(sys.modules, {"imageio_ffmpeg": carried}):
            self.assertEqual(hb._ffmpeg(), "/venv/imageio_ffmpeg/binaries/ffmpeg")

    def test_no_ffmpeg_anywhere_is_none(self):
        def missing():
            raise RuntimeError("no ffmpeg binary for this platform")
        with mock.patch.object(hb.shutil, "which", return_value=None), \
                mock.patch.dict(sys.modules, {"imageio_ffmpeg": types.SimpleNamespace(get_ffmpeg_exe=missing)}):
            self.assertIsNone(hb._ffmpeg())
        with mock.patch.object(hb.shutil, "which", return_value=None), mock.patch.dict(sys.modules, {"imageio_ffmpeg": None}):
            self.assertIsNone(hb._ffmpeg(), "not installed: the import itself fails")

    def test_a_turntable_shorter_than_a_frame_still_renders_one(self):
        self.cube()
        with mock.patch.object(hb, "_ffmpeg", return_value=None), mock.patch.object(hb, "_activity", wraps=hb._activity) as activity, contextlib.redirect_stdout(io.StringIO()):
            hb.turntable("out/blink.mp4", seconds=0.04, fps=10, size=SIZE)
        self.assertIn(mock.call("Rendering turntable 1/1", progress=1.0, force=False), activity.call_args_list,
                      "the progress handler ran (0 frames divided by zero in it)")
        self.assertEqual([p.name for p in (self.ws / "out" / "blink-frames").iterdir()], ["frame_0001.png"])

    def test_an_action_still_in_use_is_kept(self):
        self.cube()

        def keep(*_):
            for action in bpy.data.actions:
                action.use_fake_user = True

        bpy.app.handlers.render_pre.append(keep)
        try:
            with mock.patch.object(hb.shutil, "which", return_value=None), contextlib.redirect_stdout(io.StringIO()):
                hb.turntable("out/t.mp4", seconds=0.1, fps=10, size=SIZE)
        finally:
            bpy.app.handlers.render_pre.remove(keep)
        self.assertNotIn("Pivot", bpy.data.objects)
        self.assertEqual(len(bpy.data.actions), 1)


class Exports(Base):
    def build(self):
        body = self.cube("Body")
        clay = bpy.data.materials.new("Clay")
        body.data.materials.append(clay)
        body.data.materials.append(None)
        bpy.data.materials.new("Spare")                       # no users: not in the extras
        body.modifiers.new("Bevel", "BEVEL")
        lid = self.cube("Lid", size=4, location=(0, 0, 8))
        lid.parent = body
        off = lid.modifiers.new("Hidden", "BEVEL")
        off.show_render = False
        parts = bpy.data.collections.new("Parts")
        bpy.context.scene.collection.children.link(parts)
        handle = self.cube("Handle", size=2, location=(8, 0, 0))
        bpy.context.scene.collection.objects.unlink(handle)
        parts.objects.link(handle)
        bpy.data.collections.new("Loose")                     # not in the scene
        marker = bpy.data.objects.new("Marker", None)
        bpy.context.scene.collection.objects.link(marker)
        hb.frame_all()
        body["harness"] = {"mine": 1}
        lid["harness"] = [1, 2]
        handle["harness"] = "theirs"
        return body

    def test_a_glb_carries_the_facts_as_extras_and_the_scene_is_left_clean(self):
        body = self.build()
        out = hb.export_glb("out/model.glb")
        self.assertEqual(sorted(p.name for p in out.parent.iterdir()), ["model.glb"], "no partial file left behind")
        doc = glb_json(out)
        scene = doc["scenes"][0]["extras"]["harness"]
        self.assertEqual((scene["units"], scene["metres_per_unit"], scene["camera"]), ("millimeters", 0.001, "Camera"))
        self.assertEqual(list(scene["materials"]), ["Clay"])
        nodes = {n["name"]: (n.get("extras") or {}).get("harness") for n in doc["nodes"]}
        self.assertEqual(nodes["Body"]["modifiers"], [{"name": "Bevel", "type": "BEVEL"}])
        self.assertEqual((nodes["Body"]["materials"], nodes["Body"]["faces"]), (["Clay"], 26), "faces after the bevel: the evaluated mesh")
        self.assertEqual(nodes["Body"]["dimensions_mm"], [10.0, 10.0, 10.0])
        self.assertEqual(nodes["Lid"]["parent"], "Body")
        self.assertNotIn("modifiers", nodes["Lid"])
        self.assertEqual(nodes["Handle"]["collections"], ["Parts"])
        self.assertEqual(nodes["Parts"], {"type": "COLLECTION"})
        self.assertEqual(nodes["Camera"]["camera"]["scene_camera"], True)
        self.assertEqual(nodes["Key"]["light"]["type"], "SUN")
        self.assertEqual(nodes["Marker"]["type"], "EMPTY")
        self.assertFalse({"light", "camera", "faces"} & set(nodes["Marker"]))
        self.assertEqual(body["harness"].to_dict(), {"mine": 1}, "a property that was there is put back, not what reused its memory")
        self.assertEqual((bpy.data.objects["Lid"]["harness"].to_list(), bpy.data.objects["Handle"]["harness"]), ([1, 2], "theirs"))
        self.assertNotIn("harness", bpy.context.scene)
        self.assertNotIn("harness", bpy.data.objects["Camera"])
        self.assertEqual((self.feed()["step"], self.feed()["exported"]), ("Exported model.glb", "out/model.glb"))
        hb.export_glb("out/model.glb")
        self.assertEqual(hb._exported, ["out/model.glb"], "an export named twice is listed once")

    def test_a_gltf_is_one_embedded_file_and_the_preference_is_put_back(self):
        self.cube()
        prefs = bpy.context.preferences.addons["io_scene_gltf2"].preferences
        self.assertFalse(prefs.allow_embedded_format)
        out = hb.export_glb("out/model.gltf", cameras=False, lights=False)
        self.assertEqual(sorted(p.name for p in out.parent.iterdir()), ["model.gltf"])
        doc = json.loads(out.read_text())
        self.assertTrue(doc["buffers"][0]["uri"].startswith("data:"))
        self.assertFalse(prefs.allow_embedded_format)

    def test_a_scene_without_units_says_unit(self):
        self.cube()
        bpy.context.scene.unit_settings.system = "NONE"
        doc = glb_json(hb.export_glb("out/model.glb"))
        self.assertEqual(doc["scenes"][0]["extras"]["harness"]["units"], "unit")

    def test_an_export_outside_the_workspace_is_named_absolutely(self):
        self.cube()
        with tempfile.TemporaryDirectory() as other:
            out = hb.export_glb(Path(other) / "shared.glb")
            self.assertEqual(hb._exported, [str(out)])

    def test_unstamp_tolerates_a_missing_property_and_a_removed_object(self):
        kept = self.cube("Kept")
        gone = self.cube("Gone")
        bpy.data.objects.remove(gone, do_unlink=True)
        hb._unstamp([(kept, None), (gone, None)])
        self.assertNotIn("harness", kept)

    def test_stl(self):
        self.cube()
        out = hb.export_stl("out/model.stl")
        self.assertGreater(out.stat().st_size, 84)
        self.assertEqual(self.feed()["step"], "Exporting model.stl")


class Report(Base):
    def test_what_was_built_is_reported(self):
        a = self.cube("A")
        a.data.materials.append(bpy.data.materials.new("Clay"))
        b = self.cube("B", location=(20, 0, 0))
        parts = bpy.data.collections.new("Parts")
        bpy.context.scene.collection.children.link(parts)
        parts.objects.link(b)
        self.cube("Cutter", size=100).hide_render = True
        hb.frame_all()
        hb.export_glb("out/lamp.glb")
        hb.render("out/preview.png", size=SIZE)
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            data = hb.report()
        self.assertEqual(json.loads((self.ws / "out" / "report.json").read_text()), data)
        self.assertEqual((data["objects"], data["vertices"], data["faces"]), (["A", "B"], 16, 12))
        self.assertEqual(data["size_mm"], [30.0, 10.0, 10.0])
        self.assertEqual((data["materials"], data["collections"], data["cameras"], data["lights"]), (["Clay"], ["Parts"], ["Camera"], ["Key"]))
        self.assertEqual(data["files"], {"preview": "out/preview.png", "glb": "out/lamp.glb"})
        self.assertEqual(data["blender"], bpy.app.version_string)
        self.assertTrue(printed.getvalue().startswith("2 objects · 16 verts · 12 faces · [30.0, 10.0, 10.0] mm"))
        self.assertEqual(self.feed()["step"], "Report written")

    def test_one_object_nothing_exported(self):
        self.cube()
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            data = hb.report("elsewhere/report.json")
        self.assertTrue((self.ws / "elsewhere" / "report.json").is_file())
        self.assertEqual(data["files"], {}, "out/model.glb is only named when it exists")
        self.assertTrue(printed.getvalue().startswith("1 object · 8 verts"))


if __name__ == "__main__":
    unittest.main()
