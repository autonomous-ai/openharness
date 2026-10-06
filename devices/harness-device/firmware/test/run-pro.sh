#!/usr/bin/env bash
# Actual 720 px Pro interaction/render tests. The shared run.sh remains asset-independent.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
generated="$here/../../prototype/pro-companion/generated"
for asset in pro_fonts.c pro_art.h; do
    if [[ ! -f "$generated/$asset" ]]; then
        printf '%s\n' "Missing generated Pro asset: $asset" >&2
        printf '%s\n' 'From the repository root, run the documented generate_fonts.py and generate_daemons.py commands in devices/harness-device/prototype/pro-companion/README.md.' >&2
        exit 1
    fi
done
python3 "$here/test_pro_touch_ui.py"
python3 "$here/test_pro_controls.py"
python3 "$here/test_pro_app_interactions.py"
python3 "$here/test_pro_visit_identity.py"
python3 "$here/test_pro_notice_merge.py"
python3 "$here/test_pro_input_readiness.py"
python3 "$here/test_pro_reader.py"
python3 "$here/test_pro_carry_journey.py"
python3 "$here/test_pro_spoken_find.py"
