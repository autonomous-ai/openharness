"""Go2 friendly body bob: stand, ease into a slow bob with a gentle side sway, ease out, stand.

Everything is joint-angle targets for the position servos in the model, so the pane re-simulates it
exactly and the robot keeps standing (and reacting to pushes) after the tape ends. Feet stay planted:
each leg keeps calf = -2·thigh, which holds the foot under its hip while the body rises and sinks.

    "$MUJOCO_PYTHON" sim/go2_bob.py            # → out/rollout.* (the pane picks it up)
"""
import math
import sys

import numpy as np

from go2_model import build, stance
from harness_mujoco import record

STAND_S, RAMP_S, BOB_S = 1.5, 1.5, 8.0    # stand, ease in, bob, ease out, stand
TOTAL_S = STAND_S + RAMP_S + BOB_S + RAMP_S + 1.5
BOB_HZ, BOB_AMP = 0.5, 0.12               # thigh swing (rad) about 0.9: base height ≈ ±3 cm
SWAY_HZ, SWAY_AMP = 0.25, 0.05            # left/right leg-height difference: a small friendly roll
NOD = 0.35                                # front legs lead the rear by this phase (rad): a slight nod


def envelope(t):
    """0 while standing, smooth 0→1 ramp, 1 while bobbing, smooth 1→0, 0 at the end."""
    def smooth(x):
        x = min(max(x, 0.0), 1.0)
        return 0.5 - 0.5 * math.cos(math.pi * x)
    t_in, t_out = STAND_S, STAND_S + RAMP_S + BOB_S
    return smooth((t - t_in) / RAMP_S) * (1.0 - smooth((t - t_out) / RAMP_S))


def targets(t):
    e = envelope(t)
    ph = 2 * math.pi * BOB_HZ * (t - STAND_S)
    sway = e * SWAY_AMP * math.sin(2 * math.pi * SWAY_HZ * (t - STAND_S))
    front = 0.9 + e * BOB_AMP * math.sin(ph + NOD)
    rear = 0.9 + e * BOB_AMP * math.sin(ph)
    # sway > 0 bends the left legs more (left side lower).
    return np.array([*stance(front + sway), *stance(front - sway),
                     *stance(rear + sway), *stance(rear - sway)])


def controller(model, data, t):
    data.ctrl[:] = targets(t)


if __name__ == "__main__":
    model, data = build()
    feet = [model.geom(n).id for n in ("FL", "FR", "RL", "RR")]
    start_base = data.qpos[:3].copy()
    start_feet = data.geom_xpos[feet, :2].copy()
    report = record(model, data, controller, seconds=TOTAL_S, track="base", video="--video" in sys.argv)
    drift = np.linalg.norm(data.qpos[:2] - start_base[:2])
    slip = np.linalg.norm(data.geom_xpos[feet, :2] - start_feet, axis=1)
    print(f"base drift {drift * 100:.1f} cm · foot slip max {slip.max() * 100:.1f} cm · "
          f"height {data.qpos[2]:.3f} m · nan {report['nan']}")
