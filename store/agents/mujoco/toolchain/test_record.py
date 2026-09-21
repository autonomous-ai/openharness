"""record() writes what the MuJoCo Viewer pane needs to run a rollout live. Needs mujoco (the venv):

    "$MUJOCO_PYTHON" -m unittest toolchain/test_record.py
"""
import contextlib, importlib, io, json, math, os, sys, tempfile, types, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
try:
    import mujoco  # noqa: F401
    import numpy as np
except ImportError:  # the verdict tests run without mujoco; these cannot
    mujoco = None

SCENE = """<mujoco model="cart">
  <option timestep="0.002"/>
  <worldbody>
    <light pos="0 0 3"/>
    <camera name="side" pos="0 -2 .4" xyaxes="1 0 0 0 0 1"/>
    <geom type="plane" size="2 2 .1"/>
    <body name="cart" pos="0 0 .1">
      <joint name="slide" type="slide" axis="1 0 0"/>
      <geom type="box" size=".1 .1 .05" mass="1"/>
    </body>
  </worldbody>
  <actuator><motor name="push" joint="slide" gear="1" ctrlrange="-5 5"/></actuator>
  <keyframe><key name="rest" qpos="0" ctrl="0"/></keyframe>
</mujoco>
"""

# A Menagerie-shaped robot, in MuJoCo's default degrees: a hip hinge with a range and a torque motor,
# a wheel with no range, a slide driven by a motor with no ctrlrange and by a servo, a tendon motor,
# and a mesh under the robot's own meshdir.
ROBOT = """<mujoco model="bot">
  <compiler meshdir="assets"/>
  <option timestep="0.002"/>
  <asset><mesh name="tet" file="tet.obj"/></asset>
  <worldbody>
    <light pos="0 0 3"/>
    <body name="base" pos="0 0 .5">
      <joint name="hip" type="hinge" axis="0 1 0" range="-90 90"/>
      <geom type="capsule" fromto="0 0 0 0 0 -.3" size=".04" mass="1"/>
      <geom type="mesh" mesh="tet" mass=".05"/>
      <body name="wheel" pos="0 0 -.3">
        <joint name="spin" type="hinge" axis="0 1 0"/>
        <geom type="cylinder" size=".05 .02" mass=".2"/>
      </body>
      <body name="slider" pos=".1 0 0">
        <joint name="slide" type="slide" axis="1 0 0" range="-0.1 0.1"/>
        <geom type="box" size=".02 .02 .02" mass=".1"/>
      </body>
    </body>
  </worldbody>
  <tendon><fixed name="hip_tendon"><joint joint="hip" coef="1"/></fixed></tendon>
  <actuator>
    <motor name="hip" joint="hip" ctrlrange="-20 20"/>
    <motor name="spin" joint="spin" ctrlrange="-3 3"/>
    <motor name="slide" joint="slide"/>
    <position name="slide_servo" joint="slide" kp="30"/>
    <motor name="pull" tendon="hip_tendon" ctrlrange="-1 1"/>
  </actuator>
  <keyframe><key name="home" qpos="0.4 0 0.05" ctrl="0.4 0 0 0.05 0.25"/></keyframe>
</mujoco>
"""
TET = "v 0 0 0\nv .05 0 0\nv 0 .05 0\nv 0 0 .05\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n"


@unittest.skipIf(mujoco is None, "mujoco is not installed in this interpreter")
class Record(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self.tmp.name).resolve()
        (self.ws / "scenes").mkdir()
        (self.ws / "scenes" / "cart.xml").write_text(SCENE)
        self.cwd = os.getcwd()
        os.chdir(self.ws)
        os.environ["HARNESS_WORKSPACE"] = str(self.ws)
        for name in ("harness_mujoco", "verdict"):
            sys.modules.pop(name, None)
        self.hm = importlib.import_module("harness_mujoco")

    def tearDown(self):
        os.chdir(self.cwd)
        os.environ.pop("HARNESS_WORKSPACE", None)
        self.tmp.cleanup()

    def rollout(self):
        return json.loads((self.ws / "out" / "rollout.qpos.json").read_text())

    def verdict(self):
        return json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def quietly(self, fn, *args, **kwargs):
        """Call fn with stdout and stderr captured; returns (result, stdout, stderr)."""
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = fn(*args, **kwargs)
        return result, out.getvalue(), err.getvalue()

    def test_the_trajectory_carries_state_and_controls_frame_by_frame(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        report = self.hm.record(model, data, lambda m, d, t: d.ctrl.__setitem__(0, 2.0 if t < 0.5 else -2.0), seconds=1.0, fps=25, video=False)
        t = self.rollout()
        self.assertEqual(t["status"], "done")
        self.assertEqual(t["model"], "scenes/cart.xml")
        self.assertIsNone(t["model_xml"], "loaded from a file: the file is the model")
        self.assertEqual(len(t["qpos"]), 26, "the first state, then one row per frame")
        self.assertEqual(len(t["qvel"]), 26)
        self.assertEqual(len(t["ctrl"]), 26)
        self.assertEqual(t["ctrl"][0], [2.0])
        self.assertEqual(t["ctrl"][-2], [-2.0])
        self.assertAlmostEqual(t["dt"], 20 * 0.002, msg="the frame period is whole steps, not 1/fps")
        self.assertAlmostEqual(t["time"][1] - t["time"][0], t["dt"], places=6)
        self.assertIsNone(t["video"])
        self.assertNotIn("act", t, "no actuator dynamics, no act column")
        self.assertEqual(report["trajectory"], "out/rollout.qpos.json")
        verdict = self.verdict()
        self.assertTrue(verdict["ready"], "record() refreshes the verdict")
        self.assertEqual(verdict["artifact"], "out/rollout.qpos.json")

    def test_a_spec_edited_model_is_saved_as_compiled(self):
        spec = mujoco.MjSpec.from_file("scenes/cart.xml")
        spec.actuators[0].set_to_position(kp=50, kv=5)
        model = spec.compile()
        data = mujoco.MjData(model)
        del spec  # a spec built in a helper is gone by the time record() runs
        self.hm.record(model, data, None, seconds=0.2, video=False)
        t = self.rollout()
        self.assertEqual(t["model"], "scenes/cart.xml")
        self.assertEqual(t["model_xml"], "out/rollout.model.xml")
        snapshot = mujoco.MjModel.from_xml_path(str(self.ws / "out" / "rollout.model.xml"))
        self.assertEqual(snapshot.actuator_biastype[0], mujoco.mjtBias.mjBIAS_AFFINE, "the snapshot has the servo, not the motor")
        self.assertEqual(t["model_patch"], {})
        stamp = (self.ws / "out" / "rollout.model.xml").stat().st_mtime_ns
        spec2 = mujoco.MjSpec.from_file("scenes/cart.xml")
        spec2.actuators[0].set_to_position(kp=50, kv=5)
        model2 = spec2.compile()
        self.hm.record(model2, mujoco.MjData(model2), None, seconds=0.1, video=False)
        self.assertEqual((self.ws / "out" / "rollout.model.xml").stat().st_mtime_ns, stamp, "an unchanged model is not rewritten")

    def test_runtime_edits_ride_along_as_a_patch(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        model.opt.timestep = 0.001
        model.dof_damping[0] = 3.0
        self.hm.record(model, data, None, seconds=0.1, video=False)
        patch = self.rollout()["model_patch"]
        self.assertEqual(patch["opt.timestep"], 0.001)
        self.assertEqual(patch["dof_damping"], [3.0])

    def test_servos_and_pd_hold_keep_a_pose(self):
        xml = SCENE.replace('<key name="rest" qpos="0" ctrl="0"/>', '<key name="rest" qpos="0.3" ctrl="0.3"/>')
        (self.ws / "scenes" / "cart.xml").write_text(xml)
        model, data = self.hm.load_xml("scenes/cart.xml")
        data.qpos[0] = 0.0
        self.hm.record(model, data, self.hm.pd_hold(kp=80, kd=10), seconds=2.0, video=False)
        self.assertAlmostEqual(self.rollout()["qpos"][-1][0], 0.3, delta=0.02, msg="PD torque on a motor reaches the keyframe pose")

    def test_an_unknown_model_cannot_be_replayed_and_says_so(self):
        model = mujoco.MjModel.from_xml_string(SCENE)
        data = mujoco.MjData(model)
        report, printed, _ = self.quietly(self.hm.record, model, data, None, seconds=0.1, video=False)
        self.assertIsNone(report["trajectory"])
        self.assertFalse((self.ws / "out" / "rollout.qpos.json").exists())
        self.assertIn("the pane cannot simulate this rollout", printed)

    # ---- the video ------------------------------------------------------------------------------

    def test_a_video_from_the_free_camera_following_a_body(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        report, printed, _ = self.quietly(self.hm.record, model, data, None, seconds=0.1, fps=20, width=64, height=48, track="cart")
        video = self.ws / "out" / "rollout.mp4"
        self.assertGreater(video.stat().st_size, 0)
        self.assertEqual(report["video"], "out/rollout.mp4")
        t = self.rollout()
        self.assertEqual((t["video"], t["track"], t["camera"]), ("out/rollout.mp4", "cart", None))
        self.assertIn("video out/rollout.mp4", printed)

    def test_a_video_from_a_named_camera(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        report, _, _ = self.quietly(self.hm.record, model, data, None, seconds=0.1, fps=20, width=64, height=48, camera="side", out="out/side.mp4")
        self.assertGreater((self.ws / "out" / "side.mp4").stat().st_size, 0)
        self.assertEqual(self.rollout()["camera"], "side")
        self.assertEqual(report["video"], "out/side.mp4")

    def test_a_camera_or_body_the_model_does_not_have_means_no_video_not_a_dead_process(self):
        # Before: MuJoCo exited the whole interpreter at the first frame ("fixed camera id is outside
        # valid range"), leaving the trajectory at "recording" for good.
        for kwargs, said in (({"camera": "front"}, "no camera named 'front'"), ({"track": "torso"}, "no body named 'torso'")):
            with self.subTest(**kwargs):
                model, data = self.hm.load_xml("scenes/cart.xml")
                report, _, err = self.quietly(self.hm.record, model, data, None, seconds=0.1, width=64, height=48, **kwargs)
                self.assertIn(said, err)
                self.assertIsNone(report["video"])
                self.assertEqual(self.rollout()["status"], "done")

    def test_no_gl_means_no_video_and_the_rollout_still_records(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        with mock.patch.object(self.hm.mujoco, "Renderer", side_effect=RuntimeError("no OpenGL context")):
            report, _, err = self.quietly(self.hm.record, model, data, None, seconds=0.1)
        self.assertIn("note: no video (no OpenGL context)", err)
        self.assertIsNone(report["video"])
        self.assertEqual(self.rollout()["status"], "done")

    def test_a_writer_that_cannot_start_closes_the_renderer(self):
        import imageio.v2 as imageio
        closed, alive = [], []

        class Renderer(mujoco.Renderer):
            def __init__(self, *args):
                super().__init__(*args)
                alive.append(self)  # held here, so a close on garbage collection cannot stand in for record()'s

            def close(self):
                closed.append(True)
                super().close()

        model, data = self.hm.load_xml("scenes/cart.xml")
        with mock.patch.object(self.hm.mujoco, "Renderer", Renderer), mock.patch.object(imageio, "get_writer", side_effect=OSError("no ffmpeg")):
            report, _, err = self.quietly(self.hm.record, model, data, None, seconds=0.1, width=64, height=48)
        self.assertIn("no ffmpeg", err)
        self.assertEqual(closed, [True])
        self.assertIsNone(report["video"])

    # ---- how a rollout ends ---------------------------------------------------------------------

    def test_divergence_is_caught_although_mujoco_resets_the_state(self):
        # MuJoCo puts a NaN state back to the initial one and only warns: before, qpos was finite
        # again by the time record() looked, and a diverged rollout was reported stable and ready.
        model, data = self.hm.load_xml("scenes/cart.xml")

        def blow_up(m, d, t):
            if t > 0.1:
                d.qvel[0] = math.nan

        report, printed, _ = self.quietly(self.hm.record, model, data, blow_up, seconds=1.0, video=False)
        self.assertTrue(report["nan"])
        self.assertIn("NaN — diverged", printed)
        self.assertEqual(self.rollout()["status"], "diverged")
        self.assertLess(len(self.rollout()["qpos"]), 31, "the rollout stops where it diverged")
        verdict = self.verdict()
        self.assertFalse(verdict["ready"])
        self.assertEqual(verdict["phases"][1]["state"], "failed")

    def test_divergence_without_autoreset_is_a_non_finite_qpos(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        model.opt.disableflags |= int(mujoco.mjtDisableBit.mjDSBL_AUTORESET)
        report, _, _ = self.quietly(self.hm.record, model, data, lambda m, d, t: d.qpos.__setitem__(0, math.inf), seconds=0.2, video=False)
        self.assertTrue(report["nan"])

    def test_a_controller_that_raises_ends_the_recording_as_failed(self):
        # Before: the trajectory stayed "recording" and the header said "recording cart.xml" forever.
        model, data = self.hm.load_xml("scenes/cart.xml")

        def broken(m, d, t):
            if t > 0.1:
                raise RuntimeError("boom")

        with self.assertRaises(RuntimeError), contextlib.redirect_stdout(io.StringIO()):
            self.hm.record(model, data, broken, seconds=1.0, video=False)
        t = self.rollout()
        self.assertEqual((t["status"], t["error"]), ("failed", "RuntimeError: boom"))
        self.assertGreater(len(t["qpos"]), 1, "what was recorded stays replayable")
        verdict = self.verdict()
        self.assertFalse(verdict["ready"])
        self.assertEqual([p["state"] for p in verdict["phases"]], ["done", "failed", "pending"])
        self.assertTrue(verdict["summary"].startswith("stopped cart.xml · "), verdict["summary"])
        self.assertIn("RuntimeError: boom", verdict["findings"][0]["message"])

    def test_an_unreplayable_rollout_that_raises_writes_nothing_for_the_pane(self):
        model = mujoco.MjModel.from_xml_string(SCENE)
        with self.assertRaises(KeyboardInterrupt):
            self.hm.record(model, mujoco.MjData(model), lambda m, d, t: (_ for _ in ()).throw(KeyboardInterrupt()), seconds=0.1, video=False)
        self.assertFalse((self.ws / "out" / "rollout.qpos.json").exists())

    def test_actuator_dynamics_and_a_model_with_nothing_to_move(self):
        (self.ws / "scenes" / "filter.xml").write_text(SCENE.replace(
            '<motor name="push" joint="slide" gear="1" ctrlrange="-5 5"/>',
            '<general name="push" joint="slide" dyntype="filter" dynprm=".05" ctrlrange="-5 5"/>').replace('ctrl="0"', 'ctrl="0" act="0"'))
        model, data = self.hm.load_xml("scenes/filter.xml")
        self.quietly(self.hm.record, model, data, lambda m, d, t: d.ctrl.__setitem__(0, 1.0), seconds=0.1, fps=50, video=False)
        t = self.rollout()
        self.assertEqual(t["na"], 1)
        self.assertEqual(len(t["act"]), len(t["qpos"]))
        self.assertGreater(t["act"][-1][0], 0.0, "the filter state moves toward the control")

        (self.ws / "scenes" / "still.xml").write_text('<mujoco><worldbody><geom type="sphere" size=".1"/></worldbody></mujoco>')
        model, data = self.hm.load_xml("scenes/still.xml")
        report, _, _ = self.quietly(self.hm.record, model, data, None, seconds=0.1, fps=50, video=False)
        self.assertEqual((report["max_qvel"], report["model"]["nv"], report["ctrl_recorded"]), (0.0, 0, False))
        self.assertEqual(self.rollout()["qpos"][0], [])

    # ---- the model the pane loads ---------------------------------------------------------------

    def test_a_model_built_from_scratch_is_its_snapshot(self):
        spec = mujoco.MjSpec()
        body = spec.worldbody.add_body(name="ball", pos=[0, 0, 1])
        body.add_freejoint()
        body.add_geom(type=mujoco.mjtGeom.mjGEOM_SPHERE, size=[0.1, 0, 0])
        model = spec.compile()
        self.quietly(self.hm.record, model, mujoco.MjData(model), None, seconds=0.1, video=False)
        t = self.rollout()
        self.assertEqual((t["model"], t["model_xml"]), ("out/rollout.model.xml", "out/rollout.model.xml"))
        self.assertTrue((self.ws / "out" / "rollout.model.xml").exists())

    def test_a_snapshot_that_does_not_compile_is_never_named(self):
        # Before: the model was left naming out/rollout.model.xml, the file just deleted.
        spec = mujoco.MjSpec()
        spec.worldbody.add_geom(type=mujoco.mjtGeom.mjGEOM_SPHERE, size=[0.1, 0, 0])
        model = spec.compile()
        with mock.patch.object(self.hm, "_compile_snapshot", side_effect=ValueError("mesh not found")):
            report, _, err = self.quietly(self.hm.record, model, mujoco.MjData(model), None, seconds=0.1, video=False)
        self.assertIn("could not save the compiled model for the pane (mesh not found)", err)
        self.assertFalse((self.ws / "out" / "rollout.model.xml").exists())
        self.assertIsNone(report["model_path"])
        self.assertIsNone(report["trajectory"], "nothing the pane could load")

    def test_a_spec_that_cannot_be_written_back_falls_back_to_its_file(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        (self.ws / "out").mkdir()
        (self.ws / "out" / "rollout.model.xml").write_text("<mujoco/>")  # a stale snapshot of an older run

        class Unwritable:
            def to_xml(self):
                raise RuntimeError("to_xml is not supported for this spec")

        self.hm._MODEL_SPECS[model] = Unwritable()
        _, _, err = self.quietly(self.hm.record, model, data, None, seconds=0.1, video=False)
        self.assertIn("it will load scenes/cart.xml", err)
        t = self.rollout()
        self.assertEqual((t["model"], t["model_xml"]), ("scenes/cart.xml", None))
        self.assertFalse((self.ws / "out" / "rollout.model.xml").exists())

    def test_no_reference_to_compare_against_means_no_patch(self):
        (self.ws / "scenes" / "broken.xml").write_text("<mujoco><worldbody><geom/></worldbody")
        for path in ("scenes/missing.xml", "scenes/broken.xml"):
            with self.subTest(model_path=path):
                model, data = self.hm.load_xml("scenes/cart.xml")
                model.opt.timestep = 0.001
                self.quietly(self.hm.record, model, data, None, seconds=0.05, video=False, model_path=path)
                t = self.rollout()
                self.assertEqual((t["model"], t["model_patch"]), (path, {}))
        model, data = self.hm.load_xml("scenes/cart.xml")
        model.opt.timestep = 0.001
        with mock.patch.object(self.hm, "_model_patch", side_effect=ValueError("shapes")):
            self.quietly(self.hm.record, model, data, None, seconds=0.05, video=False)
        self.assertEqual(self.rollout()["model_patch"], {})

    def test_patch_fields_this_mujoco_does_not_have_are_skipped(self):
        model, _ = self.hm.load_xml("scenes/cart.xml")
        reference, _ = self.hm.load_xml("scenes/cart.xml")
        model.opt.gravity[2] = -1.6
        model.dof_damping[0] = 2.0
        with mock.patch.object(self.hm, "_PATCH_OPTION", ("gravity", "timestep", "warp_iterations")), \
             mock.patch.object(self.hm, "_PATCH_FIELDS", ("dof_damping", "key_act", "geom_fluidcoef_v2")):
            self.assertEqual(self.hm._model_patch(model, reference), {"opt.gravity": [0.0, 0.0, -1.6], "dof_damping": [2.0]})

    # ---- Menagerie ------------------------------------------------------------------------------

    def menagerie(self) -> Path:
        root = self.ws.parent / f"{self.ws.name}-menagerie"
        (root / "bot" / "assets").mkdir(parents=True)
        (root / "bot" / "scene.xml").write_text(ROBOT)
        (root / "bot" / "assets" / "tet.obj").write_text(TET)
        (root / "notes").mkdir()
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        patcher = mock.patch.object(self.hm, "MENAGERIE", root)
        patcher.start()
        self.addCleanup(patcher.stop)
        return root

    def test_servos_take_each_joint_range_in_radians_and_leave_unlimited_joints_unclamped(self):
        self.menagerie()
        model, data = self.hm.load_menagerie("bot", servos=(50, 5))
        act = {mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_ACTUATOR, i): i for i in range(model.nu)}
        affine = mujoco.mjtBias.mjBIAS_AFFINE
        self.assertEqual([model.actuator_biastype[act[n]] == affine for n in ("hip", "spin", "slide", "slide_servo", "pull")],
                         [True, True, True, True, False], "every joint motor is a servo; a tendon motor is left alone")
        self.assertEqual(model.actuator_gainprm[act["hip"], 0], 50)
        self.assertEqual(model.actuator_gainprm[act["slide_servo"], 0], 30, "an existing servo keeps its gains")
        # Before: [-90, 90], a degree range read as radians.
        np.testing.assert_allclose(model.actuator_ctrlrange[act["hip"]], [-math.pi / 2, math.pi / 2])
        np.testing.assert_allclose(model.actuator_ctrlrange[act["hip"]], model.jnt_range[0])
        np.testing.assert_allclose(model.actuator_ctrlrange[act["slide"]], [-0.1, 0.1], err_msg="a slide's range is a length")
        # Before: limited to [-3, 3], the wheel's torque rating as an angle.
        self.assertFalse(model.actuator_ctrllimited[act["spin"]])
        np.testing.assert_allclose(model.actuator_forcerange[act["hip"]], [-20, 20], err_msg="the torque rating limits the servo's force")
        self.assertFalse(model.actuator_forcelimited[act["slide"]], "no rating, no force limit")
        np.testing.assert_allclose(data.qpos, model.key_qpos[0])
        self.assertEqual(self.hm.model_source(model), "menagerie/bot/scene.xml")

        self.quietly(self.hm.record, model, data, None, seconds=0.05, video=False)
        t = self.rollout()
        self.assertEqual((t["model"], t["model_xml"]), ("menagerie/bot/scene.xml", "out/rollout.model.xml"),
                         "the snapshot compiles against the robot's own meshdir")
        # MjSpec.to_xml writes five significant digits; the patch carries the exact radians back.
        self.assertLessEqual(set(t["model_patch"]), {"jnt_range", "actuator_ctrlrange"})
        np.testing.assert_allclose(t["model_patch"]["actuator_ctrlrange"][:2], [-math.pi / 2, math.pi / 2], rtol=0, atol=1e-8)

    def test_a_radian_robot_is_not_converted(self):
        root = self.menagerie()
        robot = ROBOT.replace('<compiler meshdir="assets"/>', '<compiler meshdir="assets" angle="radian"/>').replace('range="-90 90"', 'range="-1 1"')
        (root / "bot" / "scene.xml").write_text(robot.split("<keyframe>")[0] + "</mujoco>\n")
        model, data = self.hm.load_menagerie("bot", servos=(50, 5))
        np.testing.assert_allclose(model.actuator_ctrlrange[0], [-1, 1])
        np.testing.assert_allclose(data.qpos, model.qpos0, err_msg="no keyframe: the model's reference pose")

    def test_a_robot_as_shipped_and_one_that_is_not_there(self):
        self.menagerie()
        model, data = self.hm.load_menagerie("bot")
        self.assertEqual(model.actuator_biastype[0], mujoco.mjtBias.mjBIAS_NONE, "no servos asked for, the motors stay")
        self.assertEqual(self.hm.model_source(model), "menagerie/bot/scene.xml")
        with self.assertRaises(FileNotFoundError) as caught:
            self.hm.load_menagerie("unitree_go2")
        self.assertIn("robots available: bot", str(caught.exception))

    def test_pd_hold_drives_motors_and_hands_servos_and_tendons_their_keyframe(self):
        self.menagerie()
        model, data = self.hm.load_menagerie("bot")
        hold = self.hm.pd_hold(kp=100, kd=1)
        data.qpos[:] = [-0.4, 0.0, -0.5]
        data.qvel[:] = 0
        hold(model, data, 0.0)
        self.assertEqual(data.ctrl[0], 20.0, "PD torque clipped to the motor's ctrlrange")
        self.assertAlmostEqual(data.ctrl[2], 100 * (0.05 + 0.5), msg="no ctrlrange: the torque unclipped")
        self.assertAlmostEqual(data.ctrl[3], 0.05, msg="a servo gets the keyframe's control")
        self.assertAlmostEqual(data.ctrl[4], 0.25, msg="a tendon actuator gets the keyframe's control")

        (self.ws / "scenes" / "nokey.xml").write_text(SCENE.replace('<keyframe><key name="rest" qpos="0" ctrl="0"/></keyframe>', ""))
        model, data = self.hm.load_xml("scenes/nokey.xml")
        data.ctrl[0] = 1.5
        self.hm.pd_hold()(model, data, 0.0)
        self.assertEqual(data.ctrl[0], 1.5, "no keyframe, nothing to hold")

    # ---- where models come from -----------------------------------------------------------------

    def test_viewer_paths(self):
        root = self.menagerie()
        self.assertEqual(self.hm.viewer_path(root / "bot" / "scene.xml"), "menagerie/bot/scene.xml")
        self.assertEqual(self.hm.viewer_path("scenes/cart.xml"), "scenes/cart.xml")
        with tempfile.TemporaryDirectory() as elsewhere:
            self.assertIsNone(self.hm.viewer_path(Path(elsewhere) / "arm.xml"), "outside both, the pane cannot fetch it")
        with mock.patch.object(self.hm, "MENAGERIE", Path("")):
            self.assertIsNone(self.hm.viewer_path(root / "bot" / "scene.xml"), "no $MENAGERIE: not a Menagerie path")

    def test_models_that_cannot_be_remembered(self):
        model = mujoco.MjModel.from_xml_string(SCENE)
        with tempfile.TemporaryDirectory() as elsewhere:
            self.hm.remember_model(model, Path(elsewhere) / "cart.xml")
        self.assertIsNone(self.hm.model_source(model))
        self.hm.remember_model(42, "scenes/cart.xml")          # not weak-referenceable: silently not remembered
        self.assertIsNone(self.hm.model_source(42))
        self.assertEqual(self.hm._describe_model(42, None, self.ws), {"model": None, "model_xml": None, "model_patch": {}})

    def test_instrumenting_bindings_it_does_not_recognise_changes_nothing(self):
        hm = self.hm

        class NoCompile:
            from_file = staticmethod(lambda filename: None)

        with mock.patch.object(hm.mujoco, "MjSpec", NoCompile):
            hm._instrument()
            self.assertFalse(hasattr(NoCompile.from_file, "__wrapped_original__"))

        class Frozen(type):
            def __setattr__(cls, name, value):
                raise TypeError("immutable type")

        class Model(metaclass=Frozen):
            from_xml_path = staticmethod(lambda filename: "model")

        original = Model.from_xml_path
        with mock.patch.object(hm.mujoco, "MjModel", Model):
            hm._instrument()
        self.assertIs(Model.from_xml_path, original)

    def test_instrumented_loaders_return_what_mujoco_returned(self):
        hm = self.hm
        made = []

        class Compiled:  # weak-referenceable, as MjModel is
            pass

        class Spec:
            def __init__(self, weak=True):
                self.weak = weak

            @staticmethod
            def from_file(filename):
                return Spec() if "cart" in str(filename) else 7          # 7: not weak-referenceable

            def compile(self):
                model = Compiled() if self.weak else 8
                made.append(model)
                return model

        class Model:
            @staticmethod
            def from_xml_path(filename):
                return Compiled()

        with mock.patch.object(hm.mujoco, "MjSpec", Spec), mock.patch.object(hm.mujoco, "MjModel", Model):
            hm._instrument()
            loaded = Model.from_xml_path("scenes/cart.xml")
            self.assertEqual(hm.model_source(loaded), "scenes/cart.xml")
            self.assertEqual(Spec.from_file("scenes/other.xml"), 7)
            spec = Spec.from_file("scenes/cart.xml")
            model = spec.compile()
            self.assertEqual(hm.model_source(model), "scenes/cart.xml")
            self.assertIs(hm._MODEL_SPECS.get(model), spec)
            self.assertIsInstance(Spec(weak=True).compile(), Compiled, "a spec from nowhere compiles, unremembered")
            self.assertIsNone(hm.model_source(made[-1]))
            self.assertEqual(Spec(weak=False).compile(), 8)

    def test_a_verdict_that_fails_never_fails_the_script(self):
        toolchain = str(Path(self.hm.__file__).resolve().parent)
        broken = types.ModuleType("verdict")
        broken.main = mock.Mock(side_effect=RuntimeError("verdict exploded"))
        with mock.patch.dict(sys.modules, {"verdict": broken}):
            before = sys.path.count(toolchain)
            self.hm._refresh_verdict()
            self.assertEqual(sys.path.count(toolchain), before, "the toolchain dir is taken back off sys.path")
        broken.main.assert_called_once_with([])


if __name__ == "__main__":
    unittest.main()
