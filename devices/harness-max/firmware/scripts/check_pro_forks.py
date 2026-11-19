#!/usr/bin/env python3
"""Do Harness Max's copies of the Pro's files still match the upstream they were copied from?

main/pro_fork/upstream.txt lists every Pro file the Max forks (main/pro_fork/<its path>, compiled in place of the Pro's)
or leans on as it is (a Max file that assumes its content): the Pro's file, its git blob when the Max took it, and the
Max's file. This hashes each Pro file as the working tree has it (git's blob hash, without git) and fails when one is no
longer the recorded blob. After a merge of main, that is a change to re-port into the Max's file (the line printed
shows it: git diff <base> -- <file>); then record the file's new blob, and the new base, in upstream.txt and in the Max
file's header.

    python3 scripts/check_pro_forks.py          exit 0 every file as recorded, 1 one changed or the record is not whole
    python3 scripts/check_pro_forks.py --warn   the same report, always exit 0 (test/run.sh prints it)
"""
import hashlib
import re
import sys
from pathlib import Path

FW = Path(__file__).resolve().parent.parent           # devices/harness-max/firmware
REPO = FW.parent.parent.parent
MANIFEST = FW / "main" / "pro_fork" / "upstream.txt"
MARK = {"fork": "pro_fork upstream:", "relies": "pro_fork relies on:"}


def blob(path):
    """git's blob id of a file: what `git hash-object <file>` prints."""
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def main(argv):
    warn = "--warn" in argv
    problems, drift = [], []
    base, rows = None, []
    for n, line in enumerate(MANIFEST.read_text().splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        words = line.split()
        if words[0] == "base" and len(words) == 2:
            base = words[1]
        elif len(words) == 4 and words[0] in MARK and re.fullmatch(r"[0-9a-f]{40}", words[2]):
            rows.append((n, *words))
        else:
            problems.append(f"upstream.txt:{n}: not <fork|relies> <file> <blob> <max file>, nor base <commit>")
    if not base:
        problems.append("upstream.txt: no base <commit> line")

    forks = set()
    for n, how, upstream, recorded, mine in rows:
        up, own = REPO / upstream, REPO / mine
        if not up.is_file():
            problems.append(f"upstream.txt:{n}: {upstream} is not a file")
            continue
        if not own.is_file():
            problems.append(f"upstream.txt:{n}: {mine} is not a file")
            continue
        if how == "fork":
            forks.add(own.resolve())
        # The Max file's header names the same upstream and blob, so neither can be updated without the other.
        header = f"{MARK[how]} {upstream}\n"
        text = own.read_text(errors="replace")
        at = text.find(header)
        if at < 0 or not text[at + len(header):].startswith(f"// pro_fork blob: {recorded} "):
            problems.append(f"{mine}: its header does not say '{MARK[how]} {upstream}' and then "
                            f"'pro_fork blob: {recorded}' (upstream.txt:{n})")
        now = blob(up)
        if now != recorded:
            drift.append(f"{upstream} changed since {base} (blob {recorded[:10]}, now {now[:10]}): re-port it into "
                         f"{mine}\n    git diff {base} -- {upstream}")

    # Every copy is on the list, and every Max file that says it copies or leans on a Pro file is too.
    listed = {(how, upstream, (REPO / mine).resolve()) for _, how, upstream, _, mine in rows}
    for path in sorted((FW / "main" / "pro_fork").rglob("*")):
        if path.is_file() and path != MANIFEST and path.resolve() not in forks:
            problems.append(f"{path.relative_to(REPO)}: in main/pro_fork/ but not a fork in upstream.txt")
    for path in sorted(p for d in ("main", "linux", "bench", "test") for p in (FW / d).rglob("*.[ch]")):
        for how, mark in MARK.items():
            for upstream in re.findall(rf"^// {re.escape(mark)} (\S+)$", path.read_text(errors="replace"), re.M):
                if (how, upstream, path.resolve()) not in listed:
                    problems.append(f"{path.relative_to(REPO)}: says '{mark} {upstream}' but upstream.txt has no such line")

    for p in problems:
        print(f"check_pro_forks: {p}", file=sys.stderr)
    for d in drift:
        print(f"check_pro_forks: {d}", file=sys.stderr)
    if problems or drift:
        if warn:
            print(f"check_pro_forks: {len(drift)} upstream file(s) changed, {len(problems)} record problem(s) "
                  "(a warning here: scripts/check_pro_forks.py fails on it)")
            return 0
        return 1
    print(f"check_pro_forks: {len(rows)} Pro files as at {base} "
          f"({sum(r[1] == 'fork' for r in rows)} forked, {sum(r[1] == 'relies' for r in rows)} relied on)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
