#!/usr/bin/env python3
"""Block new hard-coded styles in Swarm UI code; the design system's roles own them.

desktop/design/desktop-design-system.md names the roles (AppType, AppPalette,
AppDesktop/AppControl, AppIcons). This counts what bypasses them in each file:
a Color(0x…) literal, a Material Colors.<name> other than transparent, a
numeric fontSize, an EdgeInsets with a number in it, and a numeric
BorderRadius.circular. Theme folders own those numbers and are not scanned.

scripts/ui-style-allowlist/<area>.json holds the offenders that existed when an
area's check began, as counts per file and rule. A count above its allowance
fails; one below it fails too, until --update writes the smaller list. --against
fails when an allowlist records more than the same file on the base branch, so
the lists only shrink.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

# Each scanned folder and the allowlist file of its area.
ROOTS = {"desktop/lib/super_tabs": "desktop", "mobile/lib/swarm": "mobile"}
ALLOWLISTS = Path("scripts/ui-style-allowlist")
RULES = ("hex-color", "material-color", "font-size", "edge-insets", "border-radius")

NUMBER = r"\d+(?:\.\d+)?"
HEX_COLOR = re.compile(r"\bColor\(\s*0[xX]")
MATERIAL_COLOR = re.compile(r"\bColors\.(\w+)")
FONT_SIZE = re.compile(rf"\bfontSize\s*:\s*{NUMBER}")
EDGE_INSETS = re.compile(r"\bEdgeInsets(?:Directional)?\.\w+\(")
BORDER_RADIUS = re.compile(rf"\bBorderRadius\.circular\(\s*({NUMBER})")
ZERO = re.compile(r"0+(?:\.0+)?")


def code_only(text):
    """The source with comments and string contents blanked, newlines kept."""
    out, i, n = [], 0, len(text)

    def blank(chunk):
        out.append(re.sub(r"[^\n]", " ", chunk))

    while i < n:
        if text.startswith("//", i):
            end = text.find("\n", i)
            end = n if end < 0 else end
            blank(text[i:end])
            i = end
        elif text.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if text.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif text.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            blank(text[i:j])
            i = j
        elif text[i] in "'\"" or (text[i] == "r" and i + 1 < n and text[i + 1] in "'\""
                                  and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_"))):
            raw = text[i] == "r"
            start = i + 1 if raw else i
            quote = text[start:start + 3] if text[start:start + 3] in ("'''", '"""') else text[start]
            j = start + len(quote)
            while j < n and not text.startswith(quote, j):
                if text[j] == "\\" and not raw:
                    j += 1
                elif text[j] == "\n" and len(quote) == 1:
                    break
                j += 1
            j = min(n, j + len(quote))
            out.append(text[i:start + len(quote)])
            blank(text[start + len(quote):j - len(quote)])
            out.append(text[j - len(quote):j])
            i = j
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def call_arguments(code, open_paren):
    """The top-level argument values of the call whose '(' is at open_paren."""
    depth, start, args = 0, open_paren + 1, []
    for j in range(open_paren, len(code)):
        char = code[j]
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
            if depth == 0:
                args.append(code[start:j])
                break
        elif char == "," and depth == 1:
            args.append(code[start:j])
            start = j + 1
    values = []
    for arg in args:
        arg = arg.strip()
        if arg:
            name = re.match(r"\w+\s*:(?!:)", arg)
            values.append(arg[name.end():].strip() if name else arg)
    return values


def findings(text):
    """(line, rule) for each hard-coded style in a Dart source."""
    code = code_only(text)
    found = []

    def line(offset):
        return code.count("\n", 0, offset) + 1

    for match in HEX_COLOR.finditer(code):
        found.append((line(match.start()), "hex-color"))
    for match in MATERIAL_COLOR.finditer(code):
        if match.group(1) != "transparent":
            found.append((line(match.start()), "material-color"))
    for match in FONT_SIZE.finditer(code):
        found.append((line(match.start()), "font-size"))
    for match in EDGE_INSETS.finditer(code):
        values = call_arguments(code, match.end() - 1)
        if any(re.match(NUMBER, value) and not ZERO.fullmatch(value) for value in values):
            found.append((line(match.start()), "edge-insets"))
    for match in BORDER_RADIUS.finditer(code):
        rest = code[match.end():].lstrip()
        if rest.startswith((")", ",")) and ZERO.fullmatch(match.group(1)):
            continue
        found.append((line(match.start()), "border-radius"))
    return sorted(found)


def dart_files(root, roots):
    for name in roots:
        folder = root / name
        if folder.is_dir():
            for path in sorted(folder.rglob("*.dart")):
                relative = path.relative_to(root)
                if "theme" not in relative.relative_to(name).parts[:-1]:
                    yield relative.as_posix(), path


def scan(root, roots, lines=None):
    """{file: {rule: count}} for the Dart files under roots; files with none are omitted."""
    counts = {}
    for name, path in dart_files(Path(root), roots):
        found = findings(path.read_text(encoding="utf-8"))
        if lines is not None:
            lines.extend((name, number, rule) for number, rule in found)
        for _, rule in found:
            counts.setdefault(name, {}).setdefault(rule, 0)
            counts[name][rule] += 1
    return counts


def within(name, root):
    return name.startswith(root.rstrip("/") + "/")


def differences(counts, allowed):
    """(file, rule, count, allowance) wherever the two disagree."""
    out = []
    for name in sorted(set(counts) | set(allowed)):
        have, limit = counts.get(name, {}), allowed.get(name, {})
        for rule in RULES:
            if have.get(rule, 0) != limit.get(rule, 0):
                out.append((name, rule, have.get(rule, 0), limit.get(rule, 0)))
    return out


def allowlist_file(name):
    return ALLOWLISTS / f"{ROOTS[name]}.json"


def write_allowlist(path, counts):
    ordered = {name: {rule: counts[name][rule] for rule in RULES if counts[name].get(rule)}
               for name in sorted(counts)}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ordered, indent=2) + "\n")


def raised_since(root, ref):
    """(allowlist, file, rule, count, base count) where an allowlist records more than at ref."""
    raised = []
    for name in ROOTS:
        relative = allowlist_file(name)
        path = root / relative
        if not path.exists():
            continue
        shown = subprocess.run(["git", "show", f"{ref}:{relative.as_posix()}"], cwd=root,
                               capture_output=True, text=True)
        if shown.returncode != 0:
            # The area's first allowlist: today's offenders, recorded once.
            continue
        now, base = json.loads(path.read_text()), json.loads(shown.stdout)
        for file in sorted(now):
            for rule in RULES:
                count, before = now[file].get(rule, 0), base.get(file, {}).get(rule, 0)
                if count > before:
                    raised.append((relative.as_posix(), file, rule, count, before))
    return raised


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="repository root")
    parser.add_argument("--only", action="append", choices=list(ROOTS), help="check only this folder (repeatable)")
    parser.add_argument("--update", action="store_true", help="shrink the allowlists to today's counts; never raises one")
    parser.add_argument("--init", action="store_true", help="write a folder's first allowlist from today's offenders")
    parser.add_argument("--against", metavar="REF", help="fail if an allowlist records more than at this base revision")
    args = parser.parse_args(argv)

    if args.against:
        raised = raised_since(args.root, args.against)
        if raised:
            print(f"An allowlist grew since {args.against}; fix the call sites instead:", file=sys.stderr)
            for allowlist, file, rule, count, before in raised:
                print(f"  {allowlist}: {file}: {rule} {count}, base {before}", file=sys.stderr)
            return 1
        return 0

    # A folder this branch does not have is not checked; its area's list waits for it.
    roots = [name for name in args.only or ROOTS if (args.root / name).is_dir()]
    lines = []
    counts = scan(args.root, roots, lines)

    if args.init:
        for name in roots:
            path = args.root / allowlist_file(name)
            if path.exists():
                print(f"{allowlist_file(name)} already exists; use --update to shrink it", file=sys.stderr)
                return 1
            mine = {file: rules for file, rules in counts.items() if within(file, name)}
            write_allowlist(path, mine)
            print(f"wrote {allowlist_file(name)}: {sum(sum(c.values()) for c in mine.values())} offenders "
                  f"in {len(mine)} files")
        return 0

    allowed = {}
    for name in roots:
        path = args.root / allowlist_file(name)
        if not path.exists():
            print(f"{allowlist_file(name)} is missing; create it once with "
                  f"scripts/check-ui-style.py --init --only {name}", file=sys.stderr)
            return 1
        allowed.update({file: rules for file, rules in json.loads(path.read_text()).items() if within(file, name)})

    diffs = differences(counts, allowed)
    grown = [diff for diff in diffs if diff[2] > diff[3]]
    shrunk = [diff for diff in diffs if diff[2] < diff[3]]
    if grown:
        over = {(name, rule) for name, rule, _, _ in grown}
        print("Hard-coded styles in Swarm UI code. Use the design system's roles "
              "(desktop/design/desktop-design-system.md) instead:", file=sys.stderr)
        for name, number, rule in lines:
            if (name, rule) in over:
                print(f"  {name}:{number}: {rule}", file=sys.stderr)
        for name, rule, have, limit in grown:
            print(f"  {name}: {rule} {have}, allowed {limit}", file=sys.stderr)
        if args.update:
            print("--update never raises an allowance; nothing was written.", file=sys.stderr)
        return 1
    if shrunk and args.update:
        for name in roots:
            write_allowlist(args.root / allowlist_file(name),
                            {file: rules for file, rules in counts.items() if within(file, name)})
        print("shrank: " + ", ".join(f"{name} {rule} {limit}→{have}" for name, rule, have, limit in shrunk))
        return 0
    if shrunk:
        print("Fewer hard-coded styles than the allowlist records. Shrink it with "
              "python3 scripts/check-ui-style.py --update and commit the result:", file=sys.stderr)
        for name, rule, have, limit in shrunk:
            print(f"  {name}: {rule} {have}, allowed {limit}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
