"""Reproduce a viewer's saved What if experiment with native MuJoCo, without a renderer.

    "$MUJOCO_PYTHON" "$MUJOCO_TOOLCHAIN/experiments.py" physics-experiment.json \
        --output out/experiment-reproduction.json

The export includes the source model and assets. Use the same MuJoCo version. To test a revision,
pass --model; for an agent-compiled rollout, use its rollout.model.xml and --assets-from pointing
at the original MJCF's directory. The saved patch is applied before the starting state. The
report compares native states against saved browser measurements; differences are reported.
"""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import tempfile

import mujoco
import numpy as np


def reproduce(model, experiment):
    """Run both futures, retaining the caller's gravity/friction. The supplied model is already patched."""
    if experiment.get("kind") != "mujoco-counterfactual" or experiment.get("version") != 1:
        raise ValueError("Expected a version 1 MuJoCo counterfactual export")
    if experiment.get("mujocoVersion") != mujoco.mj_versionString():
        raise ValueError(f"Use MuJoCo {experiment.get('mujocoVersion')}; this runtime is {mujoco.mj_versionString()}")
    dt = float(experiment["timestep"])
    if abs(model.opt.timestep - dt) > 1e-12 or dt <= 0:
        raise ValueError("The model timestep differs from the saved experiment")
    body = int(experiment["body"])
    if not 0 < body < model.nbody:
        raise ValueError("The followed body is missing from this model")
    if mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body) not in (None, experiment["bodyName"]):
        raise ValueError("The followed body does not match this model")
    snapshot = experiment["startingState"]
    state = np.asarray(snapshot["values"], dtype=float)
    if state.size != mujoco.mj_stateSize(model, snapshot["spec"]) or not np.isfinite(state).all():
        raise ValueError("The starting state does not match this model")
    original = experiment["originalPhysics"]
    gravity = np.asarray(original["gravity"], dtype=float).reshape(model.opt.gravity.shape)
    friction = np.asarray(original["geomFriction"], dtype=float).reshape(model.geom_friction.shape)
    pairs = np.asarray(original["pairFriction"], dtype=float).reshape(model.pair_friction.shape)
    override = np.asarray(original.get("overrideFriction", model.opt.o_friction), dtype=float).reshape(model.opt.o_friction.shape)
    change = experiment["change"]
    values = [change["gravityScale"], change["frictionScale"], change["pushNewtons"], experiment["duration"]]
    if not np.isfinite(values).all() or not 0 <= values[0] <= 3 or not 0 <= values[1] <= 3 or abs(values[2]) > 100 or not 0 < values[3] <= 10.01:
        raise ValueError("Experiment conditions are outside the viewer's limits")
    steps = round(experiment["duration"] / dt)
    if not 1 <= steps <= 100_000:
        raise ValueError("Experiment exceeds the step budget")
    stride = max(1, int(np.ceil(steps / 180)))
    control = experiment["controls"]
    tape = control.get("tape") if control["kind"] == "recorded-open-loop" else None
    if tape:
        controls = np.asarray(tape["ctrl"], dtype=float)
        if controls.ndim != 2 or controls.shape[1] != model.nu or len(controls) < 1 or not np.isfinite(controls).all() or tape["dt"] <= 0:
            raise ValueError("Invalid recorded control tape")
    saved = (model.opt.gravity.copy(), model.geom_friction.copy(), model.pair_friction.copy(), model.opt.o_friction.copy())
    output = {}
    try:
        for lane in ("baseline", "variant"):
            changed = lane == "variant"
            model.opt.gravity[:] = gravity * (change["gravityScale"] if changed else 1)
            model.geom_friction[:] = friction * (change["frictionScale"] if changed else 1)
            model.pair_friction[:] = pairs * (change["frictionScale"] if changed else 1)
            model.opt.o_friction[:] = override * (change["frictionScale"] if changed else 1)
            data = mujoco.MjData(model)
            mujoco.mj_setState(model, data, state, snapshot["spec"])
            base_force = data.xfrc_applied[body, 0]
            frames = []

            def sample():
                mujoco.mj_forward(model, data)
                frames.append({"t": data.time - snapshot["time"], "position": data.xipos[body].tolist(), "qpos": data.qpos.tolist()})

            sample()
            for step in range(steps):
                if tape:
                    u = np.clip((data.time - tape["time0"]) / tape["dt"], 0, len(controls) - 1)
                    k = int(u)
                    data.ctrl[:] = controls[k] + (controls[min(k + 1, len(controls) - 1)] - controls[k]) * (u - k)
                data.xfrc_applied[body, 0] = base_force + (change["pushNewtons"] if changed and step * dt < .15 else 0)
                before = data.time
                mujoco.mj_step(model, data)
                if data.time <= before or not np.isfinite(data.qpos).all():
                    raise ValueError("Native simulation became unstable")
                if (step + 1) % stride == 0 or step + 1 == steps:
                    sample()
            expected = experiment[lane]["frames"]
            if len(frames) != len(expected):
                raise ValueError("Saved frame count does not match this experiment's sampling")
            q_error = max(float(np.max(np.abs(np.asarray(a["qpos"]) - b["qpos"]))) for a, b in zip(frames, expected))
            position_error = max(float(np.linalg.norm(np.asarray(a["position"]) - b["position"])) for a, b in zip(frames, expected))
            output[lane] = {"frames": frames, "maxQposError": q_error, "maxPositionErrorMeters": position_error}
    finally:
        model.opt.gravity[:], model.geom_friction[:], model.pair_friction[:], model.opt.o_friction[:] = saved
    return {"kind": "mujoco-experiment-reproduction", "mujocoVersion": mujoco.mj_versionString(), **output}


def load_model(experiment, model_path=None, assets_from=None):
    """A saved model bundle is local data, never permission to write outside the scratch directory."""
    if model_path:
        if assets_from:
            spec = mujoco.MjSpec.from_file(str(model_path))
            for field in ("meshdir", "texturedir"):
                setattr(spec, field, str(assets_from.resolve() / (getattr(spec, field) or "")))
            return spec.compile()
        return mujoco.MjModel.from_xml_path(str(model_path))
    source = experiment.get("source", {})
    if not source.get("files"):
        raise ValueError("This export has no model bundle; supply --model with the original MJCF")
    with tempfile.TemporaryDirectory(prefix="mujoco-experiment-") as folder:
        root = Path(folder).resolve()

        def inside(name):
            path = (root / name).resolve()
            if not path.is_relative_to(root) or path == root:
                raise ValueError("A model bundle path escapes its directory")
            return path

        for item in source["files"]:
            path = inside(item["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(base64.b64decode(item["base64"], validate=True))
        model_path = inside(source["model"])
        if source.get("modelXml"):
            # The browser compiles the snapshot in the original model's directory so relative
            # includes, meshdir and texturedir continue to refer to the same bundled assets.
            snapshot = model_path.parent / "__harness_rollout_model__.xml"
            snapshot.write_bytes(inside(source["modelXml"]).read_bytes())
            model_path = snapshot
        return mujoco.MjModel.from_xml_path(str(model_path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment", type=Path)
    parser.add_argument("--model", type=Path, help="Use a different MJCF instead of the bundled model")
    parser.add_argument("--assets-from", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tolerance", type=float, default=1e-6)
    args = parser.parse_args()
    if not np.isfinite(args.tolerance) or args.tolerance <= 0:
        parser.error("--tolerance must be a positive finite number")
    experiment = json.loads(args.experiment.read_text())
    model = load_model(experiment, args.model, args.assets_from)
    for key, value in experiment.get("source", {}).get("modelPatch", {}).items():
        owner, field = (model.opt, key[4:]) if key.startswith("opt.") else (model, key)
        current = getattr(owner, field)
        if isinstance(current, np.ndarray):
            current[:] = np.asarray(value).reshape(current.shape)
        else:
            setattr(owner, field, value)
    mujoco.mj_setConst(model, mujoco.MjData(model))
    report = reproduce(model, experiment)
    report["tolerance"] = args.tolerance
    report["matches"] = all(report[lane]["maxQposError"] <= args.tolerance and report[lane]["maxPositionErrorMeters"] <= args.tolerance for lane in ("baseline", "variant"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"{'Matched' if report['matches'] else 'Different'}: {args.output}")
    return 0 if report["matches"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
