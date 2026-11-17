#!/usr/bin/env bash
# Re-export every screen of the Dial and the Pro, and the Harness Max draft, with the firmware's own C renderers.
#   bash export.sh                         defaults below
#   REF=<commit> MAX_REF=<branch> bash export.sh
# Needs: cc, python3 with Pillow. Sources are taken with git archive, so the working tree is never built in; only this
# folder (OUT) is rewritten.
set -euo pipefail
REPO=${REPO:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}   # the repo this folder is in
REF=${REF:-main}                       # Dial and Pro
MAX_REF=${MAX_REF:-feat/harness-max-all}   # empty to skip the Max draft
OUT=${OUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tools"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src" "$tmp/raw/dial" "$tmp/raw/question" "$tmp/raw/anim" "$tmp/png/dial" "$tmp/png/pro" "$tmp/png/max" "$tmp/png/anim"

git -C "$REPO" archive "$REF" devices/harness-device devices/harness-pro cli/src/cable cli/src/services/devices.ts | tar -x -C "$tmp/src"
main_sha=$(git -C "$REPO" rev-parse --short "$REF")

# Dial: the touch and question UI tests render every scene they check when HABITAT_PREVIEW_DIR is set.
dial="$tmp/src/devices/harness-device/firmware/test"
HABITAT_PREVIEW_DIR="$tmp/raw/dial" python3 "$dial/test_touch_ui.py" >/dev/null
HABITAT_PREVIEW_DIR="$tmp/raw/question" python3 "$dial/test_question_ui.py" >/dev/null

# Pro: every screen of the golden list plus the variants pod_render also knows, at one instant.
pro="$tmp/src/devices/harness-pro/firmware"
screens=$(sed -n '/^screens=(/,/^ inbox/p' "$pro/test/golden.sh" | sed 's/screens=(//; s/)$//')
python3 "$pro/test/pod_render.py" $screens tabs:working:codex agent:fw:ask agent:web:ask agent:fw:scroll agent:fw:notice \
    agent:fw:updated agent:fw:failed notice:updated notice:failed --now 1234 >/dev/null
cp "$pro"/test/out/pod/*.png "$tmp/png/pro/"
for s in agent:fw talk:fw tabs:working agent:cli; do
    for i in $(seq 0 39); do "$pro/test/out/pod/pod_render" "$s" "$tmp/raw/anim/pro-${s//:/-}-$(printf %03d "$i").ppm" $((1000 + i * 100)) >/dev/null; done
done

# Max draft.
max_sha=-
if [[ -n "$MAX_REF" ]]; then
    mkdir -p "$tmp/src-max"
    git -C "$REPO" archive "$MAX_REF" devices/harness-max devices/harness-pro | tar -x -C "$tmp/src-max"
    python3 "$tmp/src-max/devices/harness-max/firmware/test/max_render.py" --out "$tmp/raw/max" >/dev/null
    cp "$tmp"/raw/max/*.png "$tmp/png/max/"
    max_sha=$(git -C "$REPO" rev-parse --short "$MAX_REF")
fi

python3 - "$tmp" <<'PY'
import glob, os, sys
from PIL import Image
t = sys.argv[1]
for p in glob.glob(f'{t}/raw/dial/*.ppm'):
    Image.open(p).save(f'{t}/png/dial/{os.path.basename(p)[:-4]}.png')
for p in glob.glob(f'{t}/raw/question/*.ppm'):
    n = os.path.basename(p)[:-4]
    Image.open(p).save(f'{t}/png/dial/{n if n.startswith("question") else "question-" + n}.png')
def anim(frames, out, ms):
    ims = [Image.open(f).convert('RGB') for f in sorted(frames)]
    ims[0].save(out, save_all=True, append_images=ims[1:], duration=ms, loop=0, quality=80, method=4)
for s in ('agent-fw', 'talk-fw', 'tabs-working', 'agent-cli'):
    anim(glob.glob(f'{t}/raw/anim/pro-{s}-*.ppm'), f'{t}/png/anim/pro-{s}.webp', 100)
anim(glob.glob(f'{t}/png/dial/listening-live-*.png'), f'{t}/png/anim/dial-listening-live.webp', 80)
PY

printf '{"main":"%s","max":"%s","date":"%s"}\n' "$main_sha" "$max_sha" "$(date +%d/%m/%Y)" > "$tmp/meta.json"
python3 "$tools/build.py" "$tmp/png" "$OUT" "$tmp/meta.json"
