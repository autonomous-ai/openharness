#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with the pinned MuJoCo and the pieces that
# turn a simulation into a video; the MuJoCo Menagerie robots the skill names, at a pinned commit,
# sparsely (their meshes are most of the repository). Training extras are a second script.
# MuJoCo has wheels for 3.10 on, the training extras (MuJoCo Playground) want 3.11+: the venv is on
# 3.12 whatever this machine has (uv downloads it when it is not here); one already on 3.11–3.14 is kept.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./VERSIONS
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
# MuJoCo publishes no Intel Mac wheel since 3.10.0: say so before downloading anything, not in a resolver error.
if [ "$(uname -s)-$(uname -m)" = Darwin-x86_64 ]; then echo "miss mujoco ${MUJOCO} has no Intel Mac build — this harness needs an Apple Silicon Mac, or Linux"; exit 1; fi
harness_venv .venv 3.12 3.11 3.15 || exit 1
echo "     installing mujoco ${MUJOCO}"
harness_pip .venv "mujoco==${MUJOCO}" numpy "imageio[ffmpeg]"
echo "ok   mujoco $(.venv/bin/python -c 'import mujoco; print(mujoco.__version__)')"
if [ ! -f menagerie/.harness-commit ] || [ "$(cat menagerie/.harness-commit)" != "${MENAGERIE_COMMIT}" ]; then
  echo "     fetching MuJoCo Menagerie @ ${MENAGERIE_COMMIT} (${MENAGERIE_ROBOTS})"
  rm -rf menagerie; mkdir menagerie; cd menagerie
  git init -q; git remote add origin https://github.com/google-deepmind/mujoco_menagerie.git
  git sparse-checkout init --cone >/dev/null; git sparse-checkout set ${MENAGERIE_ROBOTS} >/dev/null
  git fetch -q --depth 1 --filter=blob:none origin "${MENAGERIE_COMMIT}"
  git checkout -q FETCH_HEAD
  echo "${MENAGERIE_COMMIT}" > .harness-commit; cd ..
fi
for r in ${MENAGERIE_ROBOTS}; do [ -f "menagerie/$r/scene.xml" ] || { echo "miss menagerie/$r/scene.xml"; exit 1; }; done
echo "ok   menagerie: ${MENAGERIE_ROBOTS}"
echo "     rendering check"
.venv/bin/python - <<'PY'
import mujoco
m = mujoco.MjModel.from_xml_string('<mujoco><worldbody><light pos="0 0 3"/><geom type="sphere" size=".1"/></worldbody></mujoco>')
d = mujoco.MjData(m); r = mujoco.Renderer(m, 64, 64); mujoco.mj_forward(m, d); r.update_scene(d); r.render()
print("ok   offscreen rendering works")
PY
