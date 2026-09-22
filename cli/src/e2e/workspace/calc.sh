#!/bin/sh
# e2e calc tool — the "tool the user already has in their folder". Usage: tools/calc.sh add|sub A B
# Every call is logged next to it (`.e2e/calc-tool.log`) so the e2e can prove the tool was used.
op="$1"; a="$2"; b="$3"
case "$op" in
  add) r=$((a + b)) ;;
  sub) r=$((a - b)) ;;
  *) echo "usage: calc.sh add|sub A B" >&2; exit 2 ;;
esac
dir=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$dir/.e2e"
printf '%s %s %s %s = %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$op" "$a" "$b" "$r" >> "$dir/.e2e/calc-tool.log"
echo "$r"
