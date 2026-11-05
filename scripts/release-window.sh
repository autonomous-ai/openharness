# Sourced by the release scripts (backend, CLI, Desktop, web). Bash 3.2-compatible.
#
# release_window_guard KIND runs scripts/release-window.py first, so a release outside the window or too
# soon after the last one is refused before anything is tagged. A script sets URGENT_SET=1 and URGENT="<reason>"
# when its caller passed --urgent, and DRY_RUN=1 for a dry run (which only reports the verdict).
# On success URGENT_TAG_LINE holds the `Release-Urgent: <reason>` line the script puts in its tag's message, so the
# tag workflow honors the same override and the reason stays with the release.
URGENT_SET="${URGENT_SET:-0}"
URGENT="${URGENT:-}"
URGENT_TAG_LINE=""

release_window_guard() {
  local kind="$1" guard args
  guard="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-window.py"
  args=(--kind "$kind")
  if [ "$URGENT_SET" -eq 1 ]; then args+=(--urgent "$URGENT"); fi
  if [ "${DRY_RUN:-0}" -eq 1 ]; then args+=(--advisory); fi
  python3 "$guard" "${args[@]}" || return $?
  if [ "$URGENT_SET" -eq 1 ] && [ "${DRY_RUN:-0}" -ne 1 ]; then
    URGENT_TAG_LINE="Release-Urgent: $(printf '%s' "$URGENT" | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//')"
  fi
}
