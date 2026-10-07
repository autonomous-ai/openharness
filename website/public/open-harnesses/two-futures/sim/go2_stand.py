"""Go2 first rollout: position servos holding the 'home' pose for 3 s."""
from harness_mujoco import load_menagerie, record

model, data = load_menagerie("unitree_go2", servos=(60, 2))

def ctrl(model, data, t):
    data.ctrl[:] = model.key_ctrl[0]

record(model, data, ctrl, seconds=3, track="base", video=False)
