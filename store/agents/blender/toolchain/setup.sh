#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with `bpy` — Blender as a Python module, the
# whole of Blender minus its window — at the pinned version. The wheel is built for CPython 3.11 alone,
# so the venv is on 3.11 whatever this machine has: uv downloads that Python when it is not here.
# imageio-ffmpeg brings an ffmpeg for turntables, since bpy has no movie encoder of its own.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
VERSION="$(cat BPY_VERSION)"
case "$(uname -s)-$(uname -m)" in
  # Blender 5 dropped Intel Macs; 4.5 is the LTS that still ships them, and the toolchain's tests pass on it.
  Darwin-x86_64) VERSION="$(cat BPY_VERSION_INTEL_MAC)"; echo "     an Intel Mac: bpy ${VERSION} LTS, the newest Blender built for one" ;;
  Linux-aarch64 | Linux-arm64) echo "miss Blender publishes no bpy for Linux on ARM — this harness runs on a Mac or on x86-64 Linux"; exit 1 ;;
esac
harness_venv .venv 3.11 3.11 3.12 || exit 1
echo "     installing bpy ${VERSION} (Blender as a module, ~300 MB, a few minutes the first time)"
harness_pip .venv "bpy==${VERSION}" numpy imageio-ffmpeg
echo "ok   blender $(.venv/bin/python -c 'import bpy; print(bpy.app.version_string)')"
echo "     render check (Workbench, headless)"
.venv/bin/python - <<'PY'
import bpy, tempfile, os
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); bpy.context.scene.collection.objects.link(cam)
cam.location = (4, -4, 3); cam.rotation_euler = (1.1, 0, 0.78); bpy.context.scene.camera = cam
s = bpy.context.scene; s.render.engine = "BLENDER_WORKBENCH"; s.render.resolution_x = 64; s.render.resolution_y = 64
s.render.filepath = os.path.join(tempfile.gettempdir(), "harness-bpy-check.png"); bpy.ops.render.render(write_still=True)
print("ok   headless rendering works")
PY
