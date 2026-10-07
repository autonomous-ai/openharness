"""Go2 with position servos, named keyframes and a few sensors, built with MjSpec.

The compiled model (keyframes included) is what `record` saves as out/rollout.model.xml, so every
pose below can be loaded from the pane's keyframe list.
"""
import math
import os
from pathlib import Path

import mujoco
import numpy as np

SCENE = Path(os.environ["MENAGERIE"]) / "unitree_go2" / "scene.xml"
KP, KV = 60.0, 2.0

# Joint targets per leg: (hip, thigh, calf), in order FL, FR, RL, RR. Hip > 0 swings a leg to its left.
HOME = (0.0, 0.9, -1.8)


def legs(fl, fr, rl, rr):
    return np.array([*fl, *fr, *rl, *rr], dtype=float)


def stance(thigh):
    """Foot kept roughly under the hip: the Go2's thigh and calf are the same length, so calf = -2·thigh."""
    return (0.0, thigh, -2.0 * thigh)


# Named poses worth loading in the pane. Each gets settled under its servos before it becomes a keyframe.
POSES = {
    "home":       legs(HOME, HOME, HOME, HOME),
    "tall":       legs(*[stance(0.72)] * 4),
    "crouch":     legs(*[stance(1.12)] * 4),
    "play_bow":   legs(stance(1.20), stance(1.20), stance(0.75), stance(0.75)),   # chest down, tail up
    "lean_left":  legs(stance(0.98), stance(0.84), stance(0.98), stance(0.84)),   # left side low
    "lean_right": legs(stance(0.84), stance(0.98), stance(0.84), stance(0.98)),
    "wide":       legs((0.18, 0.95, -1.9), (-0.18, 0.95, -1.9), (0.18, 0.95, -1.9), (-0.18, 0.95, -1.9)),
}


def _servo_spec():
    spec = mujoco.MjSpec.from_file(str(SCENE))
    degree = math.pi / 180 if spec.compiler.degree else 1.0
    joint_range = {j.name: j.range * degree for j in spec.joints if j.type == mujoco.mjtJoint.mjJNT_HINGE}
    for act in spec.actuators:
        torque = act.ctrlrange.copy()
        act.set_to_position(kp=KP, kv=KV)
        act.ctrlrange = joint_range[act.target]
        act.forcerange = torque                      # the motor's torque rating still limits the servo
    # Sensors the pane can plot live.
    for name, kind in (("base_pos", mujoco.mjtSensor.mjSENS_FRAMEPOS),
                       ("base_quat", mujoco.mjtSensor.mjSENS_FRAMEQUAT)):
        s = spec.add_sensor(name=name, type=kind, objtype=mujoco.mjtObj.mjOBJ_SITE, objname="imu")
    spec.add_sensor(name="base_gyro", type=mujoco.mjtSensor.mjSENS_GYRO, objtype=mujoco.mjtObj.mjOBJ_SITE, objname="imu")
    for foot in ("FL", "FR", "RL", "RR"):
        spec.add_sensor(name=f"{foot}_foot_pos", type=mujoco.mjtSensor.mjSENS_FRAMEPOS,
                        objtype=mujoco.mjtObj.mjOBJ_GEOM, objname=foot)
    return spec


def _settle(model, ctrl, seconds=2.5):
    """Ease from 'home' into the pose over 1 s under the servos, hold, and keep the resting state."""
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    start = model.key_ctrl[0].copy()
    while data.time < seconds:
        a = min(data.time / 1.0, 1.0)
        data.ctrl[:] = start + (0.5 - 0.5 * math.cos(math.pi * a)) * (ctrl - start)
        mujoco.mj_step(model, data)
    data.qpos[0:2] = 0.0                             # centred at the origin
    data.qpos[3:7] /= np.linalg.norm(data.qpos[3:7])
    return data.qpos.copy()


def build():
    """Return (model, data) with the servo Go2, its named keyframes, and data reset to 'home'."""
    spec = _servo_spec()
    probe = _servo_spec().compile()
    settled = {name: _settle(probe, ctrl) for name, ctrl in POSES.items()}
    for key in list(spec.keys):
        spec.delete(key)
    for name, ctrl in POSES.items():
        spec.add_key(name=name, qpos=settled[name], ctrl=ctrl)
    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)
    return model, data
