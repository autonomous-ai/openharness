#!/usr/bin/env bash
# Pod renders the same pixels here as in the Pod build it was ported from.
#
#   POD_SRC=/path/to/that/build's/firmware bash test/test_render_parity.sh
#
# POD_SRC is the firmware directory of the older tree (the one holding test/pod_render.py). Both sides render
# the same screens at --now 600 with the same font (the generator's default, the macOS system sans, is
# byte-identical to the old tree's baked atlases; PRO_FONT does not apply to the old tree, so this test needs
# that default). Every image must be byte-equal.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${POD_SRC:?set POD_SRC to the firmware directory of the older Pod build}"
[[ -f "$POD_SRC/test/pod_render.py" ]] || { echo "no test/pod_render.py under $POD_SRC" >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/old" "$work/new"
screens=(tabs tab:1 recent agent:fw recap:desk talk:fw talk:cur chrome:talk default default:tab default:talk)

# Fonts: the new tree generates its own; with PRO_FONT set the two sides cannot match, so refuse.
if [[ -n "${PRO_FONT:-}" ]]; then echo "PRO_FONT must be unset for the parity test" >&2; exit 2; fi

python3 "$POD_SRC/test/pod_render.py" "${screens[@]}" --now 600 >/dev/null
for s in "${screens[@]}"; do cp "$POD_SRC/test/out/pod/${s//:/-}.png" "$work/old/"; done
python3 "$here/pod_render.py" "${screens[@]}" --now 600 >/dev/null
for s in "${screens[@]}"; do cp "$here/out/pod/${s//:/-}.png" "$work/new/"; done

fail=0
for s in "${screens[@]}"; do
    n="${s//:/-}.png"
    if cmp -s "$work/old/$n" "$work/new/$n"; then echo "equal   $s"; else echo "DIFFER  $s"; fail=1; fi
done
[[ $fail -eq 0 ]] && echo "render parity: PASS" || { echo "render parity: FAIL"; exit 1; }
